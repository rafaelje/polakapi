use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_store::StoreExt;

const MENU_STORE: &str = "app-menu.json";
const MENU_VISIBLE_KEY: &str = "visible";

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
    // On Windows and Linux the shortcut lives in the webview (see
    // `resolveAppShortcut`), because a hidden menu bar cannot fire accelerators.
    #[cfg(target_os = "macos")]
    let toggle_accelerator = Some("Cmd+Shift+M");
    #[cfg(not(target_os = "macos"))]
    let toggle_accelerator = None::<&str>;
    let toggle_menu_bar = MenuItem::with_id(
        app,
        "toggle-menu-bar",
        "Toggle Menu Bar",
        true,
        toggle_accelerator,
    )?;
    #[cfg(target_os = "macos")]
    {
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
        let view = menu.items()?.into_iter().find(|item| {
            item.as_submenu()
                .is_some_and(|submenu| submenu.text().ok().as_deref() == Some("View"))
        });
        if let Some(view) = view.as_ref().and_then(|item| item.as_submenu()) {
            view.append_items(&[
                &tauri::menu::PredefinedMenuItem::separator(app)?,
                &toggle_menu_bar,
            ])?;
        }
    }
    #[cfg(target_os = "linux")]
    for item in menu.items()? {
        let is_window_menu = item
            .as_submenu()
            .is_some_and(|submenu| submenu.id() == tauri::menu::WINDOW_SUBMENU_ID);
        if is_window_menu {
            menu.remove(&item)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        menu.prepend(&tauri::menu::Submenu::with_items(
            app,
            "polakapi",
            true,
            &[&settings, &updates],
        )?)?;
        menu.insert(
            &tauri::menu::Submenu::with_items(app, "View", true, &[&toggle_menu_bar])?,
            2,
        )?;
    }
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    if !stored_menu_visible(app.handle()) {
        set_macos_menu_bar_hidden(app.handle(), true)?;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        apply_stored_menu_visibility(app.handle(), &window);
    }
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "app-settings" => {
            if let Some(window) = app.get_webview_window("settings") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                return;
            }
            match tauri::WebviewWindowBuilder::new(
                app,
                "settings",
                tauri::WebviewUrl::App("settings.html".into()),
            )
            .title("polakapi Settings")
            .inner_size(960.0, 740.0)
            .min_inner_size(740.0, 490.0)
            .build()
            {
                #[cfg(not(target_os = "macos"))]
                Ok(window) => apply_stored_menu_visibility(app, &window),
                #[cfg(target_os = "macos")]
                Ok(_) => {}
                Err(error) => eprintln!("polakapi: settings window: {error}"),
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
        "toggle-menu-bar" => {
            if let Err(error) = toggle_menu_bar_visibility(app) {
                eprintln!("polakapi: toggle menu bar: {error}");
            }
        }
        _ => {}
    });
    Ok(())
}

/// Shows or hides the menu bar and remembers the choice. Windows and Linux
/// hide the in-window menu bar; macOS auto-hides the system menu bar (and the
/// Dock, which AppKit requires) until the pointer reaches the screen edge.
/// Returns the new visibility.
#[tauri::command]
pub fn toggle_menu_bar(app: AppHandle) -> Result<bool, String> {
    toggle_menu_bar_visibility(&app).map_err(|e| e.to_string())
}

fn toggle_menu_bar_visibility(app: &AppHandle) -> tauri::Result<bool> {
    let visible = !stored_menu_visible(app);
    #[cfg(target_os = "macos")]
    set_macos_menu_bar_hidden(app, !visible)?;
    #[cfg(not(target_os = "macos"))]
    for window in app.webview_windows().values() {
        if visible {
            window.show_menu()?;
        } else {
            window.hide_menu()?;
        }
    }
    if let Ok(store) = app.store(MENU_STORE) {
        store.set(MENU_VISIBLE_KEY, visible);
        let _ = store.save();
    }
    Ok(visible)
}

#[cfg(target_os = "macos")]
fn set_macos_menu_bar_hidden(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    app.run_on_main_thread(move || {
        use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
        let Some(main_thread) = objc2::MainThreadMarker::new() else {
            return;
        };
        let application = NSApplication::sharedApplication(main_thread);
        let mut options = application.presentationOptions();
        options.set(
            NSApplicationPresentationOptions::AutoHideMenuBar
                | NSApplicationPresentationOptions::AutoHideDock,
            hidden,
        );
        application.setPresentationOptions(options);
    })
}

fn stored_menu_visible(app: &AppHandle) -> bool {
    app.store(MENU_STORE)
        .ok()
        .and_then(|store| store.get(MENU_VISIBLE_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
fn apply_stored_menu_visibility(app: &AppHandle, window: &tauri::WebviewWindow) {
    if !stored_menu_visible(app) {
        if let Err(error) = window.hide_menu() {
            eprintln!("polakapi: hide menu bar: {error}");
        }
    }
}
