use tauri::{
    menu::{Menu, MenuItem},
    Emitter, Manager,
};

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let settings = MenuItem::with_id(app, "app-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for updates...",
        true,
        None::<&str>,
    )?;
    #[cfg(target_os = "macos")]
    if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        submenu.insert_items(
            &[
                &settings,
                &updates,
                &tauri::menu::PredefinedMenuItem::separator(app)?,
            ],
            2,
        )?;
    }
    #[cfg(not(target_os = "macos"))]
    menu.prepend(&tauri::menu::Submenu::with_items(
        app,
        "polakapi",
        true,
        &[&settings, &updates],
    )?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "app-settings" => {
            if let Some(window) = app.get_webview_window("settings") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            } else if let Err(error) = tauri::WebviewWindowBuilder::new(
                app,
                "settings",
                tauri::WebviewUrl::App("settings.html".into()),
            )
            .title("polakapi Settings")
            .inner_size(960.0, 640.0)
            .min_inner_size(740.0, 490.0)
            .build()
            {
                eprintln!("polakapi: settings window: {error}");
            }
        }
        "check-updates" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit_to("main", "check-updates", ());
        }
        _ => {}
    });
    Ok(())
}
