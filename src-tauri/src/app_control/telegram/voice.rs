use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use super::api::Message;
use super::bot::{reply, Ctx};
use super::config::TelegramConfig;
use super::queue::with_typing;
use crate::app_control::child::{self, Limit};
use crate::platform_command;

// Voice notes become text with whisper.cpp on this computer: ffmpeg turns
// Telegram's Ogg/Opus into the 16 kHz WAV whisper-cli reads, and the
// transcript then goes through the bot like a typed message. The audio never
// leaves the machine.

pub const MAX_VOICE_SECS: u64 = 300;
const MAX_VOICE_BYTES: u64 = 20 * 1024 * 1024;
const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);
const MODEL_DIR: &str = ".local/share/whisper";
const OUTPUT_KEPT: Limit = Limit::tail(1024 * 1024);

#[derive(Debug, Clone, PartialEq)]
pub struct Whisper {
    pub cli: PathBuf,
    pub ffmpeg: PathBuf,
    pub model: PathBuf,
}

impl Whisper {
    pub fn summary(&self) -> String {
        format!(
            "{} with {}",
            self.cli.display(),
            self.model
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        )
    }
}

/// A path from settings, with a leading `~` meaning the home directory.
pub(super) fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix("~/").or(path.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if path == "~" => home.map(Path::to_path_buf).unwrap_or_default(),
        _ => PathBuf::from(path),
    }
}

pub(crate) fn find_program(name: &str, home: Option<&Path>) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    platform_command::find_in_path(&file).or_else(|| {
        let extra = [
            home.map(|home| home.join(".local/bin")),
            Some(PathBuf::from("/usr/local/bin")),
            Some(PathBuf::from("/opt/homebrew/bin")),
        ];
        extra
            .into_iter()
            .flatten()
            .map(|dir| dir.join(&file))
            .find(|path| path.is_file())
    })
}

/// The model in settings, or the first `ggml-*.bin` in ~/.local/share/whisper.
fn find_model(configured: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    if !configured.is_empty() {
        let path = expand_home(configured, home);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "the whisper model {} does not exist",
                path.display()
            ))
        };
    }
    let dir = home
        .map(|home| home.join(MODEL_DIR))
        .ok_or("no home directory to look for a whisper model in")?;
    let mut models: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|_| format!("no whisper model found in {}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("ggml-") && name.ends_with(".bin"))
        })
        .collect();
    models.sort();
    models
        .into_iter()
        .next()
        .ok_or_else(|| format!("no ggml-*.bin whisper model in {}", dir.display()))
}

pub fn locate(config: &TelegramConfig) -> Result<Whisper, String> {
    let home = platform_command::user_home_dir();
    let home = home.as_deref();
    Ok(Whisper {
        cli: find_program("whisper-cli", home).ok_or(
            "whisper-cli is not installed (build it from github.com/ggml-org/whisper.cpp)",
        )?,
        ffmpeg: find_program("ffmpeg", home).ok_or("ffmpeg is not installed")?,
        model: find_model(config.whisper_model.trim(), home)?,
    })
}

pub(super) async fn run(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let name = program
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut command = platform_command::tokio_command(program)?;
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = child::spawn(&mut command)
        .map_err(|e| format!("could not start {name}: {e}"))?
        .wait(timeout, OUTPUT_KEPT, OUTPUT_KEPT)
        .await
        .map_err(|e| format!("{name} failed: {e}"))?;
    let Some(status) = output.status else {
        return Err(format!("{name} timed out after {}s", timeout.as_secs()));
    };
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr.bytes);
        let last = stderr.lines().rev().find(|line| !line.trim().is_empty());
        return Err(format!(
            "{name} exited with {status}: {}",
            last.unwrap_or("").trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout.bytes).into_owned())
}

/// whisper-cli prints one segment per line and marks silence and noises in
/// brackets.
pub fn clean_transcript(stdout: &str) -> String {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !(line.starts_with('[') && line.ends_with(']')))
        .filter(|line| !(line.starts_with('(') && line.ends_with(')')))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `hint` primes whisper with words it should spell right, like names.
pub async fn transcribe(
    whisper: &Whisper,
    language: &str,
    hint: &str,
    audio: &[u8],
) -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|e| format!("temp dir: {e}"))?;
    let input = dir.path().join("voice.ogg");
    let wav = dir.path().join("voice.wav");
    std::fs::write(&input, audio).map_err(|e| format!("save the voice note: {e}"))?;
    let input = input.to_string_lossy();
    let wav = wav.to_string_lossy();
    run(
        &whisper.ffmpeg,
        &[
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &input,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &wav,
        ],
        CONVERT_TIMEOUT,
    )
    .await?;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .to_string();
    let model = whisper.model.to_string_lossy();
    let mut args = vec![
        "-m", &model, "-l", language, "-t", &threads, "-nt", "-np", "-f", &wav,
    ];
    if !hint.is_empty() {
        args.extend(["--prompt", hint]);
    }
    let stdout = run(&whisper.cli, &args, TRANSCRIBE_TIMEOUT).await?;
    let text = clean_transcript(&stdout);
    if text.is_empty() {
        return Err("could not hear any words".to_string());
    }
    Ok(text)
}

/// The bot's name, the user's names and polakapi, so a transcript spells them
/// as the settings do.
pub fn names_hint(config: &TelegramConfig) -> String {
    let mut names = vec![config.bot_name.clone()];
    names.extend(config.address_as.iter().cloned());
    names.push("polakapi".to_string());
    names.retain(|name| !name.is_empty());
    names.join(", ")
}

/// The text of a message, typed or transcribed from a voice note, and
/// whether it was spoken. `None` when there is nothing to act on; the chat
/// has been told why.
pub(super) async fn message_text(
    ctx: &Ctx,
    config: &TelegramConfig,
    message: &Message,
) -> Option<(String, bool)> {
    let chat_id = message.chat.id;
    if let Some(text) = message.text.as_deref().map(str::trim) {
        if !text.is_empty() {
            return Some((text.to_string(), false));
        }
    }
    let Some(note) = message.voice.as_ref().or(message.audio.as_ref()) else {
        reply(ctx, chat_id, "Only text and voice messages are supported.").await;
        return None;
    };
    if !config.voice_notes {
        reply(
            ctx,
            chat_id,
            "Voice notes are off. Turn them on in polakapi Settings → Telegram.",
        )
        .await;
        return None;
    }
    if note.duration > MAX_VOICE_SECS || note.file_size.unwrap_or(0) > MAX_VOICE_BYTES {
        let limit = MAX_VOICE_SECS / 60;
        reply(
            ctx,
            chat_id,
            &format!("That voice note is too long. Keep it under {limit} minutes."),
        )
        .await;
        return None;
    }
    let result = with_typing(ctx, chat_id, async {
        let whisper = locate(config)?;
        let audio = ctx
            .api
            .download(&note.file_id)
            .await
            .map_err(|e| format!("could not download the voice note: {e}"))?;
        transcribe(
            &whisper,
            &config.voice_language,
            &names_hint(config),
            &audio,
        )
        .await
    })
    .await;
    match result {
        Ok(text) => {
            reply(ctx, chat_id, &format!("🎤 {text}")).await;
            Some((text, true))
        }
        Err(error) => {
            reply(ctx, chat_id, &format!("Could not transcribe it: {error}")).await;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_lists_the_names_to_spell_right() {
        let config = TelegramConfig {
            bot_name: "Suryami".into(),
            address_as: vec!["M.".into()],
            ..TelegramConfig::default()
        };
        assert_eq!(names_hint(&config), "Suryami, M., polakapi");
        assert_eq!(names_hint(&TelegramConfig::default()), "polakapi");
    }

    #[test]
    fn transcript_drops_noise_markers() {
        assert_eq!(
            clean_transcript(
                "\n [BLANK_AUDIO]\n Dile a polakapi\n que corra git status.\n (music)\n"
            ),
            "Dile a polakapi que corra git status."
        );
        assert_eq!(clean_transcript("[BLANK_AUDIO]\n"), "");
    }

    #[test]
    fn finds_the_configured_or_installed_model() {
        let home = tempfile::tempdir().unwrap();
        assert!(find_model("", Some(home.path())).is_err());
        let dir = home.path().join(MODEL_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("ggml-small.bin"), "").unwrap();
        assert_eq!(
            find_model("", Some(home.path())).unwrap(),
            dir.join("ggml-small.bin")
        );
        let custom = home.path().join("model.bin");
        assert!(find_model(&custom.to_string_lossy(), Some(home.path())).is_err());
        std::fs::write(&custom, "").unwrap();
        assert_eq!(
            find_model(&custom.to_string_lossy(), Some(home.path())).unwrap(),
            custom
        );
        assert_eq!(
            find_model("~/model.bin", Some(home.path())).unwrap(),
            custom
        );
    }
}
