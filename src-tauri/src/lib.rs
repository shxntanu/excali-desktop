use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Documents(Mutex<HashSet<PathBuf>>);

#[derive(Default)]
struct Closing(AtomicBool);

#[derive(Serialize)]
struct OpenedDocument {
    path: String,
    data: String,
}

// Replace only after a complete write; a failed save leaves the original intact.
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing destination folder")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_document(app: tauri::AppHandle) -> Result<Option<OpenedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Excalidraw drawing", &["excalidraw", "json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        app.state::<Documents>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(path.clone());
        Ok(Some(OpenedDocument {
            path: path.to_string_lossy().into_owned(),
            data,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_document(
    app: tauri::AppHandle,
    path: Option<String>,
    data: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(path) => {
                let path = PathBuf::from(path);
                if !app
                    .state::<Documents>()
                    .0
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(&path)
                {
                    return Err("Choose this file through Save As before writing to it".into());
                }
                path
            }
            None => {
                let Some(file) = app
                    .dialog()
                    .file()
                    .add_filter("Excalidraw drawing", &["excalidraw"])
                    .set_file_name("Untitled.excalidraw")
                    .blocking_save_file()
                else {
                    return Ok(None);
                };
                let mut path = file.into_path().map_err(|e| e.to_string())?;
                if path.extension().is_none() {
                    path.set_extension("excalidraw");
                }
                path
            }
        };
        atomic_write(&path, &data)?;
        app.state::<Documents>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(path.clone());
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn recovery_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok(folder.join("recovery.json"))
}

#[tauri::command]
async fn read_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match fs::read_to_string(recovery_path(&app)?) {
        Ok(data) => Ok(Some(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_recovery(app: tauri::AppHandle, data: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = recovery_path(&app)?;
        match data {
            Some(data) => atomic_write(&path, &data),
            None => match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.state::<Closing>().0.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .manage(Documents::default())
        .manage(Closing::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            read_recovery,
            write_recovery,
            close_app
        ])
        .build(tauri::generate_context!())
        .expect("Failed to start Excali Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<Closing>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("request-close", ());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_existing_document_and_preserves_it_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drawing.excalidraw");
        atomic_write(&path, "original").unwrap();
        atomic_write(&path, "updated").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
        assert!(atomic_write(&dir.path().join("missing/drawing"), "lost").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
