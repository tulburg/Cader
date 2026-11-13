// The document library (S-1): one folder per document under ~/Cader (or $CADER_LIBRARY),
// each holding meta.json and text.md. The UI reaches it only through the commands below.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: String,
    pub title: String,
    pub kind: String,   // "speech" | "blog"
    pub status: String, // "draft" | "saved" (D-7)
    pub created: u64,   // ms since epoch
    pub updated: u64,
    #[serde(default)]
    pub sample: bool, // the seeded example document, which carries sample suggestions
    #[serde(default)]
    pub saved_n: u32, // the latest saved version (S-9 Req 6); 0 when never saved
    #[serde(default)]
    pub saved_at: u64,
}

#[derive(Serialize)]
pub struct Doc {
    pub meta: DocMeta,
    pub text: String,
}

const SAMPLE_TITLE: &str = "Remarks for the Riverside Library Opening";
const SAMPLE_TEXT: &str = "Good evening, and thank you all for coming. When this building first opened its doors in 1962, the town was smaller, the river was cleaner, and the idea of a public library was very important to the families who lived here.\n\nTonight we are not just reopening a building. We are keeping a promise that was made to every child who ever sat cross-legged on that carpet and found a world inside a book.\n\nThe people who has worked on this renovation gave more than their time. They gave their weekends, their patience, and in a few cases, their actual blood, sweat and tears when the old shelves came down.\n\nSo let me begin with a simple thank you to the volunteers\n";

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn root() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CADER_LIBRARY") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join("Cader"))
}

// Ids are generated here and must stay plain so a command can never reach outside the library.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!("Invalid document id: {id}"));
    }
    Ok(())
}

fn slug(title: &str) -> String {
    let mut s = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 40 {
            break;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "untitled".into() } else { s }
}

fn base36(mut n: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub(crate) fn doc_dir(id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    let dir = root()?.join(id);
    if !dir.join("meta.json").is_file() {
        return Err(format!("No document {id}"));
    }
    Ok(dir)
}

fn read_meta(dir: &Path) -> Result<DocMeta, String> {
    let raw = fs::read_to_string(dir.join("meta.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_meta(dir: &Path, meta: &DocMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("meta.json"), &raw)
}

// Write to a temp file and rename, so a crash never leaves a half-written file.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn new_doc(title: &str, kind: &str, text: &str, sample: bool) -> Result<DocMeta, String> {
    if kind != "speech" && kind != "blog" {
        return Err(format!("Unknown kind: {kind}"));
    }
    let title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
    let t = now();
    let id = format!("{}-{}", slug(title), base36(t));
    let dir = root()?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let meta = DocMeta { id, title: title.into(), kind: kind.into(), status: "draft".into(), created: t, updated: t, sample, saved_n: 0, saved_at: 0 };
    write_atomic(&dir.join("text.md"), text)?;
    write_meta(&dir, &meta)?;
    Ok(meta)
}

#[tauri::command]
pub fn list_docs() -> Result<Vec<DocMeta>, String> {
    let root = root()?;
    if !root.exists() {
        // First run: create the library with one example to try the review flow on.
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        new_doc(SAMPLE_TITLE, "speech", SAMPLE_TEXT, true)?;
    }
    let mut docs = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !path.join("meta.json").is_file() {
            continue;
        }
        if let Ok(meta) = read_meta(&path) {
            docs.push(meta);
        }
    }
    docs.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(docs)
}

#[tauri::command]
pub fn create_doc(title: String, kind: String) -> Result<DocMeta, String> {
    new_doc(&title, &kind, "", false)
}

#[tauri::command]
pub fn open_doc(id: String) -> Result<Doc, String> {
    let dir = doc_dir(&id)?;
    let meta = read_meta(&dir)?;
    let text = fs::read_to_string(dir.join("text.md")).unwrap_or_default();
    Ok(Doc { meta, text })
}

// Autosave of the working text (S-8 Req 5). It reads as saved only while it matches the latest
// saved version (S-9).
#[tauri::command]
pub fn save_text(id: String, text: String) -> Result<DocMeta, String> {
    let dir = doc_dir(&id)?;
    let saved = crate::versions::latest_text(&dir).is_some_and(|t| t == text);
    store_text(&id, &text, Some(if saved { "saved" } else { "draft" }))
}

pub(crate) fn store_text(id: &str, text: &str, status: Option<&str>) -> Result<DocMeta, String> {
    store(id, text, status, None)
}

// Store the working text, and with `saved` record it as saved version (n, time).
pub(crate) fn store(id: &str, text: &str, status: Option<&str>, saved: Option<(u32, u64)>) -> Result<DocMeta, String> {
    let dir = doc_dir(id)?;
    let mut meta = read_meta(&dir)?;
    write_atomic(&dir.join("text.md"), text)?;
    if let Some(s) = status {
        meta.status = s.into();
    }
    if let Some((n, t)) = saved {
        meta.saved_n = n;
        meta.saved_at = t;
    }
    meta.updated = now();
    write_meta(&dir, &meta)?;
    Ok(meta)
}

#[tauri::command]
pub fn rename_doc(id: String, title: String) -> Result<DocMeta, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("A title cannot be empty".into());
    }
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir)?;
    meta.title = title.into();
    meta.updated = now();
    write_meta(&dir, &meta)?;
    Ok(meta)
}

// Deleting moves the folder to the library's .trash, so it can be recovered by hand.
#[tauri::command]
pub fn delete_doc(id: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    let trash = root()?.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    fs::rename(&dir, trash.join(format!("{}-{}", id, base36(now())))).map_err(|e| e.to_string())
}

// Tests share the CADER_LIBRARY variable, so they run one at a time.
#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn with_test_library<F: FnOnce(&Path)>(f: F) {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("cader-test-{}", base36(now())));
    std::env::set_var("CADER_LIBRARY", &dir);
    f(&dir);
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_library<F: FnOnce(&Path)>(f: F) {
        with_test_library(f)
    }

    #[test]
    fn first_run_seeds_the_sample() {
        with_library(|_| {
            let docs = list_docs().unwrap();
            assert_eq!(docs.len(), 1);
            assert!(docs[0].sample);
            assert_eq!(docs[0].kind, "speech");
        });
    }

    #[test]
    fn create_open_save_rename_delete() {
        with_library(|lib| {
            list_docs().unwrap();
            // Same-millisecond timestamps would tie with the seeded sample in the sort.
            std::thread::sleep(std::time::Duration::from_millis(5));
            let m = create_doc("My first post!".into(), "blog".into()).unwrap();
            assert!(m.id.starts_with("my-first-post-"));
            assert!(lib.join(&m.id).join("meta.json").is_file());
            assert_eq!(list_docs().unwrap()[0].id, m.id);

            save_text(m.id.clone(), "Hello.\n\nWorld.".into()).unwrap();
            assert_eq!(open_doc(m.id.clone()).unwrap().text, "Hello.\n\nWorld.");

            let r = rename_doc(m.id.clone(), "  Renamed  ".into()).unwrap();
            assert_eq!(r.title, "Renamed");
            assert!(rename_doc(m.id.clone(), " ".into()).is_err());

            delete_doc(m.id.clone()).unwrap();
            assert!(!lib.join(&m.id).exists());
            assert_eq!(fs::read_dir(lib.join(".trash")).unwrap().count(), 1);
            assert_eq!(list_docs().unwrap().len(), 1);
        });
    }

    #[test]
    fn ids_cannot_escape_the_library() {
        with_library(|_| {
            for bad in ["../etc", "a/b", "", "UP", ".trash"] {
                assert!(open_doc(bad.into()).is_err(), "{bad} should be refused");
                assert!(delete_doc(bad.into()).is_err());
            }
            assert!(create_doc("x".into(), "novel".into()).is_err());
        });
    }
}
