use std::path::{Path, PathBuf};

const ASSETS: &[(&str, &[u8], u64)] = include!(concat!(env!("OUT_DIR"), "/remix-assets.rs"));

pub fn is_embedded() -> bool { !ASSETS.is_empty() }

fn ensure_file(path: &Path, bytes: &[u8], modified_ms: u64) -> Result<(), String> {
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_millis(modified_ms);
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() == bytes.len() as u64
        && metadata.modified().is_ok_and(|time| time == modified))
        && std::fs::read(path).is_ok_and(|existing| existing == bytes) { return Ok(()); }
    let parent = path.parent().ok_or("Missing Remix installation directory")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = std::fs::write(&temporary, bytes)
        .and_then(|_| std::fs::File::options().write(true).open(&temporary)?.set_times(std::fs::FileTimes::new().set_modified(modified)))
        .and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|error| format!("{}: {error}", path.display()))
}

fn install_to(plugin_dir: &Path, model_dir: &Path) -> Result<PathBuf, String> {
    if ASSETS.len() != 5 { return Err("This build does not contain the Remix plugin and its four realtime models".into()); }
    for (name, bytes, modified) in ASSETS {
        let destination = if *name == "Remix.dll" { plugin_dir } else { model_dir };
        ensure_file(&destination.join(name), bytes, *modified)?;
    }
    Ok(plugin_dir.join("Remix.dll"))
}

#[cfg(windows)]
pub fn prepare() -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::sync::OnceLock;
    static INSTALLED: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let (_, plugin, _) = ASSETS.first().ok_or("This build does not contain Remix assets")?;
        let version = hex::encode(Sha256::digest(plugin));
        install_to(&known_folder(0x1c)?.join("RustMusic/Runtime/Remix").join(&version[..16]),
            &known_folder(0x23)?.join("Acon Digital/AIModels"))
    }).clone()
}

#[cfg(windows)]
fn known_folder(id: i32) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetFolderPathW(window: *mut std::ffi::c_void, folder: i32,
            token: *mut std::ffi::c_void, flags: u32, path: *mut u16) -> i32;
    }
    let mut buffer = [0u16; 260];
    let result = unsafe { SHGetFolderPathW(std::ptr::null_mut(), id, std::ptr::null_mut(), 0, buffer.as_mut_ptr()) };
    if result < 0 { return Err(format!("Cannot locate Remix installation directory: {result:#x}")); }
    let length = buffer.iter().position(|unit| *unit == 0).ok_or("Invalid Remix installation directory")?;
    Ok(std::ffi::OsString::from_wide(&buffer[..length]).into())
}

#[cfg(not(windows))]
pub fn prepare() -> Result<PathBuf, String> { Err("Remix is supported only on Windows".into()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_repairs_missing_or_partial_dependencies_and_leaves_complete_files_untouched() {
        let root = std::env::temp_dir().join(format!("rustmusic-remix-assets-{}", std::process::id()));
        let path = root.join("models/VocalsSeparation.hance");
        let time = 1_700_000_000_000;
        ensure_file(&path, b"complete-model", time).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        ensure_file(&path, b"complete-model", time).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified,
            "unchanged dependencies must not be rewritten on each startup");
        std::fs::write(&path, b"partial").unwrap();
        ensure_file(&path, b"complete-model", time).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"complete-model",
            "an interrupted extraction must be repaired before plugin startup");
        std::fs::remove_file(&path).unwrap();
        ensure_file(&path, b"complete-model", time).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"complete-model");
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH)).unwrap();
        ensure_file(&path, b"complete-model", time).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified,
            "a changed timestamp must be repaired even when size and content are unchanged");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1,
            "successful extraction must not leave temporary model files");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn embedded_runtime_can_be_recovered_from_the_executable_alone() {
        if !is_embedded() { return; }
        let root = std::env::temp_dir().join(format!("rustmusic-remix-embedded-{}", std::process::id()));
        let plugin = install_to(&root.join("plugins"), &root.join("models")).unwrap();
        assert!(plugin.is_file());
        for (name, bytes, _) in ASSETS {
            let folder = if *name == "Remix.dll" { "plugins" } else { "models" };
            assert_eq!(std::fs::read(root.join(folder).join(name)).unwrap(), *bytes,
                "every embedded dependency must extract without an existing Remix installation");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
