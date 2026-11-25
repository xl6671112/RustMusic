// MIT Signalsmith Stretch, vendored from signalsmith-stretch crate 0.1.3.
// Upstream: https://github.com/Signalsmith-Audio/signalsmith-stretch
#include "signalsmith-stretch.h"
struct Audio {
    float *data;
    int channels;
    struct Channel {
        float *data; int stride;
        float &operator[](int i) { return data[i*stride]; }
    };
    Channel operator[](int channel) { return {data + channel, channels}; }
};
struct Pitch {
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    int channels;
};
extern "C" {
void *rm_pitch_new(int channels, int rate) {
    auto *p = new Pitch;
    p->channels = channels;
    p->stretch.presetDefault(channels, rate);
    return p;
}
void rm_pitch_delete(Pitch *p) { delete p; }
void rm_pitch_reset(Pitch *p) { p->stretch.reset(); }
int rm_pitch_latency(Pitch *p) { return p->stretch.inputLatency() + p->stretch.outputLatency(); }
void rm_pitch_process(Pitch *p, float *input, float *output, int frames, float semitones) {
    p->stretch.setTransposeSemitones(semitones);
    Audio in{input, p->channels}, out{output, p->channels};
    p->stretch.process(in, frames, out, frames);
}
}
