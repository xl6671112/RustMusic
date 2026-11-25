//! Explicit local listening export, never compiled into the application.
use super::*;
use std::{fs::File, io::Write, path::PathBuf};

#[test]
#[ignore = "requires explicit real-song paths and writes listening artifacts"]
fn export_same_song_listening_samples() {
    let input = PathBuf::from(std::env::var_os("RUSTMUSIC_LISTEN_INPUT").expect("input path"));
    let ai = PathBuf::from(std::env::var_os("RUSTMUSIC_LISTEN_AI").expect("HQ_3 output path"));
    let out = PathBuf::from(std::env::var_os("RUSTMUSIC_LISTEN_OUTPUT").expect("output directory"));
    assert!(out.is_absolute() && out.is_dir());
    let load = |path: &PathBuf| {
        let decoder = rodio::Decoder::try_from(File::open(path).unwrap()).unwrap();
        assert_eq!(decoder.channels().get(), 2, "comparison requires unchanged stereo");
        assert_eq!(decoder.sample_rate().get(), 44100, "do not silently resample comparison");
        decoder.take(65 * 44100 * 2).collect::<Vec<f32>>()
    };
    let dry = load(&input);
    let ai_samples = load(&ai);
    let start = 45 * 44100 * 2;
    let end = 65 * 44100 * 2;
    assert_eq!(dry.len(), end);
    assert_eq!(ai_samples.len(), end);
    // Fail instead of exporting a silent missing-plugin fallback.
    RemixHost::open(44100).expect("real Remix plugin must load");
    let mut exports = vec![("original", dry.clone()), ("hq3", ai_samples)];
    for (name, amount) in [("remix-50", 50.0), ("remix-100", 100.0)] {
        let shared = Arc::new(VocalShared::new());
        shared.set(amount).unwrap();
        let source = rodio::buffer::SamplesBuffer::new(
            rodio::ChannelCount::new(2).unwrap(),
            rodio::SampleRate::new(44100).unwrap(),
            dry.clone(),
        );
        let processed: Vec<f32> = VocalSource::new(source, shared).collect();
        assert_eq!(processed.len(), dry.len(), "latency trim must preserve the timeline");
        assert!(processed.iter().zip(&dry).any(|(a,b)| (a-b).abs() > 1e-5),
            "wet export must not silently equal original audio");
        exports.push((name, processed));
    }
    for (name, data) in exports {
        let excerpt = &data[start..end];
        assert!(excerpt.iter().all(|s| s.is_finite()));
        assert!(excerpt.iter().any(|s| s.abs() > 0.01), "listening excerpt must contain audio");
        let mut file = File::create(out.join(format!("{name}.f32"))).unwrap();
        for value in excerpt { file.write_all(&value.to_le_bytes()).unwrap(); }
    }
}

#[test]
#[ignore = "requires an explicit full-song input and real Remix plugin; writes listening artifacts"]
fn export_full_song_remix() {
    use sha2::{Digest, Sha256};
    use std::io::BufWriter;

    let input = PathBuf::from(std::env::var_os("RUSTMUSIC_LISTEN_INPUT").expect("input path"));
    let out = PathBuf::from(std::env::var_os("RUSTMUSIC_LISTEN_OUTPUT").expect("output directory"));
    assert!(input.is_absolute() && input.is_file());
    assert!(out.is_absolute() && out.is_dir());
    let source_hash = hex::encode(Sha256::digest(std::fs::read(&input).unwrap()));
    let decoder = rodio::Decoder::try_from(File::open(&input).unwrap()).unwrap();
    assert_eq!(decoder.channels().get(), 2, "keep the comparison source stereo");
    let sample_rate = decoder.sample_rate();
    let dry: Vec<f32> = decoder.collect();
    assert!(!dry.is_empty() && dry.len() % 2 == 0, "decode the complete stereo song");
    assert!(dry.iter().all(|s| s.is_finite()));
    // Use a successfully opened host directly, so this export cannot fall back to dry audio.
    let host = RemixHost::open(sample_rate.get()).expect("real Remix plugin must load");
    let latency_frames = host.latency();
    let shared = Arc::new(VocalShared::new());
    shared.set(100.0).unwrap();
    let source = rodio::buffer::SamplesBuffer::new(
        rodio::ChannelCount::new(2).unwrap(),
        sample_rate,
        dry.clone(),
    );
    let processed: Vec<f32> = VocalSource::with_host(source, shared, Some(host)).collect();
    assert_eq!(processed.len(), dry.len(), "latency compensation must retain the complete timeline");
    assert!(processed.iter().all(|s| s.is_finite()), "export must not contain invalid samples");
    assert!(processed.iter().zip(&dry).any(|(a, b)| (a - b).abs() > 1e-5),
        "100-strength export must actually process the original audio");
    let rms = (processed.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>()
        / processed.len() as f64).sqrt();
    let peak = processed.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
    assert!(rms > 0.001, "the complete instrumental must contain audible signal");
    let output = out.join("remix-100.f32");
    let mut writer = BufWriter::new(
        File::options().write(true).create_new(true).open(&output).unwrap()
    );
    for sample in &processed {
        writer.write_all(&sample.to_le_bytes()).unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    assert_eq!(hex::encode(Sha256::digest(std::fs::read(&input).unwrap())), source_hash,
        "rendering must preserve the source file");
    let report = serde_json::json!({
        "passed": true, "source": input, "sourceSha256": source_hash, "output": output,
        "outputSha256": hex::encode(Sha256::digest(std::fs::read(&output).unwrap())),
        "format": "little-endian float32 interleaved", "sampleRate": sample_rate.get(), "channels": 2,
        "frames": processed.len() / 2,
        "durationSeconds": processed.len() as f64 / (f64::from(sample_rate.get()) * 2.0),
        "strength": 100, "pluginLatencyFrames": latency_frames,
        "lengthPreserved": true, "allFinite": true, "nonSilent": true, "differsFromOriginal": true,
        "sourceUnchanged": true, "rms": rms, "peak": peak, "subjectiveQualityVerified": false
    });
    let mut report_file = File::options().write(true).create_new(true)
        .open(out.join("report-remix-full.json")).unwrap();
    serde_json::to_writer_pretty(&mut report_file, &report).unwrap();
    report_file.write_all(b"\n").unwrap();
    println!("{report}");
}
