//! Overlay core.
//!
//! Everything privileged lives here: the window, the global shortcut, cursor
//! transparency and screen-capture protection. The Vue UI can do none of that —
//! it asks over IPC and listens for events.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

const TOGGLE_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";

/// The core owns overlay state, not the frontend: the shortcut can fire while
/// the window is hidden and no JavaScript is alive to handle it.
#[derive(Default)]
struct OverlayState(Mutex<Flags>);

#[derive(Default, Clone, Copy)]
struct Flags {
    click_through: bool,
    content_protected: bool,
}

/// The tray mirror of click-through. Kept so the menu checkmark cannot drift
/// away from the real window state when the mode is changed from elsewhere.
#[derive(Default)]
struct TrayItems(Mutex<Option<CheckMenuItem<Wry>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    platform: &'static str,
    toggle_shortcut: &'static str,
    click_through: bool,
    content_protected: bool,
}

/// Single point where click-through changes: the window, the stored flag, the
/// tray checkmark and the UI all move together. Anything that skips this ends up
/// with a checkbox that disagrees with the window.
fn apply_click_through(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_ignore_cursor_events(enabled)?;
    }

    app.state::<OverlayState>().0.lock().unwrap().click_through = enabled;

    if let Some(item) = app.state::<TrayItems>().0.lock().unwrap().as_ref() {
        let _ = item.set_checked(enabled);
    }

    app.emit("overlay://flags", ())?;
    Ok(())
}

/// Let clicks pass through the window. The overlay floats above everything, and
/// while it captures the cursor you cannot work in the app underneath it.
#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_click_through(&app, enabled).map_err(|e| e.to_string())
}

/// Exclude the window from screen capture: `NSWindowSharingNone` on macOS,
/// `WDA_EXCLUDEFROMCAPTURE` on Windows. A person sees the window, screen
/// sharing and recording do not.
#[tauri::command]
fn set_content_protection(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    enabled: bool,
) -> Result<(), String> {
    window
        .set_content_protected(enabled)
        .map_err(|e| e.to_string())?;
    state.0.lock().unwrap().content_protected = enabled;
    Ok(())
}

#[tauri::command]
fn overlay_status(state: State<'_, OverlayState>) -> OverlayStatus {
    let flags = *state.0.lock().unwrap();
    OverlayStatus {
        platform: std::env::consts::OS,
        toggle_shortcut: TOGGLE_SHORTCUT,
        click_through: flags.click_through,
        content_protected: flags.content_protected,
    }
}

#[tauri::command]
fn toggle_overlay(app: AppHandle) -> Result<(), String> {
    toggle_visibility(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    set_visibility(&app, false).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn set_visibility(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    if visible {
        // Summoning the overlay means you want to interact with it, so the mode
        // that makes it ignore the cursor is dropped on the way in.
        if app.state::<OverlayState>().0.lock().unwrap().click_through {
            apply_click_through(app, false)?;
        }
        window.show()?;
        window.set_focus()?;
    } else {
        window.hide()?;
    }

    // Core-to-UI push. The other direction of IPC: not a reply to a frontend
    // request, but a message the native side initiates on its own.
    app.emit("overlay://visibility", window.is_visible()?)?;
    Ok(())
}

fn toggle_visibility(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let visible = window.is_visible()?;
    set_visibility(app, !visible)
}

/// The window is frameless, so it has no title bar of its own. The tray is the
/// one control that stays reachable even when the overlay is hidden — or when it
/// is ignoring the cursor and cannot be clicked at all.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, Some(TOGGLE_SHORTCUT))?;
    let click_through = CheckMenuItem::with_id(
        app,
        "click_through",
        "Click-through",
        true,
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Overlay Demo"))?;
    let menu = Menu::with_items(app, &[&toggle, &click_through, &separator, &quit])?;

    app.state::<TrayItems>()
        .0
        .lock()
        .unwrap()
        .replace(click_through);

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .tooltip("Overlay Demo")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = toggle_visibility(app);
            }
            "click_through" => {
                let enabled = app.state::<OverlayState>().0.lock().unwrap().click_through;
                let _ = apply_click_through(app, !enabled);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let is_toggle =
                        shortcut.mods.contains(Modifiers::SHIFT) && shortcut.key == Code::Space;

                    if is_toggle && event.state() == ShortcutState::Pressed {
                        let _ = toggle_visibility(app);
                    }
                })
                .build(),
        )
        .manage(OverlayState::default())
        .manage(TrayItems::default())
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_content_protection,
            overlay_status,
            toggle_overlay,
            hide_overlay,
            quit_app
        ])
        .on_window_event(|window, event| {
            // Closing an overlay should put it away, not end the session — the
            // shortcut and the tray are expected to bring it straight back.
            // Quitting stays explicit: the tray menu, Cmd+Q or the UI button.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = set_visibility(window.app_handle(), false);
            }
        })
        .setup(|app| {
            app.global_shortcut().register(TOGGLE_SHORTCUT)?;
            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
