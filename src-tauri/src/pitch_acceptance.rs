//! Explicit real-music renders; never run implicitly or alter the original.
use std::{fs, io::Write, path::PathBuf, sync::Arc};
use rodio::Source;
use sha2::{Digest, Sha256};

#[test]
#[ignore = "Requires explicit existing music and a new export directory"]
fn render_real_music_without_changing_duration() {
    let input = PathBuf::from(std::env::var_os("RUSTMUSIC_PITCH_INPUT").unwrap());
    let output = PathBuf::from(std::env::var_os("RUSTMUSIC_PITCH_OUTPUT").unwrap());
    assert!(input.is_absolute() && input.is_file() && output.is_absolute() && !output.exists());
    let hash = hex::encode(Sha256::digest(fs::read(&input).unwrap()));
    let decoder = rodio::Decoder::try_from(fs::File::open(&input).unwrap()).unwrap();
    let rate = decoder.sample_rate();
    let channels = decoder.channels();
    let dry: Vec<f32> = decoder.take(rate.get() as usize * channels.get() as usize * 20).collect();
    assert!(dry.len() > rate.get() as usize * channels.get() as usize * 5);
    fs::create_dir(&output).unwrap();
    let mut renders = Vec::new();
    for semitones in [0.0_f32, -2.0, 2.0] {
        let shared = Arc::new(crate::pitch::PitchShared::new());
        shared.set(semitones).unwrap();
        let source = rodio::buffer::SamplesBuffer::new(channels, rate, dry.clone());
        let processed: Vec<f32> = crate::pitch::PitchSource::new(source, shared).collect();
        assert_eq!(processed.len(), dry.len(), "Pitch must not alter playback/lyrics duration");
        assert!(processed.iter().all(|s| s.is_finite()));
        let rms = (processed.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / processed.len() as f64).sqrt();
        assert!(rms > 0.001, "The real music output must not be silent");
        if semitones == 0.0 { assert_eq!(processed, dry, "Zero must preserve original samples"); }
        else { assert!(processed.iter().zip(&dry).any(|(a,b)| (a-b).abs() > 0.001)); }
        let path = output.join(format!("pitch-{semitones:+}.f32"));
        let mut writer = std::io::BufWriter::new(fs::File::create(&path).unwrap());
        for sample in &processed { writer.write_all(&sample.to_le_bytes()).unwrap(); }
        writer.flush().unwrap();
        renders.push(serde_json::json!({"semitones":semitones,"path":path,"samples":processed.len(),"rms":rms}));
    }
    assert_eq!(hex::encode(Sha256::digest(fs::read(&input).unwrap())), hash);
    fs::write(output.join("report.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "passed":true,"source":input,"sourceSha256":hash,"sourceUnchanged":true,
        "sampleRate":rate.get(),"channels":channels.get(),"lengthPreserved":true,
        "zeroExactBypass":true,"renders":renders,"subjectiveQualityVerified":false
    })).unwrap()).unwrap();
}
