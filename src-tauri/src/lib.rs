use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

static STARTED: AtomicBool = AtomicBool::new(false);

/// Read the per-install token the engine writes to ~/.agentcal/token.
/// The UI sends it as `x-acal-token` so the guard accepts the request.
#[tauri::command]
fn engine_token() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".agentcal").join("token");
    let mut raw = String::new();
    std::fs::File::open(&path)
        .map_err(|e| format!("no token at {}: {e}", path.display()))?
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    Ok(raw.trim().to_string())
}

fn port_open() -> bool {
    let addr: SocketAddr = "127.0.0.1:4747".parse().expect("valid socket addr");
    TcpStream::connect_timeout(&addr, Duration::from_millis(220)).is_ok()
}

/// Resolve a Node binary even when the app was launched from Finder, where
/// PATH is the minimal system PATH and nvm/homebrew are not sourced.
fn node_binary() -> PathBuf {
    if let Ok(explicit) = std::env::var("OPENCAL_NODE") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return p;
        }
    }

    for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return p;
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let root = PathBuf::from(home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            dirs.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
            for dir in dirs.iter().rev() {
                let candidate = dir.join("bin/node");
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }

    PathBuf::from("node")
}

/// The app may be launched from Finder with a minimal PATH, and agent CLIs
/// often live outside it (OpenCode in ~/.opencode/bin, Codex/Hermes in
/// ~/.local/bin, nvm/npm globals under ~/.nvm). Build a PATH that includes
/// those before starting the engine.
fn agent_path() -> String {
    use std::collections::HashSet;

    let mut parts: Vec<String> = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let h = PathBuf::from(&home);
        for rel in [".opencode/bin", ".local/bin", ".bun/bin", ".cargo/bin"] {
            let p = h.join(rel);
            if p.exists() {
                parts.push(p.to_string_lossy().into_owned());
            }
        }

        let root = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            dirs.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
            if let Some(dir) = dirs.last() {
                let bin = dir.join("bin");
                if bin.exists() {
                    parts.push(bin.to_string_lossy().into_owned());
                }
            }
        }
    }

    for p in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        if PathBuf::from(p).exists() {
            parts.push(p.to_string());
        }
    }

    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(':') {
            if !p.is_empty() {
                parts.push(p.to_string());
            }
        }
    }

    let mut seen = HashSet::new();
    parts
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect::<Vec<_>>()
        .join(":")
}

fn engine_script(app: &tauri::AppHandle) -> Option<PathBuf> {    if let Ok(explicit) = std::env::var("OPENCAL_ENGINE") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for rel in [
            "../engine/bin/agentcal.js",
            "engine/bin/agentcal.js",
            "../../engine/bin/agentcal.js",
        ] {
            let path = cwd.join(rel);
            if path.exists() {
                return Some(path);
            }
        }
    }

    // Packaged builds: `bundle.resources` copies ../engine into the app.
    if let Ok(dir) = app.path().resource_dir() {
        for rel in ["engine/bin/agentcal.js", "_up_/engine/bin/agentcal.js"] {
            let path = dir.join(rel);
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Boot the MIT engine on 127.0.0.1:4747 if it is not already running.
/// Returns true when something is listening on the port afterwards.
#[tauri::command]
fn start_engine(app: tauri::AppHandle) -> Result<bool, String> {
    if port_open() {
        return Ok(true);
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if port_open() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        return Ok(port_open());
    }

    let script = match engine_script(&app) {
        Some(p) => p,
        None => {
            STARTED.store(false, Ordering::SeqCst);
            return Err(
                "engine not found — expected ./engine/bin/agentcal.js (set OPENCAL_ENGINE to override)"
                    .into(),
            );
        }
    };

    let node = node_binary();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("PATH", agent_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // The OpenCode desktop app injects OPENCODE_CLIENT / OPENCODE_SESSION_ID /
    // OPENCODE_TERMINAL into every process it launches. Those point the CLI at
    // the desktop session and make a scheduled `opencode run` retry a dead
    // endpoint. Scheduled runs need a clean slate.
    for (key, _) in std::env::vars() {
        if key == "OPENCODE" || key.starts_with("OPENCODE_") {
            cmd.env_remove(&key);
        }
    }

    cmd.spawn()
        .map_err(|e| {
            STARTED.store(false, Ordering::SeqCst);
            format!("could not start {}: {e}", node.display())
        })?;

    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if port_open() {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    STARTED.store(false, Ordering::SeqCst);
    Ok(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![engine_token, start_engine])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
