//! Prompt storage: one plain `.md` file per prompt in a single folder.
//!
//! A prompt's id is the local time its tab was opened (`YYYYMMDD-HHMMSS`, plus
//! `_N` if two open in the same second). The id is the filename prefix and
//! never changes; the `-slug` after it follows the prompt's name if it has
//! been renamed, or else the first line of text. Names, stars, last-used
//! times and the open-tab session live in a small sidecar index.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::State;

const INDEX_FILE: &str = ".pastable-index.json";
const EXT: &str = ".md";
const SLUG_MAX_CHARS: usize = 48;

pub struct Store {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// id -> current path on disk, for prompts that have a file.
    paths: HashMap<String, PathBuf>,
    /// ids handed out to open tabs that haven't been written yet.
    reserved: HashSet<String>,
    index: Index,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    /// id -> when it was starred (ms since epoch).
    #[serde(default)]
    starred: BTreeMap<String, i64>,
    /// id -> when it was last pasted into a terminal (ms since epoch).
    #[serde(default)]
    last_used: BTreeMap<String, i64>,
    /// id -> the name it was given, which replaces its first line as its title.
    #[serde(default)]
    names: BTreeMap<String, String>,
    #[serde(default)]
    session: Session,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Session {
    pub open: Vec<String>,
    pub active: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromptMeta {
    id: String,
    file_name: String,
    content: String,
    name: Option<String>,
    created_ms: i64,
    modified_ms: i64,
    last_used_ms: Option<i64>,
    starred: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrompt {
    id: String,
    created_ms: i64,
}

impl Store {
    pub fn open(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let index = fs::read(dir.join(INDEX_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let store = Store {
            dir,
            inner: Mutex::new(Inner {
                index,
                ..Default::default()
            }),
        };
        store.rescan(&mut store.inner.lock().unwrap());
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn rescan(&self, inner: &mut Inner) {
        inner.paths.clear();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(id) = parse_id(name) {
                inner.paths.insert(id.to_string(), entry.path());
            }
        }
    }

    fn write_index(&self, index: &Index) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
        atomic_write(&self.dir.join(INDEX_FILE), &json).map_err(|e| e.to_string())
    }

    fn meta(&self, inner: &Inner, id: &str, path: &Path) -> Option<PromptMeta> {
        let content = fs::read_to_string(path).ok()?;
        let modified_ms = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        Some(PromptMeta {
            id: id.to_string(),
            file_name: path.file_name()?.to_string_lossy().into_owned(),
            content,
            name: inner.index.names.get(id).cloned(),
            created_ms: created_ms(id),
            modified_ms,
            last_used_ms: inner.index.last_used.get(id).copied(),
            starred: inner.index.starred.contains_key(id),
        })
    }

    /// Writes `content` for `id`, renaming the file if its slug changed.
    /// The slug follows the prompt's name, if it has one. Otherwise it follows
    /// the first line once that line is finished (there's a newline after
    /// it), or straight away if `final_name` is set.
    fn save(&self, inner: &mut Inner, id: &str, content: &str, final_name: bool) -> Result<Option<PathBuf>, String> {
        if parse_id(&file_name(id, "")) != Some(id) {
            return Err(format!("invalid prompt id: {id}"));
        }
        let current = inner.paths.get(id).cloned();
        if current.is_none() && content.trim().is_empty() {
            return Ok(None);
        }
        let mut path = current.clone().unwrap_or_else(|| self.dir.join(file_name(id, "")));
        let name = inner.index.names.get(id);
        if final_name || name.is_some() || first_line_finished(content) {
            let wanted = self.dir.join(file_name(id, &slug(name.map_or(content, String::as_str))));
            if wanted != path {
                if current.is_some() {
                    fs::rename(&path, &wanted).map_err(|e| e.to_string())?;
                }
                path = wanted;
            }
        }
        atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
        inner.paths.insert(id.to_string(), path.clone());
        inner.reserved.remove(id);
        Ok(Some(path))
    }
}

#[tauri::command]
pub fn prompts_dir(store: State<Store>) -> String {
    store.dir().to_string_lossy().into_owned()
}

/// Reads every prompt, so it runs off the main thread.
#[tauri::command]
pub async fn prompt_list(store: State<'_, Store>) -> Result<Vec<PromptMeta>, String> {
    let mut inner = store.inner.lock().unwrap();
    store.rescan(&mut inner);
    let mut list: Vec<PromptMeta> = inner
        .paths
        .iter()
        .filter_map(|(id, path)| store.meta(&inner, id, path))
        .collect();
    list.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(list)
}

#[tauri::command]
pub fn prompt_create(store: State<Store>) -> NewPrompt {
    let mut inner = store.inner.lock().unwrap();
    let now = Local::now();
    let base = now.format("%Y%m%d-%H%M%S").to_string();
    let taken = |id: &str| inner.paths.contains_key(id) || inner.reserved.contains(id);
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}_{n}");
        n += 1;
    }
    inner.reserved.insert(id.clone());
    NewPrompt {
        created_ms: created_ms(&id),
        id,
    }
}

#[tauri::command]
pub fn prompt_read(store: State<Store>, id: String) -> String {
    let inner = store.inner.lock().unwrap();
    inner
        .paths
        .get(&id)
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Saves while the tab stays open. Returns the prompt's metadata, or None if
/// there's nothing on disk yet (a still-empty tab).
#[tauri::command]
pub fn prompt_save(store: State<Store>, id: String, content: String) -> Result<Option<PromptMeta>, String> {
    let mut inner = store.inner.lock().unwrap();
    let path = store.save(&mut inner, &id, &content, false)?;
    Ok(path.and_then(|p| store.meta(&inner, &id, &p)))
}

/// Final save when a tab closes. Empty prompts are deleted instead of kept.
#[tauri::command]
pub fn prompt_close(store: State<Store>, id: String, content: String) -> Result<Option<PromptMeta>, String> {
    let mut inner = store.inner.lock().unwrap();
    inner.reserved.remove(&id);
    if content.trim().is_empty() {
        if let Some(path) = inner.paths.remove(&id) {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        let had_meta = inner.index.starred.remove(&id).is_some()
            | inner.index.last_used.remove(&id).is_some()
            | inner.index.names.remove(&id).is_some();
        if had_meta {
            store.write_index(&inner.index)?;
        }
        return Ok(None);
    }
    let path = store.save(&mut inner, &id, &content, true)?;
    Ok(path.and_then(|p| store.meta(&inner, &id, &p)))
}

/// Gives a prompt a name to show instead of its first line, or with an empty
/// `name`, goes back to the first line. Saves `content` too, renaming the
/// file to match.
#[tauri::command]
pub fn prompt_rename(
    store: State<Store>,
    id: String,
    name: String,
    content: String,
) -> Result<Option<PromptMeta>, String> {
    let mut inner = store.inner.lock().unwrap();
    let name = name.trim();
    if name.is_empty() {
        inner.index.names.remove(&id);
    } else {
        inner.index.names.insert(id.clone(), name.to_string());
    }
    let path = store.save(&mut inner, &id, &content, true)?;
    store.write_index(&inner.index)?;
    Ok(path.and_then(|p| store.meta(&inner, &id, &p)))
}

#[tauri::command]
pub fn prompt_star(store: State<Store>, id: String, starred: bool) -> Result<(), String> {
    let mut inner = store.inner.lock().unwrap();
    if starred {
        inner.index.starred.insert(id, Local::now().timestamp_millis());
    } else {
        inner.index.starred.remove(&id);
    }
    store.write_index(&inner.index)
}

#[tauri::command]
pub fn prompt_mark_used(store: State<Store>, id: String) -> Result<i64, String> {
    let mut inner = store.inner.lock().unwrap();
    let now = Local::now().timestamp_millis();
    inner.index.last_used.insert(id, now);
    store.write_index(&inner.index)?;
    Ok(now)
}

#[tauri::command]
pub fn session_get(store: State<Store>) -> Session {
    store.inner.lock().unwrap().index.session.clone()
}

#[tauri::command]
pub fn session_set(store: State<Store>, session: Session) -> Result<(), String> {
    let mut inner = store.inner.lock().unwrap();
    // Restored tabs keep their original ids, so make sure a new tab can't
    // be handed the id of one that hasn't been written yet.
    for id in &session.open {
        if !inner.paths.contains_key(id) {
            inner.reserved.insert(id.clone());
        }
    }
    inner.index.session = session;
    store.write_index(&inner.index)
}

/// Returns the id part of a prompt filename, e.g. `20261028-143205_2` from
/// `20261028-143205_2-fix-auth-bug.md`, or None if it isn't a prompt file.
fn parse_id(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(EXT)?;
    let b = stem.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if b.len() < 15 || !digits(0..8) || b[8] != b'-' || !digits(9..15) {
        return None;
    }
    let mut end = 15;
    if b.get(end) == Some(&b'_') {
        let start = end + 1;
        end = start + b[start..].iter().take_while(|c| c.is_ascii_digit()).count();
        if end == start {
            return None;
        }
    }
    match b.get(end) {
        None | Some(b'-') => Some(&stem[..end]),
        _ => None,
    }
}

fn file_name(id: &str, slug: &str) -> String {
    if slug.is_empty() {
        format!("{id}{EXT}")
    } else {
        format!("{id}-{slug}{EXT}")
    }
}

fn first_line(content: &str) -> &str {
    content.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

fn first_line_finished(content: &str) -> bool {
    let line = first_line(content);
    !line.is_empty()
        && content
            .find(line)
            .is_some_and(|i| content[i + line.len()..].contains('\n'))
}

/// `## Fix the auth bug!` -> `fix-the-auth-bug`
fn slug(content: &str) -> String {
    let mut out = String::new();
    for c in first_line(content).trim_start_matches(['#', '>', '-', '*', ' ']).chars() {
        if out.chars().count() >= SLUG_MAX_CHARS {
            break;
        }
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

fn created_ms(id: &str) -> i64 {
    NaiveDateTime::parse_from_str(id.get(..15).unwrap_or(id), "%Y%m%d-%H%M%S")
        .ok()
        .and_then(|dt| Local.from_local_datetime(&dt).earliest())
        .map_or(0, |dt| dt.timestamp_millis())
}

/// Write to a temp file and rename over the target, so a crash mid-save
/// never leaves a half-written prompt.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ids() {
        assert_eq!(parse_id("20261028-143205.md"), Some("20261028-143205"));
        assert_eq!(parse_id("20261028-143205-fix-auth.md"), Some("20261028-143205"));
        assert_eq!(parse_id("20261028-143205_2.md"), Some("20261028-143205_2"));
        assert_eq!(parse_id("20261028-143205_12-2-things.md"), Some("20261028-143205_12"));
        assert_eq!(parse_id("20261028-143205_-x.md"), None);
        assert_eq!(parse_id("20261028-143205x.md"), None);
        assert_eq!(parse_id("20261028-143205.txt"), None);
        assert_eq!(parse_id("notes.md"), None);
        assert_eq!(parse_id(".20261028-143205.md.tmp"), None);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("## Fix the auth bug!\nmore"), "fix-the-auth-bug");
        assert_eq!(slug("\n\n  git push --force-with-lease  \n"), "git-push-force-with-lease");
        assert_eq!(slug("Résumé: naïve café"), "résumé-naïve-café");
        assert_eq!(slug("???"), "");
        assert_eq!(slug(""), "");
        assert_eq!(slug(&"a".repeat(100)).len(), SLUG_MAX_CHARS);
    }

    #[test]
    fn first_line_settles_after_newline() {
        assert!(!first_line_finished("fix the"));
        assert!(!first_line_finished("\n\nfix the"));
        assert!(first_line_finished("fix the bug\n"));
        assert!(first_line_finished("\nfix the bug\nand more"));
    }

    #[test]
    fn created_time_comes_from_id() {
        let expected = Local
            .with_ymd_and_hms(2026, 10, 28, 14, 32, 5)
            .unwrap()
            .timestamp_millis();
        assert_eq!(created_ms("20261028-143205"), expected);
        assert_eq!(created_ms("20261028-143205_3"), expected);
    }

    #[test]
    fn save_rename_close_lifecycle() {
        let dir = std::env::temp_dir().join(format!("pastable-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone()).unwrap();
        let mut inner = store.inner.lock().unwrap();
        let id = "20261028-143205";

        // Empty content never creates a file.
        assert!(store.save(&mut inner, id, "  \n", false).unwrap().is_none());

        // No slug until the first line is finished.
        let p = store.save(&mut inner, id, "fix", false).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205.md");
        let p = store.save(&mut inner, id, "fix the bug", false).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205.md");

        // Once the line is finished, the slug follows it.
        let p = store.save(&mut inner, id, "fix the bug\nnow", false).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205-fix-the-bug.md");
        assert_eq!(fs::read_to_string(&p).unwrap(), "fix the bug\nnow");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // Ids that could escape the folder are refused.
        assert!(store.save(&mut inner, "../20261028-143205", "x", false).is_err());

        // A final save always renames.
        let p = store.save(&mut inner, id, "deploy", true).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205-deploy.md");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // A name takes over the slug, even before the first line is finished.
        inner.index.names.insert(id.to_string(), "Ship it!".to_string());
        let p = store.save(&mut inner, id, "deploy the", false).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205-ship-it.md");
        inner.index.names.remove(id);
        let p = store.save(&mut inner, id, "deploy", true).unwrap().unwrap();
        assert_eq!(p.file_name().unwrap(), "20261028-143205-deploy.md");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        drop(inner);
        let reopened = Store::open(dir.clone()).unwrap();
        assert_eq!(reopened.inner.lock().unwrap().paths.get(id), Some(&p));
        fs::remove_dir_all(&dir).unwrap();
    }
}
