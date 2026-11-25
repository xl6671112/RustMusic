//! Offline chroma/profile analysis. Never consumes or seeks the playing decoder.
use crate::{db, engine, fx::Fft, AppState};
use rodio::{source::UniformSourceIterator, Source};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tauri::Manager;

const RATE: u32 = 11025;
const WIN: usize = 8192;
const MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub root: u8,
    pub scale: String,
    pub score: f32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
    pub path: String,
    pub candidates: Vec<Candidate>,
    pub needs_confirmation: bool,
    pub analyzed_seconds: f32,
    #[serde(default)]
    pub pending: bool,
}

fn rank(chroma: &[f32; 12]) -> Vec<Candidate> {
    let correlation = |profile: &[f32; 12], root: usize| {
        let mean = chroma.iter().sum::<f32>() / 12.0;
        let pm = profile.iter().sum::<f32>() / 12.0;
        let (mut dot, mut a, mut b) = (0.0, 0.0, 0.0);
        for n in 0..12 {
            let x = chroma[(n + root) % 12] - mean;
            let y = profile[n] - pm;
            dot += x * y; a += x * x; b += y * y;
        }
        dot / (a * b).sqrt().max(1e-12)
    };
    let mut out = Vec::new();
    for root in 0..12 {
        for (scale, profile) in [("major", &MAJOR), ("minor", &MINOR)] {
            out.push(Candidate { root: root as u8, scale: scale.into(), score: correlation(profile, root) });
        }
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out.truncate(3);
    out
}

fn accumulate(samples: &[f32], fft: &Fft, chroma: &mut [f32; 12]) -> usize {
    let mut re = vec![0.0; WIN];
    let mut im = vec![0.0; WIN];
    let mut frames = 0;
    for start in (0..samples.len().saturating_sub(WIN - 1)).step_by(WIN / 4) {
        let chunk = &samples[start..start + WIN];
        if chunk.iter().map(|x| x * x).sum::<f32>() / (WIN as f32) < 1e-8 { continue; }
        for (i, x) in chunk.iter().enumerate() {
            re[i] = x * (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / WIN as f32).cos());
        }
        im.fill(0.0);
        fft.run(&mut re, &mut im);
        let magnitude: Vec<f32> = re.iter().zip(&im).take(WIN / 2).map(|(r, i)| (r * r + i * i).sqrt()).collect();
        let mut frame = [0.0_f32; 12];
        // Interpolate spectral peaks; exclude broad percussion and very high harmonics.
        for bin in 45..((2000.0 * WIN as f32 / RATE as f32) as usize) {
            let (a, b, c) = (magnitude[bin - 1], magnitude[bin], magnitude[bin + 1]);
            if b <= a || b <= c { continue; }
            let delta = (0.5 * (a - c) / (a - 2.0 * b + c)).clamp(-0.5, 0.5);
            let hz = (bin as f32 + delta) * RATE as f32 / WIN as f32;
            let midi = 69.0 + 12.0 * (hz / 440.0).log2();
            let distance = (midi - midi.round()).abs();
            if distance > 0.35 { continue; }
            let note = (midi.round() as i32).rem_euclid(12) as usize;
            frame[note] += b.sqrt() * (1.0 - distance / 0.5);
        }
        let sum = frame.iter().sum::<f32>();
        if sum > 1e-6 {
            for n in 0..12 { chroma[n] += frame[n] / sum; }
            frames += 1;
        }
    }
    frames
}

pub(crate) fn analyze(path: &str, duration_ms: u64) -> Result<KeyResult, String> {
    let mut source = engine::open_playable_source(path, 0)?;
    let duration = source.total_duration().map(|d| d.as_millis() as u64).unwrap_or(duration_ms);
    let fft = Fft::new(WIN);
    let mut chroma = [0.0; 12];
    let (mut frames, mut samples) = (0, 0);
    let span = duration.saturating_sub(10_000);
    for (index, at) in [0, span / 3, span * 2 / 3, span].into_iter().enumerate() {
        if index > 0 && (span == 0 || source.try_seek(Duration::from_millis(at)).is_err()) { break; }
        let audio: Vec<f32> = UniformSourceIterator::new(
            &mut source, 1.try_into().unwrap(), RATE.try_into().unwrap(),
        ).take(RATE as usize * 10).collect();
        samples += audio.len();
        frames += accumulate(&audio, &fft, &mut chroma);
    }
    if frames < 3 { return Err("有效音乐片段不足，无法可靠识别调性；请手动选择。".into()); }
    let candidates = rank(&chroma);
    let needs_confirmation = candidates[0].score < 0.65 || candidates[0].score - candidates[1].score < 0.06;
    Ok(KeyResult { path: path.into(), candidates, needs_confirmation, analyzed_seconds: samples as f32 / RATE as f32, pending: false })
}

fn analyze_window(path: &str, position_ms: u64) -> Result<KeyResult, String> {
    let mut source = engine::open_playable_source(path, 0)?;
    source.try_seek(Duration::from_millis(position_ms)).map_err(|e| e.to_string())?;
    let samples: Vec<f32> = UniformSourceIterator::new(
        &mut source, 1.try_into().unwrap(), RATE.try_into().unwrap(),
    ).take(RATE as usize * 5).collect();
    let mut chroma = [0.0; 12];
    if accumulate(&samples, &Fft::new(WIN), &mut chroma) < 3 {
        return Err("当前片段有效音乐不足，保留上次调性".into());
    }
    let candidates = rank(&chroma);
    let needs_confirmation = candidates[0].score < 0.65 || candidates[0].score - candidates[1].score < 0.06;
    Ok(KeyResult { path: path.into(), candidates, needs_confirmation,
        analyzed_seconds: samples.len() as f32 / RATE as f32, pending: false })
}

#[tauri::command]
pub async fn detect_track_key(app: tauri::AppHandle, expected_path: String, force: bool, position_ms: Option<u64>) -> Result<KeyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {

        let state = app.state::<AppState>();
        let current = state.engine.snapshot().ok_or("当前没有歌曲")?;
        if current.state.info.path != expected_path { return Err("歌曲已切换".into()); }
        let meta = match Path::new(&expected_path).metadata() {
            Ok(meta) if !expected_path.ends_with(".part") => meta,
            _ if current.state.info.kind != "track" => return Ok(KeyResult {
                path: expected_path, candidates: vec![], needs_confirmation: true,
                analyzed_seconds: 0.0, pending: true,
            }),
            _ => return Err("本地音源文件不存在或尚未完成".into()),
        };
        let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        if let Some(position) = position_ms {
            return analyze_window(&expected_path, position);
        }
        let cache_key = format!("tonality_v1:{expected_path}:{}:{stamp}", meta.len());
        if !force {
            if let Some(raw) = db::get_setting(&state.db.lock(), &cache_key) {
                if let Ok(result) = serde_json::from_str::<KeyResult>(&raw) { return Ok(result); }
            }
        }
        let result = analyze(&expected_path, current.state.info.duration_ms)?;
        db::set_setting(&state.db.lock(), &cache_key, &serde_json::to_string(&result).map_err(|e| e.to_string())?);
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    fn write_fixture_wav(path: &Path) {
        let frames = RATE as usize * 32;
        let data_len = (frames * 2) as u32;
        let mut file = fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&RATE.to_le_bytes()).unwrap();
        file.write_all(&(RATE * 2).to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_len.to_le_bytes()).unwrap();
        for i in 0..frames {
            let sample = (0..12).map(|n| {
                let hz = 440.0 * 2_f32.powf((48.0 + n as f32 - 69.0) / 12.0);
                let weight = MAJOR[n].powi(2) / 1000.0;
                (i as f32 * std::f32::consts::TAU * hz / RATE as f32).sin() * weight
            }).sum::<f32>();
            file.write_all(&((sample * i16::MAX as f32) as i16).to_le_bytes()).unwrap();
        }
    }

    #[test]
    fn full_file_analysis_identifies_a_major_key_from_decoded_audio() {
        let path = std::env::temp_dir().join(format!("rustmusic-tonality-{}.wav", std::process::id()));
        write_fixture_wav(&path);
        let analysis = analyze(path.to_str().unwrap(), 32_000);
        let local = analyze_window(path.to_str().unwrap(), 10_000).unwrap();
        assert_eq!((local.candidates[0].root, local.candidates[0].scale.as_str()), (0, "major"));
        assert_eq!(local.analyzed_seconds, 5.0, "Live tracking must analyze the requested window rather than reuse the whole-song key");
        let _ = fs::remove_file(&path);
        let result = analysis.unwrap();

        assert_eq!((result.candidates[0].root, result.candidates[0].scale.as_str()), (0, "major"));
        assert!(result.analyzed_seconds >= 20.0, "Analysis must use multiple separated sections of the decoded track");
        assert!(!result.needs_confirmation, "A clear synthetic key should not require manual confirmation");
    }

    #[test]
    fn every_major_minor_profile_retains_its_root_and_mode() {
        for root in 0..12 { for (scale, profile) in [("major", MAJOR), ("minor", MINOR)] {
            let chroma = std::array::from_fn(|n| profile[(n + 12 - root) % 12]);
            let result = rank(&chroma);
            assert_eq!((result[0].root as usize, result[0].scale.as_str()), (root, scale), "Transposition must preserve scale mode");
        }}
    }
    #[test]
    fn silence_and_noise_do_not_claim_a_confident_key() {
        let fft = Fft::new(WIN);
        assert_eq!(accumulate(&vec![0.0; WIN * 3], &fft, &mut [0.0; 12]), 0);
        let flat = rank(&[1.0; 12]);
        assert!(flat[0].score < 0.65);
    }
    #[test]
    fn spectral_peaks_follow_an_octave_without_changing_pitch_class() {
        let fft = Fft::new(WIN);
        for hz in [261.626, 523.251] {
            let samples: Vec<_> = (0..WIN * 3).map(|i| (i as f32 * std::f32::consts::TAU * hz / RATE as f32).sin() * 0.2).collect();
            let mut chroma = [0.0; 12];
            accumulate(&samples, &fft, &mut chroma);
            let best = chroma.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
            assert_eq!(best, 0, "Octaves must both resolve to C, not a neighboring semitone");
        }
    }
    #[test]
    fn polyphonic_profiles_keep_major_minor_and_transposed_roots() {
        let fft = Fft::new(WIN);
        for root in [0, 5, 11] { for (scale, profile) in [("major", MAJOR), ("minor", MINOR)] {
            let samples: Vec<f32> = (0..WIN * 3).map(|i| {
                (0..12).map(|n| {
                    let hz = 440.0 * 2f32.powf((48.0 + root as f32 + n as f32 - 69.0) / 12.0);
                    (i as f32 * std::f32::consts::TAU * hz / RATE as f32).sin() * profile[n].powi(2) / 600.0
                }).sum()
            }).collect();
            let mut chroma = [0.0; 12];
            accumulate(&samples, &fft, &mut chroma);
            let ranked = rank(&chroma);
            assert_eq!((ranked[0].root as usize, ranked[0].scale.as_str()), (root, scale),
                "Spectral analysis must distinguish transposed major/minor profiles");
        }}
    }
}
