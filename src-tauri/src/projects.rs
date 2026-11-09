//! Projects, as in Zed: a folder that new terminals start in. The current
//! project and the recently opened ones live in the app's config folder, not
//! with the prompts, since the paths only mean something on this computer.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::prompts::atomic_write;

const MAX_RECENT: usize = 10;

pub struct Projects {
    file: PathBuf,
    state: Mutex<ProjectState>,
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
pub struct ProjectState {
    /// The open project's folder, or None for the home folder.
    pub current: Option<String>,
    /// Most recently opened first, including the current one.
    #[serde(default)]
    pub recent: Vec<String>,
}

impl ProjectState {
    /// Leaves out folders that are gone, without forgetting them: a project
    /// on an unplugged drive comes back when the drive does.
    fn existing(&self) -> ProjectState {
        let exists = |dir: &String| Path::new(dir).is_dir();
        ProjectState {
            current: self.current.clone().filter(exists),
            recent: self.recent.iter().filter(|dir| exists(dir)).cloned().collect(),
        }
    }
}

impl Projects {
    pub fn open(file: PathBuf) -> Self {
        let state = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Projects {
            file,
            state: Mutex::new(state),
        }
    }

    fn get(&self) -> ProjectState {
        self.state.lock().unwrap().existing()
    }

    /// Makes `dir` the current project (None for no project) and moves it to
    /// the top of the recent list.
    fn set(&self, dir: Option<&str>) -> Result<ProjectState, String> {
        if let Some(dir) = dir {
            let path = Path::new(dir);
            if !path.is_absolute() || !path.is_dir() {
                return Err(format!("{dir} isn't a folder"));
            }
        }
        let mut state = self.state.lock().unwrap();
        if let Some(dir) = dir {
            state.recent.retain(|d| d != dir);
            state.recent.insert(0, dir.to_string());
            state.recent.truncate(MAX_RECENT);
        }
        state.current = dir.map(str::to_string);
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(&*state).map_err(|e| e.to_string())?;
        atomic_write(&self.file, &json).map_err(|e| e.to_string())?;
        Ok(state.existing())
    }
}

#[tauri::command]
pub fn project_get(projects: State<Projects>) -> ProjectState {
    projects.get()
}

#[tauri::command]
pub fn project_open(projects: State<Projects>, path: String) -> Result<ProjectState, String> {
    projects.set(Some(&path))
}

/// Back to no project: new terminals start in the home folder.
#[tauri::command]
pub fn project_close(projects: State<Projects>) -> Result<ProjectState, String> {
    projects.set(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_close_and_recent() {
        let root = std::env::temp_dir().join(format!("pastable-projects-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dirs: Vec<String> = (0..12)
            .map(|i| {
                let dir = root.join(format!("p{i}"));
                fs::create_dir_all(&dir).unwrap();
                dir.to_string_lossy().into_owned()
            })
            .collect();
        let file = root.join("config").join("projects.json");
        let projects = Projects::open(file.clone());
        assert_eq!(projects.get(), ProjectState::default());

        // Reopening a project moves it back to the top.
        projects.set(Some(&dirs[0])).unwrap();
        projects.set(Some(&dirs[1])).unwrap();
        let state = projects.set(Some(&dirs[0])).unwrap();
        assert_eq!(state.current.as_ref(), Some(&dirs[0]));
        assert_eq!(state.recent, [dirs[0].clone(), dirs[1].clone()]);

        // Closing keeps the recent list.
        let state = projects.set(None).unwrap();
        assert_eq!(state.current, None);
        assert_eq!(state.recent.len(), 2);

        // Only files that are folders, by absolute path, can be projects.
        assert!(projects.set(Some("relative/path")).is_err());
        assert!(projects.set(Some(&root.join("missing").to_string_lossy())).is_err());

        // The list is capped, newest first.
        for dir in &dirs {
            projects.set(Some(dir)).unwrap();
        }
        let state = projects.get();
        assert_eq!(state.recent.len(), MAX_RECENT);
        assert_eq!(state.recent[0], dirs[11]);

        // It survives a restart, and folders that are gone are left out.
        fs::remove_dir(&dirs[11]).unwrap();
        let reopened = Projects::open(file).get();
        assert_eq!(reopened.current, None);
        assert_eq!(reopened.recent.len(), MAX_RECENT - 1);
        assert_eq!(reopened.recent[0], dirs[10]);

        fs::remove_dir_all(&root).unwrap();
    }
}
