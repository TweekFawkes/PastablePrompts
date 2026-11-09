//! Terminal sessions: one shell per terminal tab, output streamed to the
//! webview as raw bytes over a Tauri channel.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Manager, State};
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Default)]
pub struct Ptys {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Input goes through a writer thread: a write blocks while the program
    /// in the terminal isn't reading, and that must not freeze the app.
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command(cwd: Option<&str>) -> CommandBuilder {
    #[cfg(windows)]
    let mut cmd = CommandBuilder::new("powershell.exe");
    // The user's login shell, so PATH comes from their profile even when
    // the app was launched from Finder or a desktop launcher.
    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new_default_prog();

    // The project folder, or home if there's no project or it's gone.
    let dir = cwd.map(PathBuf::from).filter(|d| d.is_dir()).or_else(dirs::home_dir);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "PastablePrompts");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

/// Starts a shell in `cwd` (or home). Output arrives on `on_output` as
/// ArrayBuffers; when the shell exits, its exit code is sent on `on_exit`.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    ptys: State<Ptys>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(shell_command(cwd.as_deref()))
        .map_err(|e| e.to_string())?;
    // Drop our copy of the slave side so reads hit EOF once the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = ptys.next_id.fetch_add(1, Ordering::Relaxed);
    let (input, input_rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name(format!("pty-{id}-in"))
        .spawn(move || {
            for data in input_rx {
                if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ptys.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            input,
            killer: child.clone_killer(),
        },
    );

    thread::Builder::new()
        .name(format!("pty-{id}-out"))
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if on_output.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            // Forget the session before reaping the child, so a late
            // pty_kill can never signal a recycled pid.
            app.state::<Ptys>().sessions.lock().unwrap().remove(&id);
            let code = child.wait().map_or(1, |status| status.exit_code());
            let _ = on_exit.send(code);
        })
        .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn pty_write(ptys: State<Ptys>, id: u32, data: String) -> Result<(), String> {
    let sessions = ptys.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session.input.send(data.into_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = ptys.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

/// Closes a terminal tab: kills its shell and forgets the session.
#[tauri::command]
pub fn pty_kill(ptys: State<Ptys>, id: u32) {
    if let Some(mut session) = ptys.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
}
