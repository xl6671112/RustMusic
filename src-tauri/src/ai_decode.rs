//! Decode with the player's existing native codec stack, streaming to disk.
use rodio::Source;
use lofty::prelude::AudioFile;
use std::{fs, io::{BufWriter, Seek, SeekFrom, Write}, path::{Path, PathBuf}};

pub(super) struct PreparedAudio {
    pub path: PathBuf,
    pub output_subtype: &'static str,
}

impl Drop for PreparedAudio {
    fn drop(&mut self) { let _ = fs::remove_file(&self.path); }
}

pub(super) fn prepare(source: &Path, staging: &Path) -> Result<PreparedAudio, String> {
    let mut decoder = crate::engine::open_playable_source(&source.to_string_lossy(), 0)?;
    let channels = decoder.channels().get();
    let rate = decoder.sample_rate().get();
    let depth = lofty::read_from_path(source).ok().and_then(|tagged| tagged.properties().bit_depth()).unwrap_or(16);
    let output = PreparedAudio {
        path: staging.join(format!("decoded-{}.wav", rand::random::<u64>())),
        output_subtype: if depth > 24 { "PCM_32" } else if depth > 16 { "PCM_24" } else { "PCM_16" },
    };
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&output.path).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    let result = (|| -> std::io::Result<()> {
        writer.write_all(b"RIFF")?;
        writer.write_all(&0u32.to_le_bytes())?;
        writer.write_all(b"WAVEfmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&3u16.to_le_bytes())?; // WAVE_FORMAT_IEEE_FLOAT
        writer.write_all(&channels.to_le_bytes())?;
        writer.write_all(&rate.to_le_bytes())?;
        writer.write_all(&(rate * u32::from(channels) * 4).to_le_bytes())?;
        writer.write_all(&(channels * 4).to_le_bytes())?;
        writer.write_all(&32u16.to_le_bytes())?;
        writer.write_all(b"data")?;
        writer.write_all(&0u32.to_le_bytes())?;
        let mut bytes = 0u32;
        for sample in &mut decoder {
            if !sample.is_finite() { return Err(std::io::Error::other("Audio contains non-finite samples")); }
            bytes = bytes.checked_add(4).filter(|size| *size <= u32::MAX - 36)
                .ok_or_else(|| std::io::Error::other("Audio exceeds the WAV size limit"))?;
            writer.write_all(&sample.to_le_bytes())?;
        }
        if bytes == 0 { return Err(std::io::Error::other("Audio contains no decoded samples")); }
        writer.seek(SeekFrom::Start(4))?;
        writer.write_all(&(bytes + 36).to_le_bytes())?;
        writer.seek(SeekFrom::Start(40))?;
        writer.write_all(&bytes.to_le_bytes())?;
        writer.flush()
    })();
    drop(writer);
    result.map_err(|error| format!("音频解码失败：{error}"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoding_streams_pcm_to_float_wave_and_cleans_the_temporary_audio() {
        let directory = std::env::temp_dir().join(format!("ai-decode-{}", rand::random::<u64>()));
        fs::create_dir(&directory).unwrap();
        let source = directory.join("source.wav");
        let mut wav = b"RIFF".to_vec();
        wav.extend(40u32.to_le_bytes()); wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes()); wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes()); wav.extend(44100u32.to_le_bytes());
        wav.extend(88200u32.to_le_bytes()); wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes()); wav.extend(b"data");
        wav.extend(4u32.to_le_bytes()); wav.extend(1000i16.to_le_bytes()); wav.extend((-1000i16).to_le_bytes());
        fs::write(&source, &wav).unwrap();
        let decoded = prepare(&source, &directory).unwrap();
        let bytes = fs::read(&decoded.path).unwrap();
        assert_eq!(&bytes[20..22], &3u16.to_le_bytes());
        assert_eq!(&bytes[40..44], &8u32.to_le_bytes(), "Native decoding must preserve every source frame");
        assert!((f32::from_le_bytes(bytes[44..48].try_into().unwrap()) - 1000.0 / 32768.0).abs() < 1e-6);
        let temporary = decoded.path.clone(); drop(decoded);
        assert!(!temporary.exists());
        assert_eq!(fs::read(&source).unwrap(), wav, "Preparing AI input must never overwrite the original");
        fs::remove_dir_all(directory).unwrap();
    }
}
