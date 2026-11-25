(() => {
  "use strict";
  const canvas = document.getElementById("jizura-canvas");
  const context = canvas.getContext("2d", { alpha: true });
  const errorLabel = document.getElementById("jizura-error");
  const renderer = new J.Renderer();
  let state = {}, settings = {}, preview = null, plan = null, signature = "";
  let position = 0, anchoredAt = 0, time = 0, error = "", lastFrame = -Infinity;
  let stopped = false, generation = 0, lastDraw = "";
  let connectionError = "", renderError = "";

  function fail(message, source = "connection") {
    if (source === "render") renderError = message;
    else connectionError = message;
    error = renderError || connectionError;
    errorLabel.textContent = error;
    errorLabel.hidden = !error;
  }
  function resize() {
    if (!plan) return;
    const desiredHeight = Math.max(240, Math.min(2160, Number(settings.project?.res) || 1080));
    const scale = desiredHeight / Math.min(plan.W, plan.H);
    const width = Math.round(plan.W * scale / 2) * 2, height = Math.round(plan.H * scale / 2) * 2;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }
  function registerFonts(project) {
    for (const font of project.userFonts || []) {
      if (J.SAFE_FONT_KEY.test(font.key || "") && !J.FONTS[font.key]) {
        J.addUserFont(font.key, String(font.label || font.key), String(font.family || font.key), Number(font.weight) || 400);
      }
    }
  }
  function prepareFonts(project, audio, activeGeneration) {
    const imported = Object.entries(settings.fontFiles || {}).map(async ([key, file]) => {
      const font = J.FONTS[key];
      if (!font || !/^[a-f0-9]{64}\.(ttf|otf|woff2?)$/i.test(file)) return;
      const face = new FontFace(J.safeFamily((project.userFonts || []).find(item => item.key === key)?.family || key), `url("/fonts/${file}")`);
      await face.load();
      if (activeGeneration !== generation) return;
      document.fonts.add(face);
      font.loaded = true;
    });
    Promise.allSettled(imported).then(() => J.restoreUserFonts(project.userFonts || [])).then(() => {
      if (activeGeneration !== generation || !plan) return;
      return J.ensureFonts(project.lyrics + project.title + project.artist, J.fontsOfPlan(plan));
    }).then(() => {
      if (activeGeneration === generation) {
        J.glyphs.clear();
        J.metrics.clear();
        plan = J.plan(project, audio);
        resize();
        lastDraw = "";
      }
    }).catch(reason => console.warn("JIZURA font fallback:", reason));
  }
  function update(next) {
    state = next;
    settings = preview || state.settings?.jizura || {};
    if (!preview && /^\/lyrics\/?$/.test(location.pathname) && state.settings?.preset !== "jizura") {
      location.reload();
      return;
    }
    position = Number(state.positionMs) || 0;
    anchoredAt = performance.now();
    const hasLyrics = Array.isArray(state.lyrics?.lines) && state.lyrics.lines.some(line => line.text?.trim());
    const nextSignature = JSON.stringify([state.trackKey, state.title, state.artist, state.durationMs, state.lyrics, settings.project, settings.fontFiles, settings.analysis, settings.lineEffectsTrackKey]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      generation++;
      if (!hasLyrics) {
        plan = null;
        context.clearRect(0, 0, canvas.width, canvas.height);
        fail("", "render");
        return;
      }
      const project = J.RustMusic.projectForState(settings.project, state);
      if (!state.trackKey || settings.lineEffectsTrackKey !== state.trackKey) project.overrides = {};
      const duration = Math.max(0, (Number(state.durationMs) || 0) / 1000);
      const audio = { duration };
      const analysisMatches = settings.analysis && (
        settings.analysis.sourceTrackKey === state.trackKey && !!state.trackKey
        || settings.project?.audioName && settings.project.title === state.title && settings.project.artist === state.artist
      );
      if (analysisMatches) Object.assign(audio, settings.analysis);
      audio.duration = duration;
      if (project.timing.bpm > 0) audio.beats = J.beatGrid(project.timing.bpm, project.timing.beatOffset || 0, Math.max(duration, 600));
      registerFonts(project);
      plan = J.plan(project, audio);
      resize();
      prepareFonts(project, audio, generation);
    }
  }
  async function poll() {
    if (stopped) return;
    try {
      const response = await fetch("/state", { cache: "no-store", signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      update(await response.json());
      fail("");
    } catch (reason) {
      fail(`歌词连接失败：${String(reason)}`);
    } finally {
      if (!stopped) setTimeout(poll, 100);
    }
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (!plan) return;
    const fps = Math.max(1, Math.min(60, Number(plan.fps) || 24));
    if (now - lastFrame < 1000 / fps - 1) return;
    lastFrame = now;
    const rate = Number(state.playbackRate) > 0 ? Number(state.playbackRate) : 1;
    // A disconnected page stops extrapolating after 500 ms rather than drifting
    // indefinitely away from the native player.
    const elapsed = state.playing ? Math.min(500, Math.max(0, now - anchoredAt)) * rate : 0;
    time = Math.max(0, (position + elapsed + (Number(state.lyricOffsetMs) || 0)) / 1000);
    if (Number(state.durationMs) > 0) time = Math.min(time, state.durationMs / 1000);
    if (!plan.energy && state.audioSpectrum || plan.energy?.length === 1 && state.audioSpectrum) {
      plan.energy = [Math.max(0, Number(state.audioSpectrum.level) || 0)];
      plan.energyRate = 0;
    }
    const drawKey = `${generation}/${time}/${settings.transparent !== false}`;
    if (drawKey === lastDraw && !state.playing) return;
    lastDraw = drawKey;
    try {
      renderer.frame(context, plan, time, { scale: canvas.width / plan.W, transparent: settings.transparent !== false });
      canvas.dataset.time = time.toFixed(3);
      canvas.dataset.transparent = String(settings.transparent !== false);
      if (renderError) fail("", "render");
    } catch (reason) {
      fail(`歌词渲染失败：${String(reason)}`, "render");
    }
  }
  addEventListener("message", event => {
    if (event.source !== parent || event.origin !== "http://127.0.0.1:17842" && !/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(event.origin) && !/^tauri:\/\/localhost$|^https?:\/\/tauri\.localhost$/.test(event.origin)) return;
    if (event.data?.type !== "obs-preview-settings") return;
    preview = event.data.settings?.jizura || {};
    signature = "";
    update(state);
  });
  addEventListener("pagehide", () => { stopped = true; });
  J.rustMusicRuntime = Object.freeze({
    get state() { return state; }, get plan() { return plan; },
    get time() { return time; }, get error() { return error; },
    get ready() { return !!plan; }, get transparent() { return settings.transparent !== false; },
  });
  requestAnimationFrame(frame);
  poll();
})();
