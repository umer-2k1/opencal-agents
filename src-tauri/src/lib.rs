use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static STARTED: AtomicBool = AtomicBool::new(false);

/// Read the per-install token the engine writes to ~/.agentcal/token.
/// The UI sends it as `x-acal-token` so browser-origin requests are allowed.
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

fn engine_script() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("OPENCAL_ENGINE") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join("../engine/bin/agentcal.js"),
        cwd.join("engine/bin/agentcal.js"),
        cwd.join("../../engine/bin/agentcal.js"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Boot the MIT engine on 127.0.0.1:4747 if it is not already running.
/// Returns true when something is listening on the port afterwards.
#[tauri::command]
fn start_engine() -> Result<bool, String> {
    if port_open() {
        return Ok(true);
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        // Another launch attempt is in flight; give it a moment.
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if port_open() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        return Ok(port_open());
    }

    let script = match engine_script() {
        Some(p) => p,
        None => {
            STARTED.store(false, Ordering::SeqCst);
            return Err(
                "engine not found — expected ./engine/bin/agentcal.js (set OPENCAL_ENGINE to override)"
                    .into(),
            );
        }
    };

    Command::new("node")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            STARTED.store(false, Ordering::SeqCst);
            format!("could not start node: {e}")
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
        .invoke_handler(tauri::generate_handler![engine_token, start_engine])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
