mod prompts;
mod projects;
mod pty;

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Where prompts are saved: `$PASTABLE_PROMPTS_DIR`, or `~/PastablePrompts`.
fn prompts_dir() -> PathBuf {
    std::env::var_os("PASTABLE_PROMPTS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join("PastablePrompts")))
        .expect("no home directory")
}

/// Asks the window to flush unsaved prompts, then quits. The frontend calls
/// `app_quit` once it has saved; if it never answers, quit anyway.
fn request_quit(app: &AppHandle) {
    if app.emit("quit-requested", ()).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        app.exit(0);
    });
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let quit = MenuItemBuilder::with_id("quit", "Quit Pastable Prompts")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Pastable Prompts")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File").item(&open_folder).build()?;
    // No Undo, Select All or Close Window items: the editor and the app's
    // own shortcuts handle Cmd+Z, Cmd+A and Cmd+W, and a menu item would
    // grab those keys first. Cut/Copy/Paste must stay for the clipboard.
    let edit = SubmenuBuilder::new(app, "Edit").cut().copy().paste().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().fullscreen().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &window]).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .setup(|app| {
            app.manage(prompts::Store::open(prompts_dir())?);
            app.manage(projects::Projects::open(app.path().app_config_dir()?.join("projects.json")));
            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(app)?)?;
                app.on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => request_quit(app),
                    // The window shows the folder picker; see `chooseProject`.
                    "open-folder" => {
                        let _ = app.emit("open-folder", ());
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_quit,
            prompts::prompts_dir,
            prompts::prompt_list,
            prompts::prompt_create,
            prompts::prompt_read,
            prompts::prompt_save,
            prompts::prompt_close,
            prompts::prompt_rename,
            prompts::prompt_star,
            prompts::prompt_mark_used,
            prompts::session_get,
            prompts::session_set,
            projects::project_get,
            projects::project_open,
            projects::project_close,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
