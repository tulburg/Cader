// One-time model downloads (S-3, S-4): stream to a .part file, hash as it goes, and move it
// into place only when the SHA-256 matches. Nothing is fetched again once a file is in place.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub struct Remote {
    pub url: &'static str,
    pub file: &'static str, // path under the models folder
    pub sha256: &'static str,
    pub size: u64,
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn present(dir: &Path, files: &[Remote]) -> bool {
    files.iter().all(|f| dir.join(f.file).is_file())
}

// Downloads every missing file; `progress` gets the overall fraction done.
pub fn download_all(dir: &Path, files: &[Remote], progress: impl Fn(f32)) -> Result<(), String> {
    let total: u64 = files.iter().map(|f| f.size).sum();
    let mut done: u64 = files.iter().filter(|f| dir.join(f.file).is_file()).map(|f| f.size).sum();
    let client = reqwest::blocking::Client::builder().timeout(None).build().map_err(|e| e.to_string())?;
    let mut last = Instant::now();
    for f in files {
        let dest = dir.join(f.file);
        if dest.is_file() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let part = dest.with_extension("part");
        let mut resp = client.get(f.url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if last.elapsed() > Duration::from_millis(250) {
                last = Instant::now();
                progress((done as f32 / total as f32).min(1.0));
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if digest != f.sha256 {
            let _ = fs::remove_file(&part);
            return Err(format!("{}: checksum mismatch", f.file));
        }
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    progress(1.0);
    Ok(())
}
