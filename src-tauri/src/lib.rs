use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
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

#[derive(Default)]
struct Linked(Mutex<()>);

#[derive(Serialize)]
struct OpenedDocument {
    path: String,
    data: String,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    folder: bool,
    children: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFont {
    family: String,
    units_per_em: u16,
    ascender: i16,
    descender: i16,
}

#[derive(Serialize)]
struct Workspace {
    root: String,
    entries: Vec<Entry>,
}

const EXTENSION: &str = "excalidraw";

fn workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".excali-desktop");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    root.canonicalize().map_err(|e| e.to_string())
}

// Canonicalizing the parent rejects `..` and symlinks that lead outside the workspace.
fn in_workspace(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let outside = || "That location is outside the drawings folder".to_string();
    let name = path.file_name().ok_or_else(outside)?;
    let parent = path
        .parent()
        .ok_or_else(outside)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(root) {
        return Err(outside());
    }
    Ok(parent.join(name))
}

fn workspace_folder(root: &Path, path: &str) -> Result<PathBuf, String> {
    let folder = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !folder.starts_with(root) || !folder.is_dir() {
        return Err("That location is outside the drawings folder".into());
    }
    Ok(folder)
}

fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
    {
        return Err("Names can't be empty, start with a dot, or contain / \\ :".into());
    }
    Ok(name)
}

fn unique_path(folder: &Path, base: &str, extension: Option<&str>) -> PathBuf {
    (1..)
        .map(|i| {
            let stem = if i == 1 {
                base.to_string()
            } else {
                format!("{base} {i}")
            };
            folder.join(match extension {
                Some(extension) => format!("{stem}.{extension}"),
                None => stem,
            })
        })
        .find(|path| path.symlink_metadata().is_err())
        .unwrap()
}

fn read_tree(folder: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for item in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // DirEntry::file_type does not follow symlinks, so they are skipped.
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            entries.push(Entry {
                children: read_tree(&path)?,
                name,
                path: path.to_string_lossy().into_owned(),
                folder: true,
            });
        } else if kind.is_file() && path.extension().is_some_and(|e| e == EXTENSION) {
            entries.push(Entry {
                name: path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.to_string_lossy().into_owned(),
                folder: false,
                children: Vec::new(),
            });
        }
    }
    entries.sort_by_cached_key(|entry| (!entry.folder, entry.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
async fn workspace(app: tauri::AppHandle) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&app)?;
        Ok(Workspace {
            entries: read_tree(&root)?,
            root: root.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_drawing(app: tauri::AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if !is_linked(&app, &path) {
            in_workspace(&workspace_root(&app)?, &path)?;
        }
        fs::read_to_string(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_drawing(
    app: tauri::AppHandle,
    folder: String,
    data: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = workspace_folder(&workspace_root(&app)?, &folder)?;
        let path = unique_path(&folder, "Untitled", Some(EXTENSION));
        atomic_write(&path, &data)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_folder(app: tauri::AppHandle, folder: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = workspace_folder(&workspace_root(&app)?, &folder)?;
        let path = unique_path(&folder, "New folder", None);
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_entry(app: tauri::AppHandle, path: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = in_workspace(&workspace_root(&app)?, Path::new(&path))?;
        let name = valid_name(&name)?;
        let parent = source.parent().ok_or("Missing parent folder")?;
        let target = if source.is_dir() {
            parent.join(name)
        } else {
            let stem = name.strip_suffix(".excalidraw").unwrap_or(name);
            parent.join(format!("{}.{EXTENSION}", valid_name(stem)?))
        };
        if target == source {
            return Ok(path);
        }
        // Case-only renames point at the same file on case-insensitive volumes.
        let case_only =
            target.to_string_lossy().to_lowercase() == source.to_string_lossy().to_lowercase();
        if !case_only && target.symlink_metadata().is_ok() {
            return Err(format!("“{name}” already exists in this folder"));
        }
        fs::rename(&source, &target).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
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
            .set_directory(workspace_root(&app)?)
            .add_filter("Excalidraw drawing", &["excalidraw", "json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = canonical(file.into_path().map_err(|e| e.to_string())?);
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        app.state::<Documents>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(path.clone());
        remember(&app, &path)?;
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
        let save_as = path.is_none();
        let path = match path {
            Some(path) => {
                let path = PathBuf::from(path);
                let chosen = app
                    .state::<Documents>()
                    .0
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(&path);
                if !chosen
                    && !is_linked(&app, &path)
                    && in_workspace(&workspace_root(&app)?, &path).is_err()
                {
                    return Err("Choose this file through Save As before writing to it".into());
                }
                path
            }
            None => {
                let Some(file) = app
                    .dialog()
                    .file()
                    .set_directory(workspace_root(&app)?)
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
                canonical(path)
            }
        };
        atomic_write(&path, &data)?;
        app.state::<Documents>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(path.clone());
        if save_as {
            remember(&app, &path)?;
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// App state lives in a hidden folder inside the drawings folder, which the sidebar skips.
fn app_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = workspace_root(app)?.join(".app");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok(folder)
}

fn recovery_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app_folder(app)?.join("recovery.json");
    // Earlier versions kept recovery in the OS application-data folder.
    if let Ok(old_folder) = app.path().app_data_dir() {
        let old = old_folder.join("recovery.json");
        if !path.exists() && old.exists() && fs::copy(&old, &path).is_ok() {
            let _ = fs::remove_file(&old);
            let _ = fs::remove_dir(&old_folder);
        }
    }
    Ok(path)
}

fn linked_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_folder(app)?.join("linked.json"))
}

fn read_linked(app: &tauri::AppHandle) -> Vec<PathBuf> {
    linked_path(app)
        .and_then(|path| fs::read_to_string(path).map_err(|e| e.to_string()))
        .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
        .unwrap_or_default()
}

const LINKED_LIMIT: usize = 100;

// Files opened from outside the drawings folder stay where they are and are remembered here.
fn update_linked(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut Vec<PathBuf>),
) -> Result<(), String> {
    let state = app.state::<Linked>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let mut linked = read_linked(app);
    change(&mut linked);
    linked.truncate(LINKED_LIMIT);
    atomic_write(
        &linked_path(app)?,
        &serde_json::to_string_pretty(&linked).map_err(|e| e.to_string())?,
    )
}

// One spelling per file, so the sidebar and permission checks agree (e.g. /var vs /private/var).
fn canonical(path: PathBuf) -> PathBuf {
    match (
        path.parent().and_then(|parent| parent.canonicalize().ok()),
        path.file_name(),
    ) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path,
    }
}

fn remember(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    if in_workspace(&workspace_root(app)?, path).is_ok() {
        return Ok(());
    }
    update_linked(app, |linked| {
        linked.retain(|item| item != path);
        linked.insert(0, path.to_path_buf());
    })
}

fn is_linked(app: &tauri::AppHandle, path: &Path) -> bool {
    read_linked(app).iter().any(|item| item == path)
}

#[derive(Serialize)]
struct LinkedDocument {
    name: String,
    path: String,
    location: String,
    missing: bool,
}

#[tauri::command]
async fn linked_documents(app: tauri::AppHandle) -> Result<Vec<LinkedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = app.path().home_dir().ok();
        Ok(read_linked(&app)
            .into_iter()
            .map(|path| {
                let parent = path.parent().unwrap_or(Path::new(""));
                let location = match home
                    .as_deref()
                    .and_then(|home| parent.strip_prefix(home).ok())
                {
                    Some(relative) => Path::new("~").join(relative).to_string_lossy().into_owned(),
                    None => parent.to_string_lossy().into_owned(),
                };
                LinkedDocument {
                    name: path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    missing: !path.is_file(),
                    path: path.to_string_lossy().into_owned(),
                    location,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn forget_document(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        update_linked(&app, |linked| linked.retain(|item| *item != path))
    })
    .await
    .map_err(|e| e.to_string())?
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
async fn list_fonts() -> Result<Vec<SystemFont>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // Metrics come from each family's face closest to an upright regular.
        let mut regular: HashMap<String, (u32, fontdb::ID)> = HashMap::new();
        for face in db.faces() {
            let Some((name, _)) = face.families.first() else {
                continue;
            };
            let name = name.trim();
            // Dot-prefixed families are private macOS UI fonts.
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let upright = if face.style == fontdb::Style::Normal {
                0
            } else {
                1000
            };
            let score = (i32::from(face.weight.0) - 400).unsigned_abs() + upright;
            if regular.get(name).is_none_or(|(best, _)| score < *best) {
                regular.insert(name.to_owned(), (score, face.id));
            }
        }
        let mut fonts: Vec<SystemFont> = regular
            .into_iter()
            .filter_map(|(family, (_, id))| {
                db.with_face_data(id, |data, index| {
                    let face = ttf_parser::Face::parse(data, index).ok()?;
                    Some(SystemFont {
                        family,
                        units_per_em: face.units_per_em(),
                        ascender: face.ascender(),
                        descender: face.descender(),
                    })
                })?
            })
            .collect();
        fonts.sort_by_key(|font| font.family.to_lowercase());
        fonts
    })
    .await
    .map_err(|e| e.to_string())
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
        .manage(Linked::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            read_recovery,
            write_recovery,
            list_fonts,
            close_app,
            workspace,
            read_drawing,
            create_drawing,
            create_folder,
            rename_entry,
            linked_documents,
            forget_document
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
