use std::path::{Path, PathBuf};

use super::api::Api;
use super::config::TelegramConfig;
use super::voice::{expand_home, find_program, run};
use crate::platform_command;

// Spoken answers with Piper on this computer: the prose of an answer becomes
// a WAV, ffmpeg turns it into the Ogg/Opus Telegram plays as a voice note.
// Code blocks and terminal output stay in the text answer, which is always
// sent too.

pub const VOICE_REPLY_MODES: &[&str] = &["off", "reply", "always"];
const MAX_SPOKEN_CHARS: usize = 1200;
const VOICE_DIR: &str = ".local/share/piper";
const SYNTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq)]
pub struct Speaker {
    pub piper: PathBuf,
    pub ffmpeg: PathBuf,
    pub voice: PathBuf,
}

impl Speaker {
    pub fn summary(&self) -> String {
        format!(
            "{} with {}",
            self.piper.display(),
            self.voice
                .file_stem()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        )
    }
}

/// The voice in settings, or a Piper `.onnx` in ~/.local/share/piper,
/// preferring one for the voice note language.
fn find_voice(configured: &str, language: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    if !configured.is_empty() {
        let path = expand_home(configured, home);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("the Piper voice {} does not exist", path.display()))
        };
    }
    let dir = home
        .map(|home| home.join(VOICE_DIR))
        .ok_or("no home directory to look for a Piper voice in")?;
    let mut voices: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|_| format!("no Piper voice found in {}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "onnx"))
        .collect();
    voices.sort();
    let prefix = format!("{language}_");
    let preferred = voices.iter().position(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix))
    });
    match preferred {
        Some(index) => Ok(voices.swap_remove(index)),
        None => voices
            .into_iter()
            .next()
            .ok_or_else(|| format!("no .onnx Piper voice in {}", dir.display())),
    }
}

pub fn locate(config: &TelegramConfig) -> Result<Speaker, String> {
    let home = platform_command::user_home_dir();
    let home = home.as_deref();
    Ok(Speaker {
        piper: find_program("piper", home)
            .ok_or("piper is not installed (uv tool install piper-tts)")?,
        ffmpeg: find_program("ffmpeg", home).ok_or("ffmpeg is not installed")?,
        voice: find_voice(config.piper_voice.trim(), &config.voice_language, home)?,
    })
}

pub fn wants_voice(mode: &str, spoken: bool) -> bool {
    mode == "always" || (mode == "reply" && spoken)
}

/// The part of a Markdown answer worth hearing: prose without code blocks,
/// links or formatting marks, cut at a sentence near the limit.
pub fn spoken_text(markdown: &str) -> Option<String> {
    let mut prose = Vec::new();
    let mut in_code = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if !in_code {
            prose.push(line);
        }
    }
    let mut text = String::new();
    for word in prose.join(" ").split_whitespace() {
        if word.starts_with("http://") || word.starts_with("https://") {
            continue;
        }
        let word: String = word
            .chars()
            .filter(|c| !matches!(c, '`' | '*' | '_' | '#' | '>' | '|'))
            .collect();
        if word.is_empty() || word == "-" {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&word);
    }
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_SPOKEN_CHARS {
        return Some(text);
    }
    let cut: String = text.chars().take(MAX_SPOKEN_CHARS).collect();
    let end = cut
        .rfind(['.', '!', '?'])
        .map(|index| index + 1)
        .filter(|index| *index > MAX_SPOKEN_CHARS / 2)
        .or_else(|| cut.rfind(' '))
        .unwrap_or(cut.len());
    Some(cut[..end].trim().to_string())
}

/// ffmpeg's `atempo` for a speed in percent: 90 plays 10% slower without
/// changing the pitch. Piper's own `--length-scale` leaves the pauses alone,
/// so its effect on the length varies with the voice and the text.
pub fn tempo_filter(speed_percent: u32) -> String {
    format!("atempo={:.2}", f64::from(speed_percent) / 100.0)
}

pub async fn synthesize(
    speaker: &Speaker,
    text: &str,
    speed_percent: u32,
) -> Result<Vec<u8>, String> {
    let dir = tempfile::tempdir().map_err(|e| format!("temp dir: {e}"))?;
    let input = dir.path().join("answer.txt");
    let wav = dir.path().join("answer.wav");
    let ogg = dir.path().join("answer.ogg");
    std::fs::write(&input, text).map_err(|e| format!("save the text: {e}"))?;
    let voice = speaker.voice.to_string_lossy();
    let tempo = tempo_filter(speed_percent);
    let (input, wav, ogg_arg) = (
        input.to_string_lossy(),
        wav.to_string_lossy(),
        ogg.to_string_lossy(),
    );
    run(
        &speaker.piper,
        &["-m", &voice, "-i", &input, "-f", &wav],
        SYNTH_TIMEOUT,
    )
    .await?;
    run(
        &speaker.ffmpeg,
        &[
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &wav,
            "-af",
            &tempo,
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            &ogg_arg,
        ],
        SYNTH_TIMEOUT,
    )
    .await?;
    std::fs::read(&ogg).map_err(|e| format!("read the voice note: {e}"))
}

/// Sends the answer as a voice note, ahead of its text. Failures only cost the
/// voice note, so they are reported briefly.
pub async fn speak_answer(api: &Api, chat_id: i64, config: &TelegramConfig, answer: &str) {
    let Some(text) = spoken_text(answer) else {
        return;
    };
    let result = async {
        let speaker = locate(config)?;
        let audio = synthesize(&speaker, &text, config.voice_speed).await?;
        api.send_voice(chat_id, audio)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    if let Err(error) = result {
        let _ = api
            .send_message(chat_id, &format!("No voice note: {error}"))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaks_the_prose_only() {
        let answer = "**Listo**, corrí `git status`:\n```\nOn branch main\n```\nNo hay cambios. Ver https://example.com\n- uno\n- dos";
        assert_eq!(
            spoken_text(answer).unwrap(),
            "Listo, corrí git status: No hay cambios. Ver uno dos"
        );
        assert_eq!(spoken_text("```\nls\n```"), None);
    }

    #[test]
    fn long_answers_stop_at_a_sentence() {
        let answer = "Una frase corta. ".repeat(200);
        let spoken = spoken_text(&answer).unwrap();
        assert!(spoken.chars().count() <= MAX_SPOKEN_CHARS);
        assert!(spoken.ends_with("corta."));
    }

    #[test]
    fn speed_becomes_an_ffmpeg_tempo() {
        assert_eq!(tempo_filter(90), "atempo=0.90");
        assert_eq!(tempo_filter(100), "atempo=1.00");
        assert_eq!(tempo_filter(125), "atempo=1.25");
    }

    #[test]
    fn voice_mode_decides_when_to_speak() {
        assert!(!wants_voice("off", true));
        assert!(wants_voice("reply", true));
        assert!(!wants_voice("reply", false));
        assert!(wants_voice("always", false));
    }

    #[test]
    fn prefers_a_voice_in_the_chosen_language() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(VOICE_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "en_US-lessac-medium.onnx",
            "en_US-lessac-medium.onnx.json",
            "es_MX-claude-high.onnx",
        ] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let pick = |language| find_voice("", language, Some(home.path())).unwrap();
        assert_eq!(pick("es"), dir.join("es_MX-claude-high.onnx"));
        assert_eq!(pick("auto"), dir.join("en_US-lessac-medium.onnx"));
        assert!(find_voice("/nope.onnx", "es", Some(home.path())).is_err());
        assert_eq!(
            find_voice(
                "~/.local/share/piper/es_MX-claude-high.onnx",
                "en",
                Some(home.path())
            )
            .unwrap(),
            dir.join("es_MX-claude-high.onnx")
        );
    }
}
