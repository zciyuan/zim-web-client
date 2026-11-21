#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop shell: loads the same Vite build the browser uses. All IM logic stays
// in the web app — this process only provides the native window, the tray,
// notifications, CORS-free HTTP and the file-save bridge.
//
// Closing the window hides it to the tray so the websocket (and therefore
// message notifications) keeps running. Quit from the tray menu.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewWindow, WindowEvent};

mod quic;

fn show_main(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn main() {
    tauri::Builder::default()
        // A second launch focuses the running instance instead of opening a
        // second socket with the same account (which the gate would kick).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_main(&window);
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(quic::QuicManager::default())
        .invoke_handler(tauri::generate_handler![
            quic::quic_connect,
            quic::quic_send,
            quic::quic_close
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示 ZIM", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 ZIM", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("ZIM")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_main(&window);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            show_main(&window);
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep running in the tray so background messages still notify.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the ZIM desktop shell");
}
