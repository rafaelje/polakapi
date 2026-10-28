//! Voice control from the agent tab: the microphone is recorded with ffmpeg,
//! transcribed with whisper.cpp and either answered by a headless operator
//! turn or typed into the agent tab's CLI. Answers can be read aloud with
//! Piper. Models, language, voice and speed are the Telegram bot's.
//!
//! - `reply`: waits for the agent tab's answer in the CLI's transcript.

mod reply;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::oneshot;

use super::child::{self, Limit, Running};
use super::home;
use super::server::ControlServer;
use super::telegram::bot::TelegramService;
use super::telegram::config::{TelegramConfig, HEADLESS_CLIS};
use super::telegram::queue::{looks_like_lost_session, Voice, RULES_HEADER};
use super::telegram::{speech, turn, voice};
use crate::platform_command;

/// ffmpeg stops on its own after this, in case the stop never comes.
const MAX_RECORDING_SECS: u32 = 300;
const MIN_RECORDING: Duration = Duration::from_millis(500);
/// Long enough for ffmpeg to fail on a missing device before we say we listen.
const START_CHECK: Duration = Duration::from_millis(400);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const PLAY_TIMEOUT: Duration = Duration::from_secs(600);
const LIST_DEVICES_TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_KEPT: Limit = Limit::tail(16 * 1024);
const CANCELLED: &str = "cancelled";
const SPOKEN_RULE: &str = "polakapi will read your answer aloud on this computer. Keep it short and natural to hear: plain sentences, no lists or symbols in the prose. Code and command output stay in ``` fences; they are shown, not read.";

struct Recording {
    running: Running,
    stdin: Option<ChildStdin>,
    _dir: tempfile::TempDir,
    path: PathBuf,
    started: Instant,
}

#[derive(Default)]
pub struct VoiceControl {
    recording: Mutex<Option<Recording>>,
    /// Stops whatever transcribes, thinks or speaks right now.
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    /// The headless conversation, resumed on the next dictation.
    session: Mutex<Option<(String, String)>>,
    watch: Mutex<Option<reply::Watch>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl VoiceControl {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    async fn cancellable<T>(
        &self,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        *lock(&self.cancel) = Some(tx);
        tokio::select! {
            out = work => out,
            _ = rx => Err(CANCELLED.to_string()),
        }
    }

    pub fn cancel(&self) {
        lock(&self.recording).take();
        lock(&self.watch).take();
        if let Some(cancel) = lock(&self.cancel).take() {
            let _ = cancel.send(());
        }
    }
}

fn enabled_config(app: &AppHandle) -> Result<TelegramConfig, String> {
    let service = app
        .try_state::<Arc<TelegramService>>()
        .ok_or("polakapi's voice settings could not be loaded")?;
    let config = service.config();
    if !config.voice_control {
        return Err("voice control is off. Turn it on in Settings → Voice control.".to_string());
    }
    Ok(config)
}

/// ffmpeg's input arguments for the microphone. Windows has no default
/// device name, so the first microphone ffmpeg lists is used.
async fn capture_args(device: &str, ffmpeg: &std::path::Path) -> Result<Vec<String>, String> {
    let device = device.trim();
    if cfg!(target_os = "macos") {
        let device = if device.is_empty() { ":0" } else { device };
        return Ok(vec![
            "-f".into(),
            "avfoundation".into(),
            "-i".into(),
            device.into(),
        ]);
    }
    if cfg!(windows) {
        let device = if device.is_empty() {
            list_dshow_devices(ffmpeg)
                .await
                .into_iter()
                .next()
                .ok_or("ffmpeg lists no microphone; set one in Settings → Voice control")?
        } else {
            device.to_string()
        };
        let device = if device.starts_with("audio=") {
            device
        } else {
            format!("audio={device}")
        };
        return Ok(vec!["-f".into(), "dshow".into(), "-i".into(), device]);
    }
    let _ = ffmpeg;
    let device = if device.is_empty() { "default" } else { device };
    Ok(vec![
        "-f".into(),
        "pulse".into(),
        "-i".into(),
        device.into(),
    ])
}

#[tauri::command]
pub async fn voice_record_start(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
) -> Result<(), String> {
    let config = enabled_config(&app)?;
    let whisper = voice::locate(&config)?;
    state.cancel();
    let dir = tempfile::tempdir().map_err(|e| format!("temp dir: {e}"))?;
    let path = dir.path().join("dictation.wav");
    let mut command = platform_command::tokio_command(&whisper.ffmpeg)?;
    command
        .args(["-hide_banner", "-loglevel", "error"])
        .args(capture_args(&config.voice_input, &whisper.ffmpeg).await?)
        .args(["-t", &MAX_RECORDING_SECS.to_string()])
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y"])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut running =
        child::spawn(&mut command).map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let stdin = running.stdin();
    state
        .cancellable(async {
            tokio::time::sleep(START_CHECK).await;
            Ok(())
        })
        .await?;
    if running.has_exited() {
        let output = running
            .wait(STOP_TIMEOUT, Limit::tail(0), STDERR_KEPT)
            .await
            .map_err(|e| format!("ffmpeg failed: {e}"))?;
        return Err(format!(
            "could not record the microphone: {}",
            last_line(&output.stderr.bytes)
        ));
    }
    *lock(&state.recording) = Some(Recording {
        running,
        stdin,
        _dir: dir,
        path,
        started: Instant::now(),
    });
    Ok(())
}

/// Stops the recording and returns what was said.
#[tauri::command]
pub async fn voice_record_stop(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
) -> Result<String, String> {
    let config = enabled_config(&app)?;
    let recording = lock(&state.recording)
        .take()
        .ok_or("nothing is being recorded")?;
    let Recording {
        running,
        stdin,
        _dir,
        path,
        started,
    } = recording;
    if let Some(mut stdin) = stdin {
        // `q` makes ffmpeg finish the file, header included.
        let _ = stdin.write_all(b"q").await;
    }
    let output = running
        .wait(STOP_TIMEOUT, Limit::tail(0), STDERR_KEPT)
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if output.status.is_none() {
        return Err("ffmpeg did not stop recording".to_string());
    }
    if started.elapsed() < MIN_RECORDING {
        return Err("that was too short. Hold the microphone a little longer.".to_string());
    }
    let audio = std::fs::read(&path).map_err(|_| {
        format!(
            "could not record the microphone: {}",
            last_line(&output.stderr.bytes)
        )
    })?;
    let whisper = voice::locate(&config)?;
    let hint = voice::names_hint(&config);
    let text = state
        .cancellable(voice::transcribe(
            &whisper,
            &config.voice_language,
            &hint,
            &audio,
        ))
        .await?;
    Ok(text)
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, Arc<VoiceControl>>) {
    state.cancel();
}

/// One headless operator turn for a dictation; resumes the last one.
#[tauri::command]
pub async fn voice_ask(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
    text: String,
    cli: Option<String>,
) -> Result<String, String> {
    let config = enabled_config(&app)?;
    let cli = cli
        .filter(|cli| HEADLESS_CLIS.contains(&cli.as_str()))
        .unwrap_or_else(|| config.cli.clone());
    let spoken = config.voice_control_replies == "reply";
    let (prompt, system) = build_turn(&cli, text.trim(), &config, spoken);
    let resume = lock(&state.session)
        .as_ref()
        .filter(|(session_cli, _)| *session_cli == cli)
        .map(|(_, id)| id.clone());
    let timeout = Duration::from_secs(config.turn_timeout_secs);
    let work = async {
        let first = attempt(
            &app,
            &cli,
            &prompt,
            resume.as_deref(),
            system.as_deref(),
            timeout,
        )
        .await;
        match first {
            Err(error) if resume.is_some() && looks_like_lost_session(&error) => {
                attempt(&app, &cli, &prompt, None, system.as_deref(), timeout).await
            }
            other => other,
        }
    };
    let output = state.cancellable(work).await?;
    if let Some(id) = output.session {
        *lock(&state.session) = Some((cli, id));
    }
    Ok(output.text)
}

/// Starts a fresh headless conversation on the next dictation.
#[tauri::command]
pub fn voice_forget(state: State<'_, Arc<VoiceControl>>) {
    lock(&state.session).take();
}

fn build_turn(
    cli: &str,
    text: &str,
    config: &TelegramConfig,
    spoken: bool,
) -> (String, Option<String>) {
    let persona = Voice {
        style: "",
        names: &config.address_as,
        bot_name: &config.bot_name,
        spoken_reply: false,
    };
    let mut rules: Vec<String> = persona.rules().into_iter().collect();
    if spoken {
        rules.push(SPOKEN_RULE.to_string());
    }
    let prompt = format!("[voice]\n{text}");
    if rules.is_empty() {
        return (prompt, None);
    }
    let rules = rules.join("\n\n");
    let prompt = format!("{RULES_HEADER}\n{rules}\n\n{prompt}");
    let system = (cli == "claude").then_some(rules);
    (prompt, system)
}

async fn attempt(
    app: &AppHandle,
    cli: &str,
    prompt: &str,
    resume: Option<&str>,
    system: Option<&str>,
    timeout: Duration,
) -> Result<turn::TurnOutput, String> {
    let server = app
        .try_state::<Arc<ControlServer>>()
        .ok_or_else(|| "the agent control server is not running".to_string())?;
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let control = server.control_file().to_string_lossy().into_owned();
    let spec = home::prepare_headless(
        &home::home_dir(app)?,
        &bin,
        &control,
        &home::HeadlessTurn {
            cli,
            profile: "full",
            resume,
            system,
            origin: None,
        },
    )?;
    turn::run(&spec, prompt, timeout).await
}

/// Remembers where the agent tab's CLI keeps its transcript, right before
/// the dictation is typed into it.
#[tauri::command]
pub fn voice_agent_mark(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
    cli: String,
) -> Result<(), String> {
    enabled_config(&app)?;
    let watch = reply::Watch::start(&cli, &home::home_dir(&app)?)?;
    *lock(&state.watch) = Some(watch);
    Ok(())
}

/// The agent tab's answer to `text`, once its turn ends.
#[tauri::command]
pub async fn voice_agent_reply(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
    text: String,
) -> Result<Option<String>, String> {
    let config = enabled_config(&app)?;
    let watch = lock(&state.watch)
        .take()
        .ok_or("the agent's transcript was not marked")?;
    let timeout = Duration::from_secs(config.turn_timeout_secs);
    state.cancellable(watch.reply(&text, timeout)).await
}

/// Reads the prose of an answer aloud. Resolves once it finished playing.
#[tauri::command]
pub async fn voice_speak(
    app: AppHandle,
    state: State<'_, Arc<VoiceControl>>,
    text: String,
) -> Result<(), String> {
    let config = enabled_config(&app)?;
    let Some(spoken) = speech::spoken_text(&text) else {
        return Ok(());
    };
    let speaker = speech::locate(&config)?;
    let player = player()?;
    let work = async {
        let audio = speech::synthesize(&speaker, &spoken, config.voice_speed).await?;
        let dir = tempfile::tempdir().map_err(|e| format!("temp dir: {e}"))?;
        let path = dir.path().join("answer.ogg");
        std::fs::write(&path, audio).map_err(|e| format!("save the answer: {e}"))?;
        let mut command = platform_command::tokio_command(&player)?;
        command
            .args(["-nodisp", "-autoexit", "-loglevel", "error"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let output = child::spawn(&mut command)
            .map_err(|e| format!("could not start ffplay: {e}"))?
            .wait(PLAY_TIMEOUT, Limit::tail(0), STDERR_KEPT)
            .await
            .map_err(|e| format!("ffplay failed: {e}"))?;
        match output.status {
            Some(status) if !status.success() => Err(format!(
                "ffplay exited with {status}: {}",
                last_line(&output.stderr.bytes)
            )),
            _ => Ok(()),
        }
    };
    state.cancellable(work).await
}

fn player() -> Result<PathBuf, String> {
    let home = platform_command::user_home_dir();
    voice::find_program("ffplay", home.as_deref())
        .ok_or_else(|| "ffplay is not installed (it comes with ffmpeg)".to_string())
}

/// What voice control would use, for the settings' Check button.
#[tauri::command]
pub async fn voice_control_check(
    service: State<'_, Arc<TelegramService>>,
) -> Result<String, String> {
    let config = service.config();
    let whisper = voice::locate(&config)?;
    let input = capture_args(&config.voice_input, &whisper.ffmpeg).await?;
    let mut found = format!("{} from {}", whisper.summary(), input[3]);
    if config.voice_control_replies != "off" {
        let speaker = speech::locate(&config)?;
        player()?;
        found = format!("{found}; answers with {}", speaker.summary());
    }
    Ok(found)
}

async fn list_dshow_devices(ffmpeg: &std::path::Path) -> Vec<String> {
    let Ok(mut command) = platform_command::tokio_command(ffmpeg) else {
        return Vec::new();
    };
    command
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let Ok(running) = child::spawn(&mut command) else {
        return Vec::new();
    };
    match running
        .wait(LIST_DEVICES_TIMEOUT, Limit::tail(0), Limit::tail(64 * 1024))
        .await
    {
        Ok(output) => dshow_audio_devices(&String::from_utf8_lossy(&output.stderr.bytes)),
        Err(_) => Vec::new(),
    }
}

/// The audio devices in ffmpeg's `-list_devices` output.
fn dshow_audio_devices(listing: &str) -> Vec<String> {
    listing
        .lines()
        .filter(|line| line.trim_end().ends_with("(audio)"))
        .filter_map(|line| {
            let start = line.find('"')? + 1;
            let end = start + line[start..].find('"')?;
            Some(line[start..end].to_string())
        })
        .collect()
}

fn last_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no details")
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictation_turns_carry_the_rules() {
        let config = TelegramConfig {
            bot_name: "Suryami".into(),
            ..TelegramConfig::default()
        };
        let (prompt, system) = build_turn("claude", "abre polakapi", &config, true);
        assert!(prompt.starts_with(RULES_HEADER));
        assert!(prompt.ends_with("[voice]\nabre polakapi"));
        let system = system.unwrap();
        assert!(system.contains("Suryami"));
        assert!(system.contains("read your answer aloud"));
        let (prompt, system) = build_turn("codex", "hola", &TelegramConfig::default(), false);
        assert_eq!(prompt, "[voice]\nhola");
        assert!(system.is_none());
    }

    #[test]
    fn finds_audio_devices_in_the_dshow_listing() {
        let listing = r#"[dshow @ 0001] "Integrated Camera" (video)
[dshow @ 0001]   Alternative name "@device_pnp_\\?\usb"
[dshow @ 0001] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 0001]   Alternative name "@device_cm_{33D9A762}"
dummy: Immediate exit requested"#;
        assert_eq!(
            dshow_audio_devices(listing),
            vec!["Microphone (Realtek(R) Audio)"]
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn records_the_default_pulse_source() {
        let ffmpeg = std::path::Path::new("ffmpeg");
        assert_eq!(
            capture_args("", ffmpeg).await.unwrap(),
            vec!["-f", "pulse", "-i", "default"]
        );
        assert_eq!(
            capture_args(" alsa_input.usb ", ffmpeg).await.unwrap()[3],
            "alsa_input.usb"
        );
    }
}
