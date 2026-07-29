//! Overlay core.
//!
//! Everything privileged lives here: the window, the global shortcut, cursor
//! transparency and screen-capture protection. The Vue UI can do none of that —
//! it asks over IPC and listens for events.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    platform: &'static str,
    toggle_shortcut: &'static str,
    click_through: bool,
    content_protected: bool,
}

/// Let clicks pass through the window. The overlay floats above everything, and
/// while it captures the cursor you cannot work in the app underneath it.
#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    enabled: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    state.0.lock().unwrap().click_through = enabled;
    Ok(())
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

fn toggle_visibility(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    if window.is_visible()? {
        window.hide()?;
    } else {
        window.show()?;
        window.set_focus()?;
    }

    // Core-to-UI push. The other direction of IPC: not a reply to a frontend
    // request, but a message the native side initiates on its own.
    app.emit("overlay://visibility", window.is_visible()?)?;
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
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_content_protection,
            overlay_status,
            toggle_overlay
        ])
        .setup(|app| {
            app.global_shortcut().register(TOGGLE_SHORTCUT)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
