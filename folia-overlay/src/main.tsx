import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { motionValue, useMotionValue } from "framer-motion";
import "./i18n";
import {
  VisualizerBackdropContext,
  type VisualizerBackdropFrame,
} from "../../_third_party/folia-web/src/components/visualizer/VisualizerBackdrop";
import VisualizerHarmonyOverlay from "../../_third_party/folia-web/src/components/visualizer/VisualizerHarmonyOverlay";
import { LyricRenderQualityGlobalContext } from "./renderQuality";
import hanabiTuning from "../../_third_party/folia-web/src/components/visualizer/hanabi/tuning";
import machiTuning from "../../_third_party/folia-web/src/components/visualizer/machi/tuning";
import metaphorTuning from "../../_third_party/folia-web/src/components/visualizer/metaphor/tuning";
import nebbiaTuning from "../../_third_party/folia-web/src/components/visualizer/nebbia/tuning";
import type {
  Line,
  Theme,
  VisualizerMode,
  Word,
} from "../../_third_party/folia-web/src/types";
import type { VisualizerSharedProps } from "../../_third_party/folia-web/src/components/visualizer/definition";
import type { VisualizerTuningBundle } from "../../_third_party/folia-web/src/components/visualizer/tuningRegistry";
import { applyVisualizerTuning, getStoredVisualizerTunings } from "../../_third_party/folia-web/src/components/visualizer/tuningRegistry";
import { getVisualizerRegistryEntry } from "../../_third_party/folia-web/src/components/visualizer/registry";
import VisualizerBackgroundRenderer from "../../_third_party/folia-web/src/components/visualizer/backgrounds/VisualizerBackgroundRenderer";
import { DEFAULT_CADENZA_TUNING, DEFAULT_MONET_TUNING } from "../../_third_party/folia-web/src/types";
import { parseSubtitleOverlayLayout } from "../../_third_party/folia-web/src/utils/lyrics/subtitleOverlayLayout";
import { normalizeLyricRenderQuality } from "../../_third_party/folia-web/src/utils/lyricRenderQuality";
import { imageUrls, resolveTheme, type FoliaSettings } from "./appearance";
import "./index.css";

type LyricInput = {
  timeMs: number | null;
  text: string;
  words?: { startMs: number; endMs: number; text: string }[];
  trans?: string;
  roman?: string;
};

type OverlayState = {
  canvasEnabled?: boolean;
  trackKey?: string | null;
  title?: string;
  artist?: string;
  cover?: string;
  lyrics?: { synced?: boolean; lines?: LyricInput[] } | null;
  positionMs?: number;
  durationMs?: number;
  lyricOffsetMs?: number;
  playing?: boolean;
  altMode?: "translation" | "romanization";
  audioSpectrum?: { bands?: number[]; level?: number; beat?: boolean; ageMs?: number };
  settings?: FoliaSettings;
};

const EMPTY_BANDS = {
  bass: motionValue(0),
  lowMid: motionValue(0),
  mid: motionValue(0),
  vocal: motionValue(0),
  treble: motionValue(0),
  spectrum: motionValue(new Uint8Array(36)),
};
const FRAME: VisualizerBackdropFrame = { pointerArea: null };
const Settings = lazy(() => import("./Settings"));
function useFoliaFont(family: string, id?: string) {
  useEffect(() => {
    if (!id || !/^[0-9a-f]{64}\.(ttf|otf|woff2?)$/i.test(id)) return;
    const font = new FontFace(family, `url(/fonts/${id})`);
    document.fonts.add(font);
    void font.load().catch(() => undefined);
    return () => { document.fonts.delete(font); };
  }, [family, id]);
}
const MODE_COMPONENTS = {
  cadenza: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/cadenza/VisualizerCadenza")),
  cappella: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/cappella/VisualizerCappella")),
  claddagh: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/claddagh/VisualizerCladdagh")),
  classic: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/classic/Visualizer")),
  diorama: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/diorama/VisualizerDiorama")),
  fume: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/fume/VisualizerFume")),
  hanabi: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/hanabi/VisualizerHanabi")),
  lumiere: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/lumiere/VisualizerLumiere")),
  machi: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/machi/VisualizerMachi")),
  metaphor: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/metaphor/VisualizerMetaphor")),
  monet: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/monet/VisualizerMonet")),
  nebbia: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/nebbia/VisualizerNebbia")),
  partita: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/partita/VisualizerPartita")),
  pendolo: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/pendolo/VisualizerPendolo")),
  prompt: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/prompt/VisualizerPrompt")),
  sonnet: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/sonnet/VisualizerSonnet")),
  still: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/still/VisualizerStill")),
  tempera: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/tempera/VisualizerTempera")),
  tilt: lazy(() => import("../../_third_party/folia-web/src/components/visualizer/tilt/VisualizerTilt")),
};
type FoliaMode = keyof typeof MODE_COMPONENTS;
const FOLIA_MODES = new Set<string>(Object.keys(MODE_COMPONENTS));
let tuningDefaults: Record<string, unknown> | undefined;
function getFoliaTuningDefaults() {
  // The single-file build initializes inlined visualizers after the overlay module.
  return tuningDefaults ??= Object.fromEntries(
    getStoredVisualizerTunings()
      .filter(({ mode }) => FOLIA_MODES.has(mode))
      .map(({ mode, defaults }) => [mode, defaults]),
  );
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((x) => x.segment);
  }
  return Array.from(text);
}

function toFoliaLines(input: OverlayState): Line[] {
  const source = (input.lyrics?.lines ?? []).filter((line) => line.text.trim());
  if (!source.length) return [];

  const duration = Math.max(1, input.durationMs ?? 0);
  const useSplit = input.settings?.lyricTimeline === "split"
    || !input.lyrics?.synced
    || source.some((line) => line.timeMs == null);
  const lineStarts = source.map((line, index) => (
    useSplit ? (duration * index) / source.length : Math.max(0, line.timeMs ?? 0)
  ));

  return source.map((line, index) => {
    const startMs = lineStarts[index];
    const endMs = lineStarts[index + 1] ?? Math.max(startMs + 1, duration);
    let words: Word[];
    if (line.words?.length) {
      words = line.words.map((word) => ({
        text: word.text,
        startTime: (useSplit ? startMs + Math.max(0, Math.min(1, (word.startMs - (line.timeMs ?? startMs)) / Math.max(1, endMs - startMs))) * (endMs - startMs) : word.startMs) / 1000,
        endTime: (useSplit ? startMs + Math.max(0, Math.min(1, (word.endMs - (line.timeMs ?? startMs)) / Math.max(1, endMs - startMs))) * (endMs - startMs) : word.endMs) / 1000,
      }));
    } else {
      const chars = graphemes(line.text);
      const span = Math.max(1, endMs - startMs);
      words = chars.map((text, i) => ({
        text,
        startTime: (startMs + (span * i) / chars.length) / 1000,
        endTime: (startMs + (span * (i + 1)) / chars.length) / 1000,
      }));
    }
    return {
      id: `${input.trackKey ?? "track"}:${index}`,
      fullText: line.text,
      startTime: startMs / 1000,
      endTime: endMs / 1000,
      words,
      translation: line.trans,
      romanization: line.roman,
    };
  });
}

function FoliaOverlay({ state, live }: {
  state: OverlayState;
  live: React.MutableRefObject<{ state: OverlayState; receivedAt: number }>;
}) {
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const currentTime = useMotionValue(0);
  const audioPower = useMotionValue(0);
  const lines = useMemo(() => toFoliaLines(state), [state]);
  const rawMode = (state.settings?.preset ?? "folia-classic").replace(/^folia-/, "");
  const mode = (FOLIA_MODES.has(rawMode) ? rawMode : "classic") as FoliaMode;
  const tunings = state.settings?.foliaTuningEnabled?.[mode] === false ? undefined : state.settings?.foliaTunings;
  const appearance = state.settings?.foliaAppearance;
  const showBackground = appearance?.showOriginalBackground === true;
  const assets = state.settings?.foliaAssets;
  useFoliaFont("RustMusicFoliaLyrics", appearance?.fontFile);
  useFoliaFont("RustMusicFoliaSubtitles", appearance?.subtitleFontFile);
  const theme = useMemo(() => resolveTheme(mode, appearance ?? {}), [mode, appearance]);
  const subtitleTheme = useMemo<Theme | undefined>(() => appearance?.subtitleFontInheritsLyrics === false
    ? { ...theme, fontStyle: appearance.subtitleFontStyle ?? "sans", fontFamily: appearance.subtitleFontFile ? "RustMusicFoliaSubtitles" : appearance.subtitleFontFamily, fontWeight: appearance.subtitleFontWeight }
    : undefined, [theme, appearance]);
  const subtitleContentMode = appearance?.subtitleContentMode ?? state.altMode ?? "translation";
  const fitScale = viewport.width > 0 && viewport.height > 0
    ? Math.max(0.5, Math.min(1, (viewport.width / viewport.height) / (16 / 9)))
    : 1;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rendererProps = useMemo<VisualizerSharedProps>(() => applyVisualizerTuning(mode, {
    currentTime,
    currentLineIndex,
    lines,
    theme,
    duration: Math.max(0, (state.durationMs ?? 0) / 1000),
    audioPower,
    audioBands: EMPTY_BANDS,
    songTitle: state.title,
    songArtist: state.artist,
    coverUrl: state.cover,
    seed: state.trackKey || "rustmusic",
    showText: true,
    paused: !state.playing,
    staticMode: false,
    isPlayerChromeHidden: true,
    lyricsFontScale: appearance?.lyricsFontScale,
    subtitleTheme,
    subtitleFontScale: appearance?.subtitleFontScale,
    subtitleOverlayOpacity: appearance?.subtitleOverlayOpacity,
    subtitleOverlayBackground: appearance?.subtitleOverlayBackground,
    subtitleUpcomingLyricsBlur: appearance?.subtitleUpcomingLyricsBlur,
    hideTranslationSubtitle: appearance?.hideTranslationSubtitle,
    showSubtitleTranslation: subtitleContentMode !== "none",
    subtitleContentMode,
    subtitleOverlayLayout: parseSubtitleOverlayLayout(appearance?.subtitleOverlayLayout) ?? `${state.altMode ?? "translation"}|only`,
    showHarmonySubtitle: appearance?.showHarmonySubtitle,
    harmonySubtitleBackground: appearance?.harmonySubtitleBackground,
    cappellaCustomEmojiImages: imageUrls(assets?.emoji),
    cappellaCustomAvatarImages: imageUrls(assets?.avatar),
    monetPortraitImage: imageUrls(assets?.monet)?.[0],
    temperaLayerImageAssets: imageUrls(assets?.tempera),
    background: { transparent: !showBackground },
  }, (tunings?.[mode] ? {
    [mode]: { ...getFoliaTuningDefaults()[mode] as Record<string, unknown>, ...tunings[mode] as Record<string, unknown> },
  } : {}) as VisualizerTuningBundle), [audioPower, currentTime, currentLineIndex, lines, mode, theme, subtitleTheme, subtitleContentMode, appearance, assets, state, tunings, showBackground]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const latest = live.current;
      const incoming = latest.state;
      const elapsed = incoming.playing ? performance.now() - latest.receivedAt : 0;
      const ms = Math.max(0, (incoming.positionMs ?? 0) + elapsed + (incoming.lyricOffsetMs ?? 0));
      const seconds = ms / 1000;
      currentTime.set(seconds);
      const spectrum = incoming.audioSpectrum;
      const activeSpectrum = spectrum && (spectrum.ageMs ?? 0) < 350 ? spectrum.bands ?? [] : [];
      const average = (start: number, end: number) => {
        const values = activeSpectrum.slice(start, end);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      };
      EMPTY_BANDS.bass.set(average(0, 6));
      EMPTY_BANDS.lowMid.set(average(6, 12));
      EMPTY_BANDS.mid.set(average(12, 20));
      EMPTY_BANDS.vocal.set(average(17, 27));
      EMPTY_BANDS.treble.set(average(27, 36));
      EMPTY_BANDS.spectrum.set(Uint8Array.from(activeSpectrum, (value) => Math.max(0, Math.min(255, Math.round(value * 255)))));
      audioPower.set(spectrum && (spectrum.ageMs ?? 0) < 350 ? spectrum.level ?? 0 : 0);
      let active = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startTime <= seconds) active = i;
        else break;
      }
      setCurrentLineIndex((previous) => previous === active ? previous : active);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioPower, currentTime, lines, live]);

  const Renderer = MODE_COMPONENTS[mode];
  let visualizer: React.ReactNode;
  switch (mode) {
    case "cadenza":
      visualizer = <Renderer {...rendererProps} cadenzaTuning={{
        ...DEFAULT_CADENZA_TUNING,
        ...(tunings?.cadenza as Partial<typeof DEFAULT_CADENZA_TUNING> | undefined),
      }} />;
      break;
    case "hanabi":
      visualizer = <Renderer {...rendererProps} hanabiTuning={{
        ...hanabiTuning.read(rendererProps.visualizerTunings),
        ...(!showBackground ? { sky: 0 } : {}),
      }} />;
      break;
    case "machi":
      visualizer = <Renderer {...rendererProps} machiTuning={machiTuning.read(rendererProps.visualizerTunings)} />;
      break;
    case "metaphor":
      visualizer = <Renderer {...rendererProps} metaphorTuning={metaphorTuning.read(rendererProps.visualizerTunings)} />;
      break;
    case "monet": {
      visualizer = <Renderer {...rendererProps} monetTuning={{
        ...DEFAULT_MONET_TUNING,
        ...(tunings?.monet as Partial<typeof DEFAULT_MONET_TUNING> | undefined),
      }} />;
      break;
    }
    case "nebbia":
      visualizer = <Renderer {...rendererProps} nebbiaTuning={nebbiaTuning.read(rendererProps.visualizerTunings)} />;
      break;
    case "pendolo":
      visualizer = <Renderer key={rendererProps.seed} {...rendererProps} />;
      break;
    default:
      visualizer = <Renderer {...rendererProps} />;
  }
  const originalBackground = showBackground ? getVisualizerRegistryEntry(mode).background : false;
  return (
    <LyricRenderQualityGlobalContext.Provider value={normalizeLyricRenderQuality(appearance?.renderQuality)}>
      <VisualizerBackdropContext.Provider value={FRAME}>
        <div ref={viewportRef} className="relative h-full w-full overflow-hidden" style={{ background: "transparent", fontFamily: theme.fontFamily }}>
          {showBackground && originalBackground !== false && <div data-folia-original-background className="pointer-events-none absolute inset-0"><Suspense fallback={null}>
            <VisualizerBackgroundRenderer theme={theme} audioPower={audioPower} audioBands={EMPTY_BANDS}
              config={originalBackground?.(rendererProps) ?? rendererProps.background}
              coverUrl={rendererProps.coverUrl} seed={rendererProps.seed} isDaylight={false}
              paused={rendererProps.paused ?? false} staticMode={false} />
          </Suspense></div>}
          <div className="absolute inset-0" style={{ transform: `scale(${fitScale})`, transformOrigin: "center", opacity: appearance?.visualizerOpacity, ["--folia-glow-color" as string]: theme.glowColor }}>
            <Suspense fallback={null}>{visualizer}</Suspense>
            <VisualizerHarmonyOverlay
              currentTime={currentTime}
              lines={lines}
              showText={true}
              theme={theme}
              isPlayerChromeHidden
              showHarmonySubtitle={appearance?.showHarmonySubtitle ?? false}
              harmonySubtitleBackground={appearance?.harmonySubtitleBackground ?? false}
            />
          </div>
        </div>
      </VisualizerBackdropContext.Provider>
    </LyricRenderQualityGlobalContext.Provider>
  );
}

function App() {
  const [state, setState] = useState<OverlayState | null>(null);
  const live = React.useRef({ state: {} as OverlayState, receivedAt: performance.now() });
  const previewSettings = React.useRef<OverlayState["settings"] | null>(null);
  useEffect(() => {
    let active = true;
    let timer = 0;
    const renderKey = (value: OverlayState) => JSON.stringify({
      trackKey: value.trackKey,
      title: value.title,
      artist: value.artist,
      cover: value.cover,
      durationMs: value.durationMs,
      lyricOffsetMs: value.lyricOffsetMs,
      playing: value.playing,
      altMode: value.altMode,
      lyrics: value.lyrics,
      settings: value.settings,
      canvasEnabled: value.canvasEnabled,
    });
    const publish = (value: OverlayState) => {
      live.current = { state: value, receivedAt: performance.now() };
      setState((previous) => !previous || renderKey(previous) !== renderKey(value)
        ? { ...value, audioSpectrum: undefined }
        : previous);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.type !== "obs-preview-settings" || !event.data.settings) return;
      if (!previewSettings.current) {
        parent.postMessage({ type: "folia-tuning-defaults", defaults: getFoliaTuningDefaults() }, event.origin);
      }
      previewSettings.current = event.data.settings as OverlayState["settings"];
      publish({ ...live.current.state, settings: previewSettings.current ?? undefined });
    };
    const poll = async () => {
      try {
        const canvasId = /^\/canvas\/([a-zA-Z0-9-]+)$/.exec(location.pathname)?.[1];
        const response = await fetch("/state" + (canvasId ? "?canvas=" + canvasId : ""), { cache: "no-store" });
        if (!response.ok) throw new Error(`Folia state request failed: ${response.status}`);
        const next = await response.json() as OverlayState;
        document.documentElement.style.visibility = next.canvasEnabled === false ? "hidden" : "";
        if (canvasId && next.canvasEnabled === false) { location.reload(); return; }
        if ((canvasId || location.pathname === "/lyrics" || location.pathname === "/lyrics/") && !previewSettings.current && !next.settings?.preset?.startsWith("folia-")) {
          location.reload();
          return;
        }
        if (previewSettings.current) next.settings = previewSettings.current;
        publish(next);
      } catch {
        // Keep the overlay transparent while the local player is unavailable.
      }
      if (active) timer = window.setTimeout(poll, 66);
    };
    window.addEventListener("message", onMessage);
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    if (window.parent !== window) {
      window.parent.postMessage({ type: "folia-tuning-defaults", defaults: getFoliaTuningDefaults() }, "*");
    }
  }, []);
  return state && state.canvasEnabled !== false ? <FoliaOverlay state={state} live={live} /> : null;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(location.hash === "#settings"
  ? <Suspense fallback={null}><Settings /></Suspense>
  : <App />);
