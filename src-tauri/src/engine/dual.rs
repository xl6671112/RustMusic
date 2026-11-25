use std::{sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use parking_lot::RwLock;
use rodio::Source;

#[derive(Default)]
pub(super) struct DualTrack {
    pub audio: RwLock<Vec<Stem>>,
    pub selected: AtomicUsize,
}
pub(super) struct Stem {
    pub path: String,
    pub samples: Vec<f32>,
    pub rate: u32,
    pub channels: usize,
}
pub(super) struct DualSource<S> { inner: S, shared: Arc<DualTrack>, sample: u64, base_ms: f64, mix: Vec<f32> }
impl<S: Source<Item=f32>> DualSource<S> {
    pub fn new(inner:S, shared:Arc<DualTrack>, base_ms:f64)->Self { Self{inner,shared,sample:0,base_ms,mix:vec![1.0]} }
}
impl<S: Source<Item=f32>> Iterator for DualSource<S> {
    type Item=f32;
    fn next(&mut self)->Option<f32> {
        let original=self.inner.next()?;
        let channels=self.inner.channels().get() as u64;
        let rate=self.inner.sample_rate().get() as f64;
        let selected=self.shared.selected.load(Ordering::Relaxed);
        let mut output=original;
        if selected>0 || self.mix.first().copied().unwrap_or_default()<1.0 {
            let guard=self.shared.audio.read();
            self.mix.resize(guard.len()+1,0.0);
            let selected=selected.min(guard.len());
            let step=1.0/(rate as f32*channels as f32*0.005);
            for (index,gain) in self.mix.iter_mut().enumerate() {
                *gain=(*gain+if index==selected {step} else {-step}).clamp(0.0,1.0);
            }
            // Normalize when switching quickly during an existing crossfade.
            let total=self.mix.iter().sum::<f32>().max(f32::EPSILON);
            output=original*self.mix[0]/total;
            for (index,stem) in guard.iter().enumerate() {
                let gain=self.mix[index+1]/total;
                if gain==0.0 { continue; }
                let frame=(self.base_ms/1000.0+(self.sample/channels) as f64/rate)*stem.rate as f64;
                let channel=(self.sample%channels) as usize%stem.channels;
                let a=frame.floor() as usize*stem.channels+channel;
                let b=a+stem.channels;
                let vocal_free=stem.samples.get(a).copied().unwrap_or(0.0);
                let next=stem.samples.get(b).copied().unwrap_or(vocal_free);
                let value=vocal_free+(next-vocal_free)*frame.fract() as f32;
                // All stems use the original clock, including while inaudible.
                output+=value*gain;
            }
        }
        self.sample+=1;
        Some(output)
    }
}
impl<S: Source<Item=f32>> Source for DualSource<S> {
    fn current_span_len(&self)->Option<usize>{self.inner.current_span_len()}
    fn channels(&self)->rodio::ChannelCount{self.inner.channels()}
    fn sample_rate(&self)->rodio::SampleRate{self.inner.sample_rate()}
    fn total_duration(&self)->Option<Duration>{self.inner.total_duration()}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn muted_stem_uses_original_clock_and_switching_never_restarts_the_source() {
        let shared=Arc::new(DualTrack::default());
        shared.audio.write().push(Stem{path:"fixture".into(),samples:(0..100).map(|n|n as f32).collect(),rate:1000,channels:1});
        let original=rodio::buffer::SamplesBuffer::new(1.try_into().unwrap(),1000.try_into().unwrap(),vec![-1.0;100]);
        let mut source=DualSource::new(original,shared.clone(),0.0);
        for _ in 0..20 { assert_eq!(source.next(),Some(-1.0)); }
        shared.selected.store(1,Ordering::Relaxed);
        for _ in 0..6 { source.next(); }
        assert_eq!(source.next(),Some(26.0),"muted stem must advance, not start at sample zero");
        shared.selected.store(0,Ordering::Relaxed);
        for _ in 0..6 {source.next();}
        assert_eq!(source.next(),Some(-1.0),"returning to original must preserve its advancing timeline");
        assert_eq!(source.count(),66,"toggles must neither drop nor duplicate samples");
    }
    #[test]
    fn a_seek_aligns_the_companion_to_the_same_absolute_frame() {
        let shared=Arc::new(DualTrack::default());
        shared.audio.write().push(Stem{path:"fixture".into(),samples:(0..100).map(|n|n as f32).collect(),rate:1000,channels:1});
        shared.selected.store(1,Ordering::Relaxed);
        let original=rodio::buffer::SamplesBuffer::new(1.try_into().unwrap(),1000.try_into().unwrap(),vec![0.0;20]);
        let mut source=DualSource::new(original,shared,50.0);
        for _ in 0..6 {source.next();}
        assert_eq!(source.next(),Some(56.0),"seek must offset both tracks rather than restart accompaniment");
    }
    #[test]
    fn vocals_and_instrumental_switch_on_the_same_clock_and_crossfade_without_a_gap() {
        let shared=Arc::new(DualTrack::default());
        for (path,offset) in [("instrumental",100.0),("vocals",200.0)] {
            shared.audio.write().push(Stem{path:path.into(),samples:(0..100).map(|n|offset+n as f32).collect(),rate:1000,channels:1});
        }
        let original=rodio::buffer::SamplesBuffer::new(1.try_into().unwrap(),1000.try_into().unwrap(),vec![1.0;100]);
        let mut source=DualSource::new(original,shared.clone(),0.0);
        shared.selected.store(1,Ordering::Relaxed);
        for _ in 0..10 { source.next(); }
        shared.selected.store(2,Ordering::Relaxed);
        let first=source.next().unwrap();
        assert!(first>110.0 && first<210.0,"switch must blend stems instead of inserting silence or jumping directly");
        for _ in 0..6 { source.next(); }
        assert_eq!(source.next(),Some(217.0),"vocals must enter at the original track time, not sample zero");
        shared.selected.store(0,Ordering::Relaxed);
        for _ in 0..6 { source.next(); }
        assert_eq!(source.next(),Some(1.0),"the original timeline remains available after both stem switches");
    }
}
