//! Acon Remix VST2 bridge. Audio is passed through unchanged when
//! the optional plugin is absent, the source is not stereo, or amount is zero.
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::collections::VecDeque;

use rodio::Source;
use serde::Serialize;

#[cfg(all(test, windows))]
#[path = "vocal_listening.rs"]
mod listening;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalStatus { pub installed: bool, pub supported_platform: bool, pub error: Option<String> }

pub fn status() -> VocalStatus {
    let result = RemixHost::open(44100);
    VocalStatus { installed: result.is_ok(), supported_platform: cfg!(windows), error: result.err() }
}

pub struct VocalShared(AtomicU32);

impl VocalShared {
    pub fn new() -> Self { Self(AtomicU32::new(0)) }
    pub fn set(&self, amount: f32) -> Result<(), String> {
        if !amount.is_finite() || !(0.0..=100.0).contains(&amount) {
            return Err("Vocal-removal strength must be between 0 and 100".into());
        }
        self.0.store(amount.to_bits(), Ordering::Relaxed);
        Ok(())
    }
    pub fn amount_percent(&self) -> f32 { f32::from_bits(self.0.load(Ordering::Relaxed)) }
    fn amount(&self) -> f32 { self.amount_percent() / 100.0 }
}

pub struct VocalSource<S> {
    inner: S,
    shared: Arc<VocalShared>,
    host: Option<RemixHost>,
    ch: u16,
    ready: VecDeque<f32>,
    pending: Vec<f32>,
    dry_ready: VecDeque<f32>,
    eof: bool,
    flush_frames: usize,
    wet_mix: f32,
    mix_step: f32,
}

impl<S: Source<Item = f32>> VocalSource<S> {
    pub fn new(inner: S, shared: Arc<VocalShared>) -> Self {
        let ch = inner.channels().get();
        let host = if ch == 2 { RemixHost::open(inner.sample_rate().get()).ok() } else { None };
        Self::with_host(inner, shared, host)
    }

    fn with_host(inner: S, shared: Arc<VocalShared>, host: Option<RemixHost>) -> Self {
        let ch=inner.channels().get();
        let flush_frames=host.as_ref().map_or(0, RemixHost::latency);
        let mix_step=1.0/(inner.sample_rate().get() as f32*0.005).max(1.0);
        let wet_mix=if shared.amount()>0.0 {1.0} else {0.0};
        Self { inner, shared, host, ch, ready: VecDeque::new(), pending: Vec::with_capacity(2048), dry_ready: VecDeque::new(), eof:false, flush_frames, wet_mix, mix_step }
    }
}

impl<S: Source<Item = f32>> Iterator for VocalSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.ch != 2 { return self.inner.next(); }
        while self.ready.is_empty() {
            if self.pending.len() == 2048 || (self.eof && !self.pending.is_empty()) {
                let amount = self.shared.amount();
                if let Some(host) = self.host.as_mut() {
                    let mut wet = VecDeque::with_capacity(2048);
                    let mut aligned = VecDeque::with_capacity(2048);
                    host.process_block(&self.pending, &mut wet, amount, &mut self.dry_ready, &mut aligned);
                    let target=if amount>0.0 {1.0} else {0.0};
                    for (index,(dry,processed)) in aligned.into_iter().zip(wet).enumerate() {
                        if index%2==0 {
                            self.wet_mix+=(target-self.wet_mix).clamp(-self.mix_step,self.mix_step);
                        }
                        self.ready.push_back(if self.wet_mix==0.0 {dry} else if self.wet_mix==1.0 {processed} else {dry+(processed-dry)*self.wet_mix});
                    }
                    self.pending.clear();
                } else { self.ready.extend(self.pending.drain(..)); }
                if !self.ready.is_empty() { break; }
                continue;
            }
            if self.eof {
                if self.flush_frames==0 { return None; }
                let frames=self.flush_frames.min(1024);
                self.flush_frames-=frames;
                self.pending.resize(frames*2,0.0);
                continue;
            }
            match self.inner.next() {
                Some(sample) => self.pending.push(sample),
                None => self.eof=true,
            }
        }
        self.ready.pop_front()
    }
}

impl<S: Source<Item = f32>> Source for VocalSource<S> {
    fn current_span_len(&self) -> Option<usize> { if self.ch == 2 { None } else { self.inner.current_span_len() } }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<std::time::Duration> { self.inner.total_duration() }
}

#[cfg(windows)]
struct RemixHost {
    _lib: libloading::Library,
    effect: *mut Effect,
    input: Vec<f32>,
    output: [Vec<f32>; 12],
    latency: usize,
    amount: f32,
    trim_frames: usize,
}
#[cfg(windows)]
unsafe impl Send for RemixHost {}
#[cfg(windows)]
#[repr(C)]
struct Effect {
    magic: i32, dispatch: Option<unsafe extern "C" fn(*mut Effect,i32,i32,isize,*mut std::ffi::c_void,f32)->isize>,
    process: *mut std::ffi::c_void, set: Option<unsafe extern "C" fn(*mut Effect,i32,f32)>,
    get: *mut std::ffi::c_void, programs:i32, params:i32, inputs:i32, outputs:i32, flags:i32,
    reserved1:isize,reserved2:isize,latency:i32,quality1:i32,quality2:i32,ratio:f32,
    object:*mut std::ffi::c_void,user:*mut std::ffi::c_void,id:i32,version:i32,
    replace:Option<unsafe extern "C" fn(*mut Effect,*mut *mut f32,*mut *mut f32,i32)>,
    double_replace:*mut std::ffi::c_void,future:[u8;56],
}
#[cfg(windows)]
impl RemixHost {
    fn latency(&self)->usize { self.latency }
    fn path() -> Result<std::path::PathBuf, String> {
        if let Some(p) = std::env::var_os("RUSTMUSIC_REMIX_PLUGIN") { return Ok(p.into()); }
        if crate::remix_assets::is_embedded() { return crate::remix_assets::prepare(); }
        let portable = std::env::current_exe().map_err(|e| e.to_string())?.parent()
            .ok_or("Unable to locate player directory")?.join("plugins/Remix.dll");
        if portable.is_file() { return Ok(portable); }
        let root=std::env::var_os("ProgramW6432").unwrap_or_else(||"C:\\Program Files".into());
        Ok(std::path::PathBuf::from(root).join("VstPlugIns/Acon Digital/Remix.dll"))
    }
    fn open(rate:u32)->Result<Self,String> {
        let path=Self::path()?;
        let lib=unsafe { libloading::Library::new(path) }.map_err(|e|e.to_string())?;
        type Entry=unsafe extern "C" fn(unsafe extern "C" fn(*mut Effect,i32,i32,isize,*mut std::ffi::c_void,f32)->isize)->*mut Effect;
        let entry:libloading::Symbol<Entry>=unsafe{lib.get(b"VSTPluginMain\0")}.map_err(|e|e.to_string())?;
        let callback:unsafe extern "C" fn(*mut Effect,i32,i32,isize,*mut std::ffi::c_void,f32)->isize=host_callback;
        let effect=unsafe{entry(callback)};
        if effect.is_null(){return Err("Remix VST2 initialization failed".into())}
        let e=unsafe{&mut *effect};
        if e.magic!=0x56737450 || e.inputs!=2 || !(2..=12).contains(&e.outputs) || e.params<15 || e.set.is_none() || e.replace.is_none(){return Err("Unsupported Remix VST2 layout".into())}
        e.user=rate as usize as *mut std::ffi::c_void;
        unsafe { (e.dispatch.unwrap())(effect,0,0,0,std::ptr::null_mut(),0.0); (e.dispatch.unwrap())(effect,10,0,0,std::ptr::null_mut(),rate as f32); (e.dispatch.unwrap())(effect,11,0,1024,std::ptr::null_mut(),0.0); for i in 0..5{(e.set.unwrap())(effect,i,0.8)} for i in 5..15{(e.set.unwrap())(effect,i,0.0)} (e.dispatch.unwrap())(effect,12,0,1,std::ptr::null_mut(),0.0); (e.dispatch.unwrap())(effect,71,0,0,std::ptr::null_mut(),0.0); }
        let latency=(e.latency.max(0) as usize).min(44100*10);
        let host=Self{_lib:lib,effect,input:vec![0.0;2048],output:std::array::from_fn(|_|vec![0.0;1024]),latency,amount:0.0,trim_frames:latency};
        if latency==0 { return Err("Remix realtime separation models could not be loaded".into()); }
        Ok(host)
    }
    fn process_block(&mut self,input:&[f32],output:&mut VecDeque<f32>,amount:f32,dry:&mut VecDeque<f32>,aligned:&mut VecDeque<f32>){
        let e=unsafe{&mut *self.effect};
        let frames=input.len()/2;
        if dry.is_empty() { dry.extend(std::iter::repeat(0.0).take(self.latency*2)); }
        for offset in (0..frames).step_by(64) {
            let count=(frames-offset).min(64);
            let t=(offset+count) as f32/frames as f32;
            let a=self.amount+(amount-self.amount)*t;
            unsafe{(e.set.unwrap())(self.effect,0,0.8*(1.0-a));(e.set.unwrap())(self.effect,5,if a>=1.0{1.0}else{0.0});}
            for i in 0..count { self.input[i]=input[2*(offset+i)]; self.input[1024+i]=input[2*(offset+i)+1]; }
            let base=self.input.as_mut_ptr();
            let mut ins=[base,unsafe{base.add(1024)}];
            let mut outs: [*mut f32;12]=std::array::from_fn(|i| self.output[i].as_mut_ptr());
            unsafe{(e.replace.unwrap())(self.effect,ins.as_mut_ptr(),outs.as_mut_ptr(),count as i32)};
            for i in 0..count {
                dry.push_back(input[2*(offset+i)]); dry.push_back(input[2*(offset+i)+1]);
                let dl=dry.pop_front().unwrap_or(0.0); let dr=dry.pop_front().unwrap_or(0.0);
                if self.trim_frames>0 { self.trim_frames-=1; continue; }
                output.push_back(if self.output[0][i].is_finite(){self.output[0][i]}else{0.0});
                output.push_back(if self.output[1][i].is_finite(){self.output[1][i]}else{0.0});
                aligned.push_back(dl); aligned.push_back(dr);
            }
        }
        self.amount=amount;
    }
}

#[cfg(test)]
mod source_edge_tests {
    use super::*;

    #[test]
    fn invalid_strengths_are_rejected_without_changing_the_active_value() {
        let shared=VocalShared::new();
        shared.set(42.0).unwrap();
        for bad in [-1.0,100.01,f32::NAN,f32::INFINITY,f32::NEG_INFINITY] {
            assert!(shared.set(bad).is_err(),"accepted invalid amount {bad}");
            assert_eq!(shared.amount(),0.42);
        }
    }

    #[test]
    fn absent_plugin_stereo_and_mono_sources_keep_exact_sample_count() {
        let shared=Arc::new(VocalShared::new());
        shared.set(75.0).unwrap();
        let stereo:Vec<f32>=(0..2049).flat_map(|_|[0.25f32,-0.25]).collect();
        let stereo_source=rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(2).unwrap(),rodio::SampleRate::new(44100).unwrap(),stereo.clone());
        let stereo_out:Vec<_>=VocalSource::with_host(stereo_source,shared.clone(),None).collect();
        assert_eq!(stereo_out,stereo,"missing VST must bypass without latency padding or tail loss");
        let mono=vec![0.125f32;2051];
        let mono_source=rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(1).unwrap(),rodio::SampleRate::new(44100).unwrap(),mono.clone());
        let mono_out:Vec<_>=VocalSource::with_host(mono_source,shared,None).collect();
        assert_eq!(mono_out,mono,"stereo-only VST must leave mono input untouched");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn licensed_remix_changes_fixture_at_mid_and_max_strength() {
        let mut source = Vec::with_capacity(8192);
        for i in 0..220500 {
            let t = i as f32 / 44100.0;
            let vocal = (std::f32::consts::TAU * 440.0 * t).sin() * 0.25;
            let music = (std::f32::consts::TAU * 173.0 * t).sin() * 0.2;
            source.extend_from_slice(&[vocal + music, vocal - music]);
        }
        let mut outputs = Vec::new();
        let started = Instant::now();
        for amount in [0.0, 0.5, 1.0] {
            assert!(RemixHost::open(44100).is_ok(), "installed licensed Remix VST2");
            let shared=Arc::new(VocalShared::new());
            shared.set(amount*100.0).unwrap();
            let src=rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(2).unwrap(),rodio::SampleRate::new(44100).unwrap(),source.clone());
            let output:Vec<f32>=VocalSource::new(src,shared).collect();
            assert_eq!(output.len(),source.len(), "latency trim and tail flush preserve duration at {amount}");
            assert!(output.iter().all(|v|v.is_finite()));
            let energy: f64 = output.iter().map(|v| (*v as f64).powi(2)).sum();
            assert!(energy > 0.01, "plugin output unexpectedly silent at {amount}");
            outputs.push(output);
        }
        assert_eq!(outputs[0], source, "strength zero is an exact bypass");
        for output in &outputs[1..] {
            let delta: f64 = output.iter().zip(&source).map(|(a,b)| (*a as f64-*b as f64).abs()).sum();
            assert!(delta > 0.1, "Remix did not process the fixture");
        }
        assert_ne!(outputs[1], outputs[2], "50 and 100 must select distinct plugin behavior");
        let shared=Arc::new(VocalShared::new());
        let src=rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(2).unwrap(),rodio::SampleRate::new(44100).unwrap(),source.clone());
        let mut live=VocalSource::new(src,shared.clone());
        let mut changed:Vec<f32>=live.by_ref().take(44100*2).collect();
        shared.set(50.0).unwrap();
        changed.extend(live.by_ref().take(44100*2));
        shared.set(100.0).unwrap();
        changed.extend(live.by_ref().take(44100*2));
        shared.set(0.0).unwrap();
        changed.extend(live);
        assert_eq!(changed.len(),source.len(),"live strength change preserves duration");
        assert!(changed.iter().all(|v|v.is_finite()));
        assert_eq!(&changed[changed.len()-4096..], &source[source.len()-4096..], "return to zero settles to exact original samples");
        let step=changed.windows(2).map(|w|(w[1]-w[0]).abs()).fold(0.0f32,f32::max);
        assert!(step<2.0,"unexpected transition spike: {step}");
        for output in &outputs[1..] {
            let peak=output.windows(2).map(|w|(w[1]-w[0]).abs()).fold(0.0f32,f32::max);
            assert!(peak<2.0,"unexpected output discontinuity: {peak}");
        }
        eprintln!("Remix fixture: 220500 stereo frames (5s) at 44.1kHz, 0/50/100 processed in {:?}; validates signal change, not perceptual quality", started.elapsed());
    }
}
#[cfg(windows)]
impl Drop for RemixHost {
    fn drop(&mut self) {
        let e=unsafe{&mut *self.effect};
        if let Some(dispatch)=e.dispatch { unsafe { dispatch(self.effect,72,0,0,std::ptr::null_mut(),0.0); dispatch(self.effect,12,0,0,std::ptr::null_mut(),0.0); dispatch(self.effect,1,0,0,std::ptr::null_mut(),0.0); } }
    }
}
#[cfg(windows)]
unsafe extern "C" fn host_callback(effect:*mut Effect,op:i32,_:i32,_:isize,_:*mut std::ffi::c_void,_:f32)->isize { match op {1=>2400,16=>if effect.is_null(){44100}else{unsafe{(*effect).user as usize as isize}},17=>1024,32|37=>1,_=>0} }
#[cfg(not(windows))]
struct RemixHost;
#[cfg(not(windows))]
impl RemixHost {
    fn available() -> bool { false }
    fn open(_:u32)->Result<Self,String>{Err("Remix VST2 is supported only on Windows".into())}
    fn latency(&self)->usize { 0 }
    fn process_block(&mut self,_:&[f32],_:&mut VecDeque<f32>,_:f32,_:&mut VecDeque<f32>,_:&mut VecDeque<f32>){}
}
