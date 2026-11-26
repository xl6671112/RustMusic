fn main() {
    embed_remix_assets();
    embed_folia_workers();
    embed_jizura_assets();
    #[cfg(windows)]
    build_studio_one_bridge();
    #[cfg(windows)]
    build_ai_inference_bridge();
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch/");
    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .opt_level(2)
        .file("vendor/signalsmith-stretch/bridge.cpp")
        .include("vendor/signalsmith-stretch")
        .include("vendor/signalsmith-stretch/include")
        .compile("rustmusic_pitch");
    // 图标变化时强制重新嵌入资源（默认 Cargo 不监视 icons/，
    // 重新生成的 .ico 不会进 exe，运行中的窗口/托盘仍是旧图标）
    println!("cargo:rerun-if-changed=icons/");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows-app-manifest.xml")),
        ),
    )
    .expect("build player resources")
}

fn embed_remix_assets() {
    println!("cargo:rerun-if-env-changed=RUSTMUSIC_REMIX_ASSETS");
    println!("cargo:rerun-if-env-changed=RUSTMUSIC_REQUIRE_REMIX");
    let directory = std::env::var_os("RUSTMUSIC_REMIX_ASSETS").map(std::path::PathBuf::from);
    let plugin = directory.as_ref().map(|root| root.join("Remix.dll"))
        .unwrap_or_else(|| std::path::PathBuf::from("C:/Program Files/VstPlugIns/Acon Digital/Remix.dll"));
    let models = directory.unwrap_or_else(|| std::path::PathBuf::from("C:/ProgramData/Acon Digital/AIModels"));
    let mut assets = vec![("Remix.dll", plugin)];
    for name in ["VocalsSeparation.hance", "PianoSeparation.hance", "BassSeparation.hance", "DrumsSeparation.hance"] {
        assets.push((name, models.join(name)));
    }
    let available = cfg!(windows) && assets.iter().all(|(_, path)| path.is_file());
    assert!(available || std::env::var_os("RUSTMUSIC_REQUIRE_REMIX").is_none(), "Missing required licensed Remix plugin/models");
    let mut code = String::from("&[");
    if available {
        for (name, path) in assets {
            println!("cargo:rerun-if-changed={}", path.display());
            let path = path.canonicalize().expect("Remix asset path");
            let modified = std::fs::metadata(&path).expect("Remix asset metadata").modified().expect("Remix asset time")
                .duration_since(std::time::UNIX_EPOCH).expect("Remix asset timestamp").as_millis();
            code.push_str(&format!("({name:?}, include_bytes!({:?}) as &[u8], {modified}),\n", path.to_string_lossy()));
        }
    }
    code.push(']');
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output"));
    std::fs::write(output.join("remix-assets.rs"), code).expect("Embed Remix assets");
}

fn embed_jizura_assets() {
    let directory = std::path::Path::new("../jizura-overlay/dist");
    println!("cargo:rerun-if-changed=../jizura-overlay/dist");
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .expect("Build JIZURA assets with npm run build:jizura before compiling")
        .map(|entry| entry.expect("Read JIZURA asset").path())
        .filter(|path| path.is_file() && matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("engine.js" | "timeline.js" | "runtime.js" | "runtime.css" | "catalog.json" | "manifest.json")
        ))
        .collect();
    entries.sort();
    let mut code = String::from("&[");
    for path in entries {
        println!("cargo:rerun-if-changed={}", path.display());
        let name = path.file_name().expect("JIZURA asset name").to_string_lossy();
        let path = path.canonicalize().expect("JIZURA asset path");
        code.push_str(&format!("({name:?}, include_bytes!({:?})),\n", path.to_string_lossy()));
    }
    code.push(']');
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output"));
    std::fs::write(output.join("jizura-assets.rs"), code).expect("Embed JIZURA assets");
}

fn embed_folia_workers() {
    let directory = std::path::Path::new("../folia-overlay/dist/assets");
    println!("cargo:rerun-if-changed=../folia-overlay/dist");
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "js"))
        .collect();
    entries.sort();
    let mut code = String::from("&[");
    for path in entries {
        let name = path.file_name().expect("Folia worker name").to_string_lossy();
        let path = path.canonicalize().expect("Folia worker path");
        code.push_str(&format!("({name:?}, include_bytes!({:?})),\n", path.to_string_lossy()));
    }
    code.push(']');
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output"));
    std::fs::write(output.join("folia-workers.rs"), code).expect("embed Folia workers");
}

#[cfg(windows)]
fn build_studio_one_bridge() {
    use std::path::PathBuf;
    println!("cargo:rerun-if-changed=native/studioone/");
    println!("cargo:rerun-if-changed=vendor/vst3/pluginterfaces/");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let profile = out.ancestors().nth(3).expect("Cargo profile directory");
    let compiler = cc::Build::new().cpp(true).get_compiler();
    let dll = out.join("rustmusic-studioone-bridge.dll");
    let status = compiler
        .to_command()
        .args([
            "/nologo",
            "/LD",
            "/EHsc",
            "/std:c++17",
            "/O2",
            "/utf-8",
            "/MT",
            "/Ivendor/vst3",
        ])
        .arg("native/studioone/bridge.cpp")
        .arg(format!("/Fo{}", out.join("studioone-bridge.obj").display()))
        .arg("/link")
        .arg("user32.lib")
        .arg("kernel32.lib")
        .arg(format!("/OUT:{}", dll.display()))
        .arg(format!(
            "/IMPLIB:{}",
            out.join("studioone-bridge.lib").display()
        ))
        .status()
        .expect("start Studio One bridge compiler");
    assert!(status.success(), "Studio One bridge compilation failed");
    std::fs::copy(&dll, profile.join("rustmusic-studioone-bridge.dll"))
        .expect("copy Studio One bridge");
}

#[cfg(windows)]
fn build_ai_inference_bridge() {
    use std::path::PathBuf;
    println!("cargo:rerun-if-changed=native/ai/");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let profile = out.ancestors().nth(3).expect("Cargo profile directory");
    let compiler = cc::Build::new().cpp(true).get_compiler();
    let dll = out.join("rustmusic-ai-inference.dll");
    let status = compiler
        .to_command()
        .args([
            "/nologo",
            "/LD",
            "/EHsc",
            "/std:c++17",
            "/O2",
            "/utf-8",
            "/MT",
            "/Inative/ai/onnxruntime",
        ])
        .arg("native/ai/inference_bridge.cpp")
        .arg(format!("/Fo{}", out.join("ai-inference.obj").display()))
        .arg("/link")
        .arg(format!("/OUT:{}", dll.display()))
        .arg(format!(
            "/IMPLIB:{}",
            out.join("rustmusic-ai-inference.lib").display()
        ))
        .status()
        .expect("start AI inference bridge compiler");
    assert!(status.success(), "AI inference bridge compilation failed");
    std::fs::copy(&dll, profile.join("rustmusic-ai-inference.dll"))
        .expect("copy AI inference bridge");
}
