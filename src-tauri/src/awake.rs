use parking_lot::Mutex;
use tauri::State;

#[derive(Default)]
pub struct AwakeState {
    guard: Mutex<Option<keepawake::KeepAwake>>,
}

#[tauri::command]
pub fn keep_awake_set(state: State<'_, AwakeState>, enabled: bool) -> Result<bool, String> {
    let mut guard = state.guard.lock();
    if !enabled {
        *guard = None;
        return Ok(false);
    }
    if guard.is_some() {
        return Ok(true);
    }
    let awake = keepawake::Builder::default()
        .idle(true)
        .sleep(true)
        .reason("AI agents running in terminals")
        .app_name("polakapi")
        .app_reverse_domain("com.rafaelje.polakapi")
        .create()
        .map_err(|e| e.to_string())?;
    *guard = Some(awake);
    Ok(true)
}
