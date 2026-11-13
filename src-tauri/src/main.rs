// Cader desktop shell. The window comes from tauri.conf.json; the UI reaches the document
// library through the commands registered here. Dictation (S-3) and models (S-4) add more.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dictation;
mod fetch;
mod library;
mod models;
mod versions;

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

// The default menu, with model credits and licences in the About panel (S-4 Req 8).
fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let info = app.package_info();
        let about = AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            credits: Some(
                "Runs entirely on this Mac.\n\n\
                 Dictation: Whisper large-v3-turbo (OpenAI, MIT).\n\
                 Corrections: CoEdIT-large (Grammarly, CC-BY-NC-4.0). Personal, non-commercial use only; a commercial build needs a different correction model.\n\
                 Suggestions: Qwen2.5-14B-Instruct (Alibaba Cloud, Apache-2.0)."
                    .into(),
            ),
            ..Default::default()
        };
        app_menu.remove_at(0)?;
        app_menu.insert(&PredefinedMenuItem::about(app, None, Some(about))?, 0)?;
    }
    Ok(menu)
}

fn main() {
    // Option+Space toggles dictation from anywhere (S-3 Req 3); the UI decides start or stop.
    let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    tauri::Builder::default()
        .manage(dictation::Dictation::default())
        .manage(models::Models::default())
        .menu(menu)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([toggle])
                .expect("valid shortcut")
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle && event.state == ShortcutState::Pressed {
                        let _ = app.emit("dictation-toggle", ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            library::list_docs,
            library::create_doc,
            library::open_doc,
            library::save_text,
            library::rename_doc,
            library::delete_doc,
            dictation::dictation_status,
            dictation::start_recording,
            dictation::stop_recording,
            dictation::open_mic_settings,
            models::models_status,
            models::models_download,
            models::cancel,
            models::correct,
            models::rephrase,
            models::substitute,
            models::alternatives,
            versions::save_version,
            versions::list_versions,
            versions::get_version,
            versions::restore_version,
            versions::export_version,
            versions::print_page,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Cader")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<models::Models>().unload();
            }
        });
}
