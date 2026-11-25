//! Duration-preserving Signalsmith Stretch pitch shift with aligned exact dry bypass.
use std::{collections::VecDeque, sync::{Arc, atomic::{AtomicU32, Ordering}}, time::Duration};
use rodio::Source;

pub struct PitchShared(AtomicU32);
impl PitchShared {
    pub fn new() -> Self { Self(AtomicU32::new(0)) }
    pub fn set(&self, semitones: f32) -> Result<(), String> {
        if !semitones.is_finite() || !(-12.0..=12.0).contains(&semitones) {
            return Err("Pitch must be between -12 and 12 semitones".into());
        }
        self.0.store(semitones.to_bits(), Ordering::Relaxed);
        Ok(())
    }
    pub fn semitones(&self) -> f32 { f32::from_bits(self.0.load(Ordering::Relaxed)) }
}

extern "C" {
    fn rm_pitch_new(channels: i32, rate: i32) -> *mut std::ffi::c_void;
    fn rm_pitch_delete(p: *mut std::ffi::c_void);
    fn rm_pitch_reset(p: *mut std::ffi::c_void);
    fn rm_pitch_latency(p: *mut std::ffi::c_void) -> i32;
    fn rm_pitch_process(p: *mut std::ffi::c_void, input: *mut f32, output: *mut f32, frames: i32, semitones: f32);
}
struct Processor(*mut std::ffi::c_void);
// Owned exclusively by this source; process/reset require &mut self.
unsafe impl Send for Processor {}
impl Drop for Processor { fn drop(&mut self) { unsafe { rm_pitch_delete(self.0) } } }

pub struct PitchSource<S> {
    inner: S,
    shared: Arc<PitchShared>,
    processor: Processor,
    channels: usize,
    rate: f32,
    latency: usize,
    trim: usize,
    eof: bool,
    dry: VecDeque<f32>,
    ready: VecDeque<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
    pitch: f32,
    mix: f32,
}
impl<S: Source<Item=f32>> PitchSource<S> {
    pub fn new(inner: S, shared: Arc<PitchShared>) -> Self {
        let channels=inner.channels().get() as usize;
        let rate=inner.sample_rate().get() as f32;
        let processor=Processor(unsafe { rm_pitch_new(channels as i32, rate as i32) });
        let latency=unsafe { rm_pitch_latency(processor.0) } as usize;
        let pitch=shared.semitones();
        Self { inner,shared,processor,channels,rate,latency,trim:latency,eof:false,
            dry:VecDeque::new(),ready:VecDeque::new(),input:vec![0.0;256*channels],
            output:vec![0.0;256*channels],pitch,mix:if pitch==0.0 {0.0} else {1.0} }
    }
    fn fill(&mut self) {
        let mut frames=0;
        self.input.fill(0.0);
        if !self.eof {
            for sample in self.input.iter_mut() {
                match self.inner.next() {
                    Some(value) => { *sample=value; self.dry.push_back(value); frames+=1; }
                    None => { self.eof=true; break; }
                }
            }
        }
        if frames==0 && self.dry.is_empty() { return; }
        let target=self.shared.semitones();
        // Slew the spectral pitch control rather than jumping FFT-bin mappings.
        self.pitch += (target-self.pitch) * (1.0-(-256.0/(self.rate*0.020)).exp());
        if (target-self.pitch).abs()<0.0001 { self.pitch=target; }
        unsafe { rm_pitch_process(self.processor.0,self.input.as_mut_ptr(),self.output.as_mut_ptr(),256,self.pitch) };
        for frame in 0..256 {
            if self.trim>0 { self.trim-=1; continue; }
            let desired=if target==0.0 {0.0} else {1.0};
            self.mix+=(desired-self.mix).clamp(-1.0/(self.rate*0.010),1.0/(self.rate*0.010));
            for channel in 0..self.channels {
                let Some(dry)=self.dry.pop_front() else { return; };
                let wet=self.output[frame*self.channels+channel];
                self.ready.push_back(if self.mix==0.0 {dry} else {dry+(wet-dry)*self.mix});
            }
        }
    }
}
impl<S: Source<Item=f32>> Iterator for PitchSource<S> {
    type Item=f32;
    fn next(&mut self)->Option<f32> {
        while self.ready.is_empty() {
            if self.eof && self.dry.is_empty() { return None; }
            self.fill();
        }
        self.ready.pop_front()
    }
}
impl<S: Source<Item=f32>> Source for PitchSource<S> {
    fn current_span_len(&self)->Option<usize> { None }
    fn channels(&self)->rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self)->rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self)->Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self,pos:Duration)->Result<(),rodio::source::SeekError> {
        self.inner.try_seek(pos)?;
        unsafe { rm_pitch_reset(self.processor.0) };
        self.trim=self.latency; self.eof=false; self.dry.clear(); self.ready.clear();
        self.pitch=self.shared.semitones();
        self.mix=if self.pitch==0.0 {0.0} else {1.0};
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(data:Vec<f32>,channels:u16)->rodio::buffer::SamplesBuffer {
        rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(channels).unwrap(),rodio::SampleRate::new(44100).unwrap(),data)
    }
    fn tone(channels:usize)->Vec<f32> {
        (0..88200).flat_map(|i|std::iter::repeat((i as f32*440.0*std::f32::consts::TAU/44100.0).sin()*0.25).take(channels)).collect()
    }
    #[test]
    fn invalid_pitch_never_changes_valid_setting() {
        let shared=PitchShared::new(); shared.set(2.0).unwrap();
        for bad in [f32::NAN,f32::INFINITY,-12.1,12.1] {
            assert!(shared.set(bad).is_err()); assert_eq!(shared.semitones(),2.0);
        }
        shared.set(0.0).unwrap(); assert_eq!(shared.semitones(),0.0);
    }
    #[test]
    fn zero_is_bit_exact_and_short_tails_keep_every_sample() {
        for channels in [1,2] {
            for frames in [1,255,256,1025,9000] {
                let data:Vec<f32>=(0..frames*channels).map(|i|(i as f32*0.23).sin()).collect();
                let out:Vec<_>=PitchSource::new(source(data.clone(),channels as u16),Arc::new(PitchShared::new())).collect();
                assert_eq!(out,data,"Zero pitch must be transparent, including latency and final partial blocks");
            }
        }
    }
    #[test]
    fn octave_shifts_frequency_not_duration_in_mono_and_stereo() {
        for channels in [1,2] { for semitones in [-12.0,12.0] {
            let shared=Arc::new(PitchShared::new()); shared.set(semitones).unwrap();
            let data=tone(channels);
            let out:Vec<_>=PitchSource::new(source(data.clone(),channels as u16),shared).collect();
            assert_eq!(out.len(),data.len(),"Pitch must not speed up or truncate the source");
            assert!(out.iter().all(|v|v.is_finite()));
            let mono:Vec<_>=out[22050*channels..66150*channels].iter().step_by(channels).copied().collect();
            let crossings=mono.windows(2).filter(|w|w[0]<=0.0&&w[1]>0.0).count() as f32;
            let expected=440.0*2f32.powf(semitones/12.0);
            assert!((crossings-expected).abs()<4.0,"Measured {crossings} Hz, expected {expected} Hz");
            assert!(out[out.len()-4410*channels..].iter().map(|v|v*v).sum::<f32>()>1.0,"Delayed final audio must be drained");
        }}
    }
    #[test]
    fn dynamic_changes_are_finite_duration_preserving_and_seek_clears_history() {
        let shared=Arc::new(PitchShared::new());
        let data=tone(2);
        let mut src=PitchSource::new(source(data.clone(),2),shared.clone());
        let mut out=Vec::new();
        for pitch in [0.0,7.0,-5.0,0.0] {
            shared.set(pitch).unwrap();
            out.extend(src.by_ref().take(22050));
        }
        out.extend(src.by_ref());
        assert_eq!(out.len(),data.len()); assert!(out.iter().all(|v|v.is_finite()));
        let jump=out.chunks_exact(2).map(|f|f[0]).collect::<Vec<_>>().windows(2).map(|w|(w[1]-w[0]).abs()).fold(0f32,f32::max);
        assert!(jump<0.2,"Smoothing must avoid discontinuities on a steady tone: {jump}");
        shared.set(0.0).unwrap(); src.try_seek(Duration::ZERO).unwrap();
        let after:Vec<_>=src.collect();
        assert_eq!(after,data,"Seeking at zero must not leak cached audio from the old pitch/position");
    }
}
