#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop shell: loads the same Vite build the browser uses. All IM logic stays
// in the web app — this process only provides a native window and the bundle.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run the ZIM desktop shell");
}
