//! Authenticated loopback bridge. MCP itself runs over stdio in scripts/mcp.ts.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tiny_http::{Header, Response, Server, StatusCode};

#[derive(Default)]
pub struct Bridge {
    started: Mutex<bool>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Value>>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Request {
    id: String,
    method: String,
    params: Value,
}

#[tauri::command]
pub fn mcp_reply(app: tauri::AppHandle, id: String, result: Value) -> Result<(), String> {
    if let Some(sender) = app
        .state::<Bridge>()
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
    {
        let _ = sender.send(result);
    }
    Ok(())
}

#[tauri::command]
pub fn start_mcp(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Bridge>();
    let mut started = state.started.lock().map_err(|e| e.to_string())?;
    if *started {
        return Ok(());
    }
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("Missing loopback address")?
        .port();
    let token = uuid::Uuid::new_v4().to_string();
    let descriptor = super::app_folder(&app)?.join("mcp.json");
    super::atomic_write(
        &descriptor,
        &json!({"url": format!("http://127.0.0.1:{port}"), "token": token}).to_string(),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    *started = true;
    drop(started);
    std::thread::spawn(move || {
        // Serialize agent operations, so read/modify/write flows never race each other.
        for mut request in server.incoming_requests() {
            let authorized = request.headers().iter().any(|h| {
                h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}")
            });
            let browser = request.headers().iter().any(|h| h.field.equiv("Origin"));
            if !authorized || browser {
                let _ = request.respond(Response::empty(StatusCode(403)));
                continue;
            }
            if request.method() != &tiny_http::Method::Post || request.url() != "/rpc" {
                let _ = request.respond(Response::empty(StatusCode(404)));
                continue;
            }
            let mut body = String::new();
            let read = request
                .as_reader()
                .take(16 * 1024 * 1024 + 1)
                .read_to_string(&mut body);
            let parsed = if read.is_ok() && body.len() <= 16 * 1024 * 1024 {
                serde_json::from_str::<Request>(&body).ok()
            } else {
                None
            };
            let Some(mut call) = parsed else {
                let _ = request.respond(Response::empty(StatusCode(400)));
                continue;
            };
            // The app owns correlation IDs, regardless of what a client sends.
            call.id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = mpsc::sync_channel(1);
            if let Ok(mut pending) = app.state::<Bridge>().pending.lock() {
                pending.insert(call.id.clone(), sender);
            }
            let result = match app.emit_to("main", "mcp-request", &call) {
                Ok(()) => receiver.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| json!({"error": "Desktop editor did not respond. Retry after it finishes loading."})),
                Err(error) => json!({"error": error.to_string()}),
            };
            if let Ok(mut pending) = app.state::<Bridge>().pending.lock() {
                pending.remove(&call.id);
            }
            let response = Response::from_string(result.to_string())
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
            let _ = request.respond(response);
        }
    });
    Ok(())
}
