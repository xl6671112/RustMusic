/* Player timeline adapter. The original JIZURA project is never mutated. */
(() => {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  function projectForState(base, state) {
    const defaults = J.defaultProject();
    const project = Object.assign(defaults, clone(base || {}));
    project.fx = Object.assign(J.defaultProject().fx, project.fx || {});
    project.timing = Object.assign(J.defaultProject().timing, project.timing || {});
    project.enabled = Object.assign(J.defaultProject().enabled, project.enabled || {});
    const source = state?.lyrics?.lines;
    const lines = Array.isArray(source) ? source.filter(line => typeof line.text === "string" && line.text.trim()) : [];
    project.title = state.title || "";
    project.artist = state.artist || "";
    const duration = Math.max(0, (Number(state.durationMs) || 0) / 1000);
    const timed = !!state.lyrics?.synced && lines.every(line => Number.isFinite(line.timeMs));
    // Untimed API lyrics follow the player's existing whole-song equal split.
    const span = lines.length ? duration / lines.length : 0;
    const starts = lines.map((line, index) => timed ? Math.max(0, line.timeMs / 1000) : index * span);
    const ends = starts.map((start, index) => index + 1 < lines.length ? starts[index + 1] : duration);
    project.lyrics = lines.map(line => line.text).join("\n");
    // Structured inputs preserve API text literally: editor syntax (* / | # [])
    // must never remove words or invent a manual lyric timeline.
    project.nativeLines = lines.map((line, index) => ({
      text: line.text, lrc: timed ? starts[index] : null, src: index,
      note: null, impact: false, emph: [], manual: null, gapBefore: false,
    }));
    project.nativeTiming = { starts, ends, duration };
    project.timingOrder = 2;
    project.timing = { ...project.timing, snap: false, offset: 0, lineTimes: {} };
    return project;
  }
  J.RustMusic = { projectForState };
})();
