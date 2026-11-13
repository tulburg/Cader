// Saved versions (S-8, D-7). Save freezes the working text as the next version in
// <doc>/versions/<n>.json, with the time and the changes made in that review. Saved versions are
// never edited; restoring one copies its text into a new version.

use crate::library::{self, DocMeta};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Change {
    pub kind: String, // grammar, dictation, tighter, wording, sentence, manual, restore
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Version {
    pub n: u32,
    pub time: u64,
    pub text: String,
    pub changes: Vec<Change>,
}

#[derive(Serialize, Clone, Debug)]
pub struct VersionInfo {
    pub n: u32,
    pub time: u64,
    pub changes: Vec<Change>,
}

fn read_all(dir: &Path) -> Result<Vec<Version>, String> {
    let vdir = dir.join("versions");
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&vdir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
            out.push(serde_json::from_str::<Version>(&raw).map_err(|e| format!("{}: {e}", p.display()))?);
        }
    }
    out.sort_by_key(|v| v.n);
    Ok(out)
}

// The text of the latest saved version, if any (used to tell saved from draft). Called on every
// autosave, so it reads only the highest-numbered file.
pub fn latest_text(dir: &Path) -> Option<String> {
    let n = fs::read_dir(dir.join("versions"))
        .ok()?
        .flatten()
        .filter_map(|e| e.path().file_name()?.to_str()?.strip_suffix(".json")?.parse::<u32>().ok())
        .max()?;
    let raw = fs::read_to_string(dir.join("versions").join(format!("{n}.json"))).ok()?;
    serde_json::from_str::<Version>(&raw).ok().map(|v| v.text)
}

fn add(id: &str, text: String, changes: Vec<Change>) -> Result<(VersionInfo, DocMeta), String> {
    let dir = library::doc_dir(id)?;
    let n = read_all(&dir)?.last().map_or(1, |v| v.n + 1);
    let v = Version { n, time: library::now(), text, changes };
    let vdir = dir.join("versions");
    fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;
    let path = vdir.join(format!("{n}.json"));
    if path.exists() {
        return Err(format!("Version {n} already exists"));
    }
    library::write_atomic(&path, &serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)?;
    // The working text becomes the saved text, and the document reads as saved.
    let meta = library::store(id, &v.text, Some("saved"), Some((n, v.time)))?;
    Ok((VersionInfo { n, time: v.time, changes: v.changes }, meta))
}

#[derive(Serialize)]
pub struct Saved {
    pub version: VersionInfo,
    pub meta: DocMeta,
}

#[tauri::command]
pub fn save_version(id: String, text: String, changes: Vec<Change>) -> Result<Saved, String> {
    let (version, meta) = add(&id, text, changes)?;
    Ok(Saved { version, meta })
}

#[tauri::command]
pub fn list_versions(id: String) -> Result<Vec<VersionInfo>, String> {
    let dir = library::doc_dir(&id)?;
    let mut list: Vec<VersionInfo> = read_all(&dir)?.into_iter().map(|v| VersionInfo { n: v.n, time: v.time, changes: v.changes }).collect();
    list.reverse(); // newest first (Req 3)
    Ok(list)
}

#[tauri::command]
pub fn get_version(id: String, n: u32) -> Result<Version, String> {
    let dir = library::doc_dir(&id)?;
    read_all(&dir)?.into_iter().find(|v| v.n == n).ok_or_else(|| format!("No version {n}"))
}

// Restoring copies an old version into a new one, so nothing is lost (Req 4).
#[tauri::command]
pub fn restore_version(id: String, n: u32) -> Result<Saved, String> {
    let old = get_version(id.clone(), n)?;
    let change = Change { kind: "restore".into(), from: String::new(), to: format!("v{n}") };
    let (version, meta) = add(&id, old.text, vec![change])?;
    Ok(Saved { version, meta })
}

// Export a saved version to ~/Downloads as Markdown or plain text, exactly as saved (S-9 Req 5),
// and show it in Finder. Returns the file's path.
#[tauri::command]
pub fn export_version(id: String, n: u32, ext: String) -> Result<String, String> {
    if ext != "md" && ext != "txt" {
        return Err(format!("Unknown export format: {ext}"));
    }
    let v = get_version(id.clone(), n)?;
    let title = library::open_doc(id)?.meta.title;
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = std::env::var("CADER_EXPORTS").map(std::path::PathBuf::from).unwrap_or_else(|_| Path::new(&home).join("Downloads"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = title.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '-' } else { c }).collect();
    let mut path = dir.join(format!("{safe} v{n}.{ext}"));
    let mut k = 2;
    while path.exists() {
        path = dir.join(format!("{safe} v{n} ({k}).{ext}"));
        k += 1;
    }
    fs::write(&path, &v.text).map_err(|e| e.to_string())?;
    #[cfg(not(test))]
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    Ok(path.to_string_lossy().into_owned())
}

// The PDF export prints the page; the print dialog's PDF menu saves it (S-9 Req 5).
#[tauri::command]
pub fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(kind: &str, from: &str, to: &str) -> Change {
        Change { kind: kind.into(), from: from.into(), to: to.into() }
    }

    #[test]
    fn three_passes_then_restore() {
        library::with_test_library(|_| {
            let id = library::create_doc("Versions".into(), "speech".into()).unwrap().id;
            save_version(id.clone(), "One.".into(), vec![]).unwrap();
            save_version(id.clone(), "Two.".into(), vec![change("grammar", "One", "Two")]).unwrap();
            let s3 = save_version(id.clone(), "Three.".into(), vec![change("wording", "Two", "Three"), change("manual", "", "x")]).unwrap();
            assert_eq!(s3.version.n, 3);
            assert_eq!(s3.meta.status, "saved");

            let list = list_versions(id.clone()).unwrap();
            assert_eq!(list.iter().map(|v| v.n).collect::<Vec<_>>(), [3, 2, 1]);
            assert_eq!(list[0].changes.len(), 2);
            assert_eq!(list[1].changes, [change("grammar", "One", "Two")]);
            assert_eq!(latest_text(&library::doc_dir(&id).unwrap()).as_deref(), Some("Three."));

            let r = restore_version(id.clone(), 1).unwrap();
            assert_eq!(r.version.n, 4);
            assert_eq!(get_version(id.clone(), 4).unwrap().text, get_version(id.clone(), 1).unwrap().text);
            assert_eq!(library::open_doc(id.clone()).unwrap().text, "One.");
            assert_eq!(get_version(id.clone(), 3).unwrap().text, "Three.");

            let meta = library::open_doc(id.clone()).unwrap().meta;
            assert_eq!((meta.saved_n, meta.saved_at), (4, get_version(id.clone(), 4).unwrap().time));

            // Markdown export is the saved text, byte for byte.
            let out = std::env::temp_dir().join(format!("cader-export-{}", library::now()));
            std::env::set_var("CADER_EXPORTS", &out);
            let p = export_version(id.clone(), 3, "md".into()).unwrap();
            assert_eq!(fs::read_to_string(&p).unwrap(), "Three.");
            assert!(p.ends_with("Versions v3.md"));
            let p2 = export_version(id.clone(), 3, "md".into()).unwrap();
            assert!(p2.ends_with("Versions v3 (2).md"));
            assert!(export_version(id.clone(), 3, "exe".into()).is_err());
            let _ = fs::remove_dir_all(&out);

            // Editing after a save makes it a draft again; going back to the saved text does not.
            assert_eq!(library::save_text(id.clone(), "One, edited.".into()).unwrap().status, "draft");
            assert_eq!(library::save_text(id.clone(), "One.".into()).unwrap().status, "saved");
        });
    }
}
