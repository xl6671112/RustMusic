import { usePlayerPopover } from "./usePlayerPopover";
import {
  PictureInPicture2,
  ChevronUp,
  Heart,
  ListMusic,
  Pause,
  Play,
  FastForward,
  Repeat,
  Repeat1,
  Rewind,
  Shuffle,
  SkipBack,
  SkipForward,
  Timer,
  SlidersHorizontal,
  Volume1,
  Volume2,
  VolumeX,
  Minus,
  Plus,
  RotateCcw,
  RefreshCw,
  Captions,
  Copy,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { formatQualityLabel, useI18n } from "../i18n";
import CoverImg from "./CoverImg";
import Slider from "./Slider";
import { fmtTime } from "../utils";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import AccompanimentTasks from "./AccompanimentTasks";
import AiTrackButton from "./AiTrackButton";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const WEB_LYRICS_URL = "http://127.0.0.1:17842/lyrics";

/** 底部并排显示曲名与当前歌词行（随 pos 换行，溢出走 marquee）。
 *  pos 是 250ms 一帧的高频更新——隔离在这个小组件里，播放条主体不再每帧重渲染 */
function TrackTitleLyric() {
  const { tr } = useI18n();
  const pos = useStore((s) => s.pos);
  const lyrics = useStore((s) => s.lyrics);
  const current = useStore((s) => s.current);
  const nowPlayingOpen = useStore((s) => s.nowPlayingOpen);
  const setNowPlayingOpen = useStore((s) => s.setNowPlayingOpen);

  const timedLines = useMemo(
    () =>
      lyrics?.synced
        ? lyrics.lines
            .filter((l) => l.timeMs != null && l.text.trim() !== "")
            .sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0))
        : [],
    [lyrics]
  );
  const activeLyric = useMemo(() => {
    if (!timedLines.length) return null;
    let lo = 0;
    let hi = timedLines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((timedLines[mid].timeMs ?? 0) <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans >= 0 ? { text: timedLines[ans].text } : null;
  }, [nowPlayingOpen, timedLines, pos]);

  const lyricWrapRef = useRef<HTMLDivElement>(null);
  const [lyricOverflow, setLyricOverflow] = useState(false);
  const overflowText = activeLyric?.text;
  useEffect(() => {
    const el = lyricWrapRef.current;
    if (!el || overflowText == null) {
      setLyricOverflow(false);
      return;
    }
    const measure = () => {
      const e2 = lyricWrapRef.current;
      if (e2) setLyricOverflow(e2.scrollWidth > e2.clientWidth + 1);
    };
    requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [overflowText]);

  if (!current) return null;
  return (
    <div className="player-dock-caption" onClick={() => setNowPlayingOpen(!nowPlayingOpen)}>
      <div className="flex min-w-0 items-center font-semibold text-[var(--ink)]" title={`${current.title} · ${current.artist}`}>
        <span className="min-w-0 truncate">{current.title}<span className="ml-2 font-normal text-[var(--ink-3)]">{current.artist}</span></span>
        {current.quality && current.quality !== "0kbps" && <span className="ml-2 shrink-0 text-[10px] text-[var(--accent-strong)]">{formatQualityLabel(current.quality)}</span>}
      </div>
      <div ref={lyricWrapRef} className={`min-w-0 overflow-hidden whitespace-nowrap text-[var(--accent-strong)] ${lyricOverflow ? "marquee-wrap" : ""}`}
        title={tr("点击展开播放页", "Click to open Now Playing")}>
        {activeLyric ? <span className={lyricOverflow ? "marquee-inner" : ""} style={{ ["--dur" as string]: `${Math.max(9, activeLyric.text.length * 0.55)}s` }}>
          {activeLyric.text}{lyricOverflow && <><span className="inline-block w-14" />{activeLyric.text}<span className="inline-block w-14" /></>}
        </span> : <span className="text-[var(--ink-3)]">{tr("暂无当前歌词", "No current lyric")}</span>}
      </div>
    </div>
  );
}

/** 中部进度区：时间 + 滑块 + 悬停时间气泡。pos/dur 的高频订阅隔离于此。 */
function Playhead({ fallbackTotal }: { fallbackTotal: number }) {
  const pos = useStore((s) => s.pos);
  const dur = useStore((s) => s.dur);
  const seek = useStore((s) => s.seek);
  const setScrubbing = useStore((s) => s.setScrubbing);
  const total = dur || fallbackTotal || 0;
  const [dragVal, setDragVal] = useState<number | null>(null);
  const shown = dragVal ?? pos;
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ratioOf = (clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
  };
  return (
    <div className="w-full max-w-[540px] flex items-center gap-3">
      <span className="text-[11px] text-[var(--ink-3)] tabular-nums w-9 text-right">
        {fmtTime(shown)}
      </span>
      <div
        ref={barRef}
        className="relative flex-1"
        onPointerMove={(e) => {
          if (dragVal != null) return;
          setHoverRatio(ratioOf(e.clientX));
        }}
        onPointerLeave={() => setHoverRatio(null)}
      >
        <Slider
          value={pos}
          max={total || 1}
          onChange={(v) => {
            if (dragVal == null) {
              setScrubbing(true);
              setHoverRatio(null);
            }
            setDragVal(v);
          }}
          onCommit={(v) => {
            setDragVal(null);
            seek(v);
          }}
          onCancel={() => {
            setDragVal(null);
            setScrubbing(false);
          }}
          className="w-full"
        />
        {hoverRatio != null && total > 0 && (
          <span
            className="pointer-events-none absolute -top-7 -translate-x-1/2 text-[10.5px] px-1.5 py-0.5 rounded-md text-[var(--ink)] glass-strong tabular-nums"
            style={{ left: `${hoverRatio * 100}%` }}
          >
            {fmtTime(hoverRatio * total)}
          </span>
        )}
      </div>
      <span className="text-[11px] text-[var(--ink-3)] tabular-nums w-9">
        {fmtTime(total)}
      </span>
    </div>
  );
}

/** 竖向音量弹出条 */
function VolumePopover({
  volume,
  onSet,
  muted,
  onToggleMute,
  onClose,
  uiTheme,
}: {
  volume: number;
  onSet: (v: number) => void;
  muted: boolean;
  onToggleMute: () => void;
  onClose: () => void;
  uiTheme: string;
}) {
  const { tr } = useI18n();
  const H = 140;
  const y = (1 - volume) * H;
  const isSkeuo = uiTheme === "skeuo";
  const isLiquid = uiTheme === "liquid";

  const onPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = 1 - (e.clientY - rect.top) / rect.height;
    onSet(Math.min(1, Math.max(0, ratio)));
  };

  return (
    <>
      <div
        className={`absolute ${
          isLiquid ? "bottom-[52px]" : "bottom-[48px]"
        } right-0 z-[61] ${
          isLiquid || isSkeuo ? "w-14 p-2.5 gap-2" : "w-13 p-2 gap-1.5"
        } rounded-2xl flex flex-col items-center glass-strong`}
        style={isLiquid ? undefined : { boxShadow: "var(--bar-shadow)" }}
      >
        {isSkeuo ? (
          <button
            className="btn-ghost !w-auto !min-w-[32px] !h-6 !px-1.5 !text-[10px] !font-bold whitespace-nowrap"
            onClick={onToggleMute}
            title={muted ? tr("取消静音", "Unmute") : tr("静音", "Mute")}
          >
            {muted ? tr("有声", "Unmute") : tr("静音", "Mute")}
          </button>
        ) : isLiquid ? (
          <button
            className="liquid-pill !py-0.5 !px-2 text-[10px] font-semibold text-[var(--ink)] whitespace-nowrap"
            onClick={onToggleMute}
            title={muted ? tr("取消静音", "Unmute") : tr("静音", "Mute")}
          >
            {muted ? tr("有声", "Unmute") : tr("静音", "Mute")}
          </button>
        ) : (
          <button
            className="min-w-[28px] h-6 px-1.5 rounded-lg flex items-center justify-center text-[10px] font-semibold text-[var(--ink-2)] hover:bg-[var(--shade-strong)] hover:text-[var(--ink)] transition-colors whitespace-nowrap"
            onClick={onToggleMute}
            title={muted ? tr("取消静音", "Unmute") : tr("静音", "Mute")}
          >
            {muted ? tr("有声", "Unmute") : tr("静音", "Mute")}
          </button>
        )}

        <div
          className={`relative ${
            isSkeuo
              ? "w-3"
              : isLiquid
              ? "w-2 border border-[var(--line)] shadow-inner"
              : "w-1.5"
          } rounded-full cursor-pointer touch-none ${
            !isSkeuo ? "bg-[var(--shade-strong)]" : ""
          }`}
          style={
            isSkeuo
              ? {
                  height: H,
                  background: "var(--sk-groove-bg)",
                  border: "1px solid var(--sk-groove-border)",
                  boxShadow: "var(--sk-groove-shadow)",
                }
              : { height: H }
          }
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            onPointer(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            onPointer(e);
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          onPointerCancel={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        >
          <div
            className={`absolute ${
              isSkeuo ? "left-0.5 right-0.5 bottom-0.5" : "left-0 right-0 bottom-0"
            } rounded-full`}
            style={{
              height: Math.max(isLiquid ? 3 : 2, H - y),
              background: "linear-gradient(180deg, var(--accent-strong), var(--accent))",
              boxShadow: isLiquid
                ? "0 0 8px var(--accent-soft)"
                : isSkeuo
                ? "0 0 6px var(--accent-soft)"
                : undefined,
            }}
          />
          {isSkeuo ? (
            <div
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-3 rounded-[3px] flex items-center justify-center transition-transform"
              style={{
                top: y,
                background: "var(--sk-knob-metal)",
                border: "1px solid var(--sk-edge)",
                boxShadow: "var(--sk-knob-shadow)",
              }}
            >
              <span className="w-2.5 h-[1px] bg-red-600 shadow-[0_0_2px_red]" />
            </div>
          ) : (
            <div
              className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 ${
                isLiquid
                  ? "w-4 h-4 shadow-[0_2px_8px_rgba(0,0,0,0.4),0_0_10px_var(--accent-soft)] border border-white/80"
                  : "w-3.5 h-3.5 shadow"
              } rounded-full bg-white`}
              style={{ top: y }}
            />
          )}
        </div>
      </div>
    </>
  );
}

/** 定时停止弹出菜单 */
function SleepPopover({
  sleepAt,
  onSet,
  onMode,
  stopAfterTrack,
  stopAfterQueue,
  onClose,
  uiTheme,
}: {
  sleepAt: number | null;
  onSet: (min: number | null) => void;
  onMode: (mode: "track" | "queue" | null) => void;
  stopAfterTrack: boolean;
  stopAfterQueue: boolean;
  onClose: () => void;
  uiTheme: string;
}) {
  const { tr } = useI18n();
  const isLiquid = uiTheme === "liquid";
  const remainMin = sleepAt
    ? Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))
    : null;
  const [custom, setCustom] = useState("");
  const applyCustom = () => {
    const n = Math.round(Number(custom));
    if (!isFinite(n) || n <= 0) return;
    onSet(Math.min(1440, n));
    onClose();
  };
  return (
    <>
      <div
        className={`absolute ${
          isLiquid ? "bottom-[52px] min-w-[200px] p-2" : "bottom-[48px] min-w-[196px] p-1.5"
        } right-0 z-[61] rounded-2xl flex flex-col glass-strong`}
        style={isLiquid ? undefined : { boxShadow: "var(--bar-shadow)" }}
      >
        {remainMin != null && (
          <div className="px-2.5 py-1 text-[11px] text-[var(--accent-strong)] font-semibold whitespace-nowrap">
            {tr(`剩余约 ${remainMin} 分钟`, `About ${remainMin} min left`)}
          </div>
        )}
        {[15, 30, 45, 60, 90].map((m) => (
          <button
            key={m}
            className={`w-full h-8 px-2.5 rounded-lg flex items-center text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left whitespace-nowrap ${
              isLiquid ? "transition-colors" : ""
            }`}
            onClick={() => {
              onSet(m);
              onClose();
            }}
          >
            {tr(`${m} 分钟后停止`, `Stop in ${m} min`)}
          </button>
        ))}
        <div className="my-1 h-px bg-[var(--line)]" />
        <button
          className={`w-full h-8 px-2.5 rounded-lg flex items-center text-[12.5px] hover:bg-[var(--shade-strong)] text-left whitespace-nowrap ${
            isLiquid ? "transition-colors " : ""
          }${
            stopAfterTrack ? "text-[var(--accent-strong)] font-semibold" : "text-[var(--ink)]"
          }`}
          onClick={() => {
            onMode("track");
            onClose();
          }}
        >
          {tr("播完当前歌曲后停止", "Stop after current track")}
        </button>
        <button
          className={`w-full h-8 px-2.5 rounded-lg flex items-center text-[12.5px] hover:bg-[var(--shade-strong)] text-left whitespace-nowrap ${
            isLiquid ? "transition-colors " : ""
          }${
            stopAfterQueue ? "text-[var(--accent-strong)] font-semibold" : "text-[var(--ink)]"
          }`}
          onClick={() => {
            onMode("queue");
            onClose();
          }}
        >
          {tr("播完当前列表后停止", "Stop after current queue")}
        </button>
        <div className="flex items-center gap-1 px-1 pt-1.5">
          <input
            type="number"
            min={1}
            max={1440}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyCustom()}
            placeholder={tr("自定义(分钟)", "Custom (min)")}
            className={
              isLiquid
                ? "w-full min-w-0 h-7 rounded-lg liquid-input px-2 text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-3)] outline-none"
                : "w-full min-w-0 h-7 rounded-lg bg-[var(--shade)] border border-[var(--line)] px-2 text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-3)] outline-none focus:border-[var(--accent)]"
            }
          />
          <button
            className="btn-secondary !py-1 !px-2 text-[11px] shrink-0 disabled:opacity-50"
            onClick={applyCustom}
            disabled={!custom.trim() || !isFinite(Number(custom)) || Number(custom) <= 0}
            title={tr("按输入的分钟数定时", "Set custom timer (min)")}
          >
            {tr("确定", "Set")}
          </button>
        </div>
        {(sleepAt != null || stopAfterTrack || stopAfterQueue) && (
          <button
            className="w-full h-8 px-2.5 rounded-lg flex items-center text-[12.5px] text-[#e0533f] hover:bg-[var(--shade-strong)] text-left whitespace-nowrap"
            onClick={() => {
              onSet(null);
              onMode(null);
              onClose();
            }}
          >
            {tr("取消定时", "Cancel Timer")}
          </button>
        )}
      </div>
    </>
  );
}

export default function PlayerBar({ centered = false, aiControls }: { centered?: boolean; aiControls?: ReactNode }) {
  const { tr } = useI18n();
  const uiTheme = useStore((s) => s.uiTheme);
  const isSkeuo = uiTheme === "skeuo";
  const isLiquid = uiTheme === "liquid";
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const measure = () => document.documentElement.style.setProperty("--player-dock-height", `${Math.ceil(dock.getBoundingClientRect().height) + 8}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, []);


  const current = useStore((s) => s.current);
  const playing = useStore((s) => s.playing);
  const volume = useStore((s) => s.volume);
  const sleepAt = useStore((s) => s.sleepAt);
  const setSleepTimer = useStore((s) => s.setSleepTimer);
  const sleepStopAfterTrack = useStore((s) => s.sleepStopAfterTrack);
  const sleepStopAfterQueue = useStore((s) => s.sleepStopAfterQueue);
  const setSleepMode = useStore((s) => s.setSleepMode);
  const speed = useStore((s) => s.speed);
  const repeat = useStore((s) => s.repeat);
  const shuffle = useStore((s) => s.shuffle);
  const download = useStore((s) => s.download);
  const queue = useStore((s) => s.queue);
  const queueOpen = useStore((s) => s.queueOpen);
  const nowPlayingOpen = useStore((s) => s.nowPlayingOpen);
  const desktopLyricsOn = useStore((s) => s.desktopLyricsOn);
  const desktopLyricsLock = useStore((s) => s.desktopLyricsLock);
  const neteaseLiked = useStore((s) => s.neteaseLiked);
  const neteaseToggleLike = useStore((s) => s.neteaseToggleLike);
  const savedOnline = useStore((s) => s.savedOnline);
  const likedOnline = useStore((s) => s.likedOnline);
  const recentOnline = useStore((s) => s.recentOnline);
  const toggleLikeOnline = useStore((s) => s.toggleLikeOnline);
  const togglePlay = useStore((s) => s.togglePlay);
  const next = useStore((s) => s.next);
  const prev = useStore((s) => s.prev);
  const seekForward = useStore((s) => s.seekForward);
  const seekBackward = useStore((s) => s.seekBackward);
  const setVolume = useStore((s) => s.setVolume);
  const setSpeed = useStore((s) => s.setSpeed);
  const setRepeat = useStore((s) => s.setRepeat);
  const toggleShuffle = useStore((s) => s.toggleShuffle);
  const toggleLike = useStore((s) => s.toggleLike);
  const setNowPlayingOpen = useStore((s) => s.setNowPlayingOpen);
  const setQueueOpen = useStore((s) => s.setQueueOpen);
  const miniPlayer = useStore((s) => s.miniPlayer);
  const setMiniPlayer = useStore((s) => s.setMiniPlayer);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<number>("player://volume", ({ payload }) => {
      if (Number.isFinite(payload)) useStore.setState({ volume: Math.min(1, Math.max(0, payload)) });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, []);

  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  const [volOpen, setVolOpen] = usePlayerPopover("vol");
  const volBtnRef = useRef<HTMLButtonElement>(null);
  const lastVolRef = useRef(0.8);
  const [sleepOpen, setSleepOpen] = usePlayerPopover("sleep");
  const [vocalOpen, setVocalOpen] = usePlayerPopover("vocal");
  const [vocalAmount, setVocalAmount] = useState(0);
  const [vocalInstalled, setVocalInstalled] = useState(false);
  const [outputOpen, setOutputOpen] = usePlayerPopover("output");
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputSwitching, setOutputSwitching] = useState(false);
  const [outputError, setOutputError] = useState("");
  const [outputDevices, setOutputDevices] = useState<{ name: string; isDefault: boolean }[]>([]);
  const [outputCurrent, setOutputCurrent] = useState("");
  const [outputPreference, setOutputPreference] = useState<string | null>(null);
  const [pitchOpen, setPitchOpen] = usePlayerPopover("pitch");
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchSaving, setPitchSaving] = useState(false);
  const [pitchShift, setPitchShift] = useState(0);
  const pitchRevisionRef = useRef(0);
  const [webLyricsOpen, setWebLyricsOpen] = usePlayerPopover("webLyrics");
  const [webLyricsCopied, setWebLyricsCopied] = useState(false);
  const webLyricsAnchor = useRef<HTMLDivElement>(null);
  const webLyricsWidth = 370;
  const [webLyricsPosition, setWebLyricsPosition] = useState({ bottom: 140, right: 12 });
  useEffect(() => {
    if (!webLyricsOpen) return;
    const position = () => {
      const anchor = webLyricsAnchor.current?.getBoundingClientRect();
      if (!anchor) return;
      setWebLyricsPosition({
        bottom: Math.max(12, window.innerHeight - anchor.top + 12),
        right: Math.max(12, Math.min(window.innerWidth - anchor.right, window.innerWidth - Math.min(webLyricsWidth, window.innerWidth - 24) - 12)),
      });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [webLyricsOpen, uiTheme, centered]);
  useEffect(() => {
    if (webLyricsOpen) setWebLyricsCopied(false);
  }, [webLyricsOpen]);

  const refreshOutputDevices = async () => {
    setOutputLoading(true);
    try {
      const state = await api.listOutputDevices();
      setOutputDevices(state.devices);
      setOutputCurrent(state.current);
      setOutputPreference(state.preference);
      setOutputError("");
      return state;
    } catch (error) {
      setOutputError(String(error));
      return null;
    } finally {
      setOutputLoading(false);
    }
  };

  const changeOutputDevice = async (name: string) => {
    setOutputSwitching(true);
    setOutputError("");
    try {
      await api.setOutputDevice(name || null);
      const actual = await api.listOutputDevices();
      setOutputDevices(actual.devices);
      setOutputCurrent(actual.current);
      setOutputPreference(actual.preference);
      const expectedCurrent = name || actual.devices.find((device) => device.isDefault)?.name;
      if (actual.preference !== (name || null) || (expectedCurrent ? actual.current !== expectedCurrent : !actual.current)) {
        throw new Error(tr("输出设备已请求切换，但当前生效设备未确认", "Output switch was requested, but the active device could not be confirmed"));
      }
    } catch (error) {
      const message = String(error);
      await refreshOutputDevices();
      setOutputError(message);
    } finally {
      setOutputSwitching(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("player://output-device", () => void refreshOutputDevices()).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => useStore.getState().toast(String(error), "error"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const refreshPitchShift = async () => {
    setPitchLoading(true);
    const revision = pitchRevisionRef.current;
    try {
      const value = await invoke<number>("get_pitch_shift");
      if (!Number.isFinite(value)) throw new Error("Invalid pitch shift returned by audio engine");
      if (revision === pitchRevisionRef.current) setPitchShift(Math.max(-12, Math.min(12, Math.round(value))));
    } catch (error) {
      useStore.getState().toast(String(error), "error");
    } finally {
      setPitchLoading(false);
    }
  };

  const changePitchShift = async (semitones: number) => {
    const next = Math.max(-12, Math.min(12, Math.round(semitones)));
    setPitchSaving(true);
    try {
      await invoke("set_pitch_shift", { semitones: next });
      const revision = pitchRevisionRef.current;
      const actual = await invoke<number>("get_pitch_shift");
      if (!Number.isFinite(actual)) throw new Error("Invalid pitch shift returned by audio engine");
      if (revision === pitchRevisionRef.current) setPitchShift(Math.max(-12, Math.min(12, Math.round(actual))));
    } catch (error) {
      useStore.getState().toast(String(error), "error");
    } finally {
      setPitchSaving(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<number>("player://pitch", ({ payload }) => {
      if (!Number.isFinite(payload)) return;
      pitchRevisionRef.current += 1;
      setPitchShift(Math.max(-12, Math.min(12, Math.round(payload))));
    }).then((stop) => {
      if (disposed) stop();
      else {
        unlisten = stop;
        void refreshPitchShift();
      }
    }).catch((error) => useStore.getState().toast(String(error), "error"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void invoke<{ installed: boolean; supportedPlatform: boolean }>("vocal_removal_status")
      .then((status) => { if (!disposed) setVocalInstalled(status.installed && status.supportedPlatform); })
      .catch(() => { if (!disposed) setVocalInstalled(false); });
    void invoke<number>("get_vocal_removal")
      .then((amount) => { if (!disposed && Number.isFinite(amount)) setVocalAmount(amount); })
      .catch(() => {});
    void listen<number>("player://vocal-removal", ({ payload }) => {
      if (Number.isFinite(payload)) setVocalAmount(Math.max(0, Math.min(100, payload)));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div
      ref={dockRef}
      className={`player-dock-wrap anim-bar absolute bottom-0 right-0 z-50 ${
        isLiquid
          ? `pl-3 pr-2 pb-2 pt-1 ${centered ? "left-0" : "left-[250px]"}`
          : `px-6 pb-4 pt-1 ${centered ? "left-0" : "left-[236px]"}`
      }`}
    >
      {download && (
        <button
          className="absolute right-8 top-1 z-10 btn-ghost !w-auto !px-2 !h-6 text-[10px] whitespace-nowrap text-[var(--ink-3)] hover:text-[var(--ink)]"
          onClick={() => useStore.getState().cancelDownloadQueue()}
          title={tr("取消排队中的批量下载（正在执行的当前这一个不受影响）", "Cancel queued batch downloads (active download continues)")}
        >
          {tr("取消排队", "Cancel queue")}
        </button>
      )}
      {download && (
        <div className="absolute left-8 right-24 top-0 h-[3px] bg-[var(--shade)] rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-300 rounded-full"
            style={{
              width: `${download.pct}%`,
              background: "var(--accent)",
            }}
          />
        </div>
      )}

      <div
        data-layout="bar"
        className={
          isSkeuo
            ? `h-[74px] rounded-[18px] flex items-center pl-4 pr-5 gap-3 max-[1300px]:h-auto max-[1300px]:min-h-[74px] max-[1300px]:flex-wrap max-[1300px]:gap-x-2 max-[1300px]:gap-y-1 transition-opacity duration-300 ${
                nowPlayingOpen ? "opacity-80 hover:opacity-100" : ""
              }`
            : isLiquid
            ? `h-[70px] rounded-2xl flex items-center pl-4 pr-4 gap-3 max-[1300px]:h-auto max-[1300px]:min-h-[70px] max-[1300px]:flex-wrap max-[1300px]:gap-x-2 max-[1300px]:gap-y-1 transition-all duration-300 liquid-dock relative z-10 ${
                nowPlayingOpen ? "opacity-90 hover:opacity-100" : ""
              }`
            : `h-[64px] rounded-[18px] flex items-center pl-4 pr-4 gap-3 max-[1300px]:h-auto max-[1300px]:min-h-[64px] max-[1300px]:flex-wrap max-[1300px]:gap-x-2 max-[1300px]:gap-y-1 transition-opacity duration-300 ${
                nowPlayingOpen ? "opacity-80 hover:opacity-100" : ""
              }`
        }
        style={
          isLiquid
            ? undefined
            : isSkeuo
            ? {
                background: "var(--bar-glass)",
                border: "1px solid var(--bar-line)",
                boxShadow: "var(--bar-shadow)",
              }
            : {
                background: "var(--bar-glass)",
                boxShadow: "var(--bar-shadow)",
              }
        }
      >
        <div data-layout="track" className="player-dock-cover">
          <button className="group relative shrink-0" onClick={() => setNowPlayingOpen(!nowPlayingOpen)}
            title={tr("展开 / 收起播放页", "Toggle Now Playing")}>
            <CoverImg src={current?.cover} seed={current?.title ?? "RustMusic"} small
              className="w-[48px] h-[48px] rounded-xl shadow-[var(--cover-shadow-sm)]" iconSize={22} />
          </button>
        </div>

        <div data-layout="center" className="flex-1 flex flex-col items-center justify-center gap-1 min-w-[260px] max-[1300px]:flex-1 max-[1300px]:basis-[260px] max-[1300px]:min-w-[260px]">
          <div className="flex items-center gap-1.5 max-[1100px]:gap-1">
            <button
              className={`btn-ghost ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"} ${shuffle ? "!text-[var(--accent)]" : ""}`}
              onClick={toggleShuffle}
              title={tr("随机播放", "Shuffle")}
            >
              <Shuffle size={15} />
            </button>
            <button
              className={`btn-ghost ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"}`}
              onClick={prev}
              title={tr("上一首", "Previous")}
            >
              <SkipBack size={16} className="fill-current" />
            </button>
            <button
              className={`btn-ghost ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"} disabled:opacity-40`}
              disabled={!current}
              onClick={() => seekBackward(5000)}
              title={tr("快退 5 秒（←）", "Rewind 5s (←)")}
            >
              <Rewind size={16} className="fill-current" />
            </button>
            {isSkeuo ? (
              <button
                className="w-[40px] h-[40px] rounded-full flex items-center justify-center text-[var(--accent-on)] transition-transform hover:scale-105 active:scale-95 shadow-[var(--sk-raised-shadow)]"
                style={{
                  background: "linear-gradient(135deg, var(--accent-strong) 0%, var(--accent) 60%, var(--accent) 120%)",
                  border: "1px solid var(--sk-edge)",
                  boxShadow: "var(--sk-raised-shadow), 0 0 12px var(--accent-soft)",
                }}
                onClick={togglePlay}
                title={tr("播放 / 暂停（空格）", "Play / Pause (Space)")}
              >
                {playing ? (
                  <Pause size={18} className="fill-current" />
                ) : (
                  <Play size={18} className="fill-current ml-0.5" />
                )}
              </button>
            ) : isLiquid ? (
              <button
                className="w-[42px] h-[42px] play-btn shrink-0"
                onClick={togglePlay}
                title={tr("播放 / 暂停（空格）", "Play / Pause (Space)")}
              >
                {playing ? (
                  <Pause size={18} className="fill-current" />
                ) : (
                  <Play size={18} className="fill-current ml-0.5" />
                )}
              </button>
            ) : (
              <button
                className="w-[38px] h-[38px] rounded-full flex items-center justify-center text-[var(--accent-on)] hover:scale-105 active:scale-95 transition-transform"
                style={{
                  background: "linear-gradient(135deg, var(--accent-strong) 0%, var(--accent) 60%, var(--accent) 120%)",
                  boxShadow: "0 6px 20px -4px var(--accent-soft)",
                }}
                onClick={togglePlay}
                title={tr("播放 / 暂停（空格）", "Play / Pause (Space)")}
              >
                {playing ? (
                  <Pause size={17} className="fill-current" />
                ) : (
                  <Play size={17} className="fill-current ml-0.5" />
                )}
              </button>
            )}
            <button
              className={`btn-ghost ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"} disabled:opacity-40`}
              disabled={!current}
              onClick={() => seekForward(5000)}
              title={tr("快进 5 秒（→）", "Forward 5s (→)")}
            >
              <FastForward size={16} className="fill-current" />
            </button>
            <button
              className={`btn-ghost ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"}`}
              onClick={() => next(false)}
              title={tr("下一首", "Next")}
            >
              <SkipForward size={16} className="fill-current" />
            </button>
            <button
              className={`btn-ghost relative ${isSkeuo ? "w-[32px] h-[32px]" : "w-[30px] h-[30px]"} ${
                repeat !== "off" ? (isSkeuo ? "!text-[var(--accent-strong)]" : "!text-[var(--accent)]") : ""
              }`}
              onClick={() =>
                setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")
              }
              title={
                repeat === "off"
                  ? tr("列表循环", "Repeat All")
                  : repeat === "all"
                    ? tr("单曲循环", "Repeat One")
                    : tr("关闭循环", "Repeat Off")
              }
            >
              {repeat === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
              {isSkeuo && repeat !== "off" && (
                <span className="skeuo-led-on absolute top-1 right-1 !w-[4px] !h-[4px]" />
              )}
            </button>
            {current && <div className="flex items-center shrink-0" data-layout="favorite">
                {current.kind === "track" && current.id != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => toggleLike(current.id!)}
                    title={current.liked ? tr("取消喜欢", "Unlike") : tr("喜欢", "Like")}
                  >
                    <Heart
                      size={16}
                      className={current.liked ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
                {current.kind === "netease" && current.nid != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => neteaseToggleLike(current.nid!)}
                    title={
                      neteaseLiked[current.nid]
                        ? tr("取消收藏", "Unlike")
                        : tr("收藏到“我喜欢”", "Add to Liked")
                    }
                  >
                    <Heart
                      size={16}
                      className={neteaseLiked[current.nid] ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
                {current.kind === "qq" && current.qid != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => {
                      const entry = [ ...likedOnline, ...recentOnline ].find(
                        (e) => e.kind === "qq" && e.onlineId === current.qid
                      );
                      toggleLikeOnline({
                        kind: "qq",
                        id: current.qid!,
                        name: current.title,
                        artist: current.artist,
                        album: current.album,
                        cover: current.cover,
                        durationMs: current.durationMs,
                        mediaMid: entry?.mediaMid ?? "",
                        vip: entry?.vip ?? false,
                      });
                    }}
                    title={
                      savedOnline[`qq-${current.qid}`]
                        ? tr("取消喜欢", "Unlike")
                        : tr("收藏到“我喜欢”", "Add to Liked")
                    }
                  >
                    <Heart
                      size={16}
                      className={savedOnline[`qq-${current.qid}`] ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
                {current.kind === "bilibili" && current.qid != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => {
                      toggleLikeOnline({
                        kind: "bilibili",
                        id: current.qid!,
                        name: current.title,
                        artist: current.artist,
                        album: current.album,
                        cover: current.cover,
                        durationMs: current.durationMs,
                      });
                    }}
                    title={
                      savedOnline[`bilibili-${current.qid}`]
                        ? tr("取消喜欢", "Unlike")
                        : tr("收藏到“我喜欢”", "Add to Liked")
                    }
                  >
                    <Heart
                      size={16}
                      className={savedOnline[`bilibili-${current.qid}`] ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
                {current.kind === "navidrome" && current.qid != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => {
                      toggleLikeOnline({
                        kind: "navidrome",
                        id: current.qid!,
                        name: current.title,
                        artist: current.artist,
                        album: current.album,
                        cover: current.cover,
                        durationMs: current.durationMs,
                      });
                    }}
                    title={
                      savedOnline[`navidrome-${current.qid}`]
                        ? tr("取消喜欢", "Unlike")
                        : tr("收藏到“我喜欢”", "Add to Liked")
                    }
                  >
                    <Heart
                      size={16}
                      className={savedOnline[`navidrome-${current.qid}`] ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
                {current.kind === "kugou" && current.kgid != null && (
                  <button
                    className="btn-ghost w-8 h-8 shrink-0"
                    onClick={() => {
                      const entry = [...likedOnline, ...recentOnline].find(
                        (e) => e.kind === "kugou" && e.onlineId === current.kgid
                      );
                      toggleLikeOnline({
                        kind: "kugou",
                        id: current.kgid!,
                        name: current.title,
                        artist: current.artist,
                        album: current.album,
                        cover: current.cover,
                        durationMs: current.durationMs,
                        mediaMid: "",
                        vip: entry?.vip ?? false,
                      });
                    }}
                    title={
                      savedOnline[`kugou-${current.kgid}`]
                        ? tr("取消喜欢", "Unlike")
                        : tr("收藏到“我喜欢”", "Add to Liked")
                    }
                  >
                    <Heart
                      size={16}
                      className={savedOnline[`kugou-${current.kgid}`] ? "fill-[#e0533f] text-[#e0533f]" : ""}
                    />
                  </button>
                )}
            </div>}
          </div>
          <Playhead fallbackTotal={current?.durationMs ?? 0} />
        </div>

        {/* 右侧控制 */}
        <div data-layout="right" className="flex items-center gap-1 w-auto min-w-0 shrink-0 justify-end [&>button]:!w-9 [&>button]:!h-9 [&>div>button]:!w-9 [&>div>button]:!h-9 max-[1300px]:flex-1 max-[1300px]:basis-[330px] max-[1300px]:min-w-0 max-[1300px]:gap-0 max-[1300px]:[&>button]:!w-8 max-[1300px]:[&>button]:!h-8 max-[1300px]:[&>div>button]:!w-8 max-[1300px]:[&>div>button]:!h-8">
          {/* 桌面歌词开关 */}
          <button
            className={`btn-ghost ${isSkeuo ? "w-[34px] h-[34px] text-[12px]" : "w-9 h-9 text-[13px]"} font-bold ${
              desktopLyricsOn ? "!text-[var(--accent)]" : ""
            }`}
            onClick={() => {
              const s = useStore.getState();
              if (!s.desktopLyricsOn) s.openDesktopLyrics();
              else if (s.desktopLyricsLock) s.unlockDesktopLyrics();
              else s.closeDesktopLyrics();
            }}
            title={
              desktopLyricsOn
                ? desktopLyricsLock
                  ? tr("桌面歌词：已锁定（点击解锁）", "Desktop Lyrics: Locked (click to unlock)")
                  : tr("桌面歌词：点击关闭（快捷键 L）", "Desktop Lyrics: Click to close (L)")
                : tr("打开桌面歌词（快捷键 L）", "Open Desktop Lyrics (L)")
            }
          >
            {tr("词", "Lyr")}
          </button>
          <div data-player-popover="webLyrics" ref={webLyricsAnchor} className="relative flex items-center">
            <button
              type="button"
              className={`btn-ghost ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0 ${webLyricsOpen ? "!text-[var(--accent)]" : ""}`}
              aria-label={tr("网页歌词", "Web lyrics")}
              aria-expanded={webLyricsOpen}
              aria-haspopup="dialog"
              title={tr("网页歌词与 OBS 地址", "Web lyrics and OBS URL")}
              onClick={() => setWebLyricsOpen((value) => !value)}
            ><Captions size={16} /></button>
            {webLyricsOpen && createPortal(
              <div data-player-popover="webLyrics" role="dialog" aria-label={tr("网页歌词", "Web lyrics")} className="fixed z-[100] grid grid-cols-1 min-[390px]:grid-cols-2 gap-2 max-w-[calc(100vw-24px)] rounded-2xl glass-strong p-3" style={{ ...webLyricsPosition, width: webLyricsWidth, boxShadow: "var(--bar-shadow)", background: "var(--bg)" }}>
                <button type="button" className="min-h-10 min-w-0 rounded-lg flex items-center justify-center gap-2 px-2 text-[12px] text-[var(--accent-on)] bg-[var(--accent)]" onClick={() => {
                  void navigator.clipboard.writeText(WEB_LYRICS_URL).then(() => setWebLyricsCopied(true)).catch((error) => useStore.getState().toast(String(error), "error"));
                }}><Copy size={14} className="shrink-0" /><span aria-live="polite">{webLyricsCopied ? tr("OBS 地址已复制", "OBS URL copied") : tr("复制 OBS 浏览器地址", "Copy OBS browser URL")}</span></button>
                <button type="button" className="min-h-10 min-w-0 rounded-lg flex items-center justify-center gap-2 px-2 text-[12px] text-[var(--ink)] border border-[var(--line)] bg-[var(--shade)] hover:bg-[var(--shade-strong)]" onClick={() => {
                  setWebLyricsOpen(false);
                  const state = useStore.getState();
                  if (state.fullscreen) state.toggleFullscreen(false);
                  state.setNowPlayingOpen(false);
                  state.setView("settings");
                  useStore.setState({ pendingSettingsSection: "settings-web-lyrics" });
                }}><Settings size={14} className="shrink-0" />{tr("跳转到设置", "Go to settings")}</button>
              </div>,
              document.body
            )}
          </div>
          {aiControls ?? <AiTrackButton />}
          <button
            type="button"
            className={`btn-ghost player-bar-text-button ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0`}
            aria-label={tr("主播控制台", "Streamer console")}
            title={tr("主播控制台", "Streamer console")}
            onClick={() => void api.hostConsoleOpen().catch((error) => useStore.getState().toast(String(error), "error"))}
          >主播</button>
          <div data-player-popover="output" className="relative flex items-center">
            <button
              type="button"
              className={`btn-ghost player-bar-text-button !w-[38px] ${isSkeuo ? "h-[34px]" : "h-9"} shrink-0 ${outputOpen ? "!text-[var(--accent)]" : ""}`}
              aria-label={tr("音频输出设备", "Output audio device")}
              aria-expanded={outputOpen}
              aria-haspopup="dialog"
              title={tr("音频输出设备", "Output audio device")}
              onClick={() => {
                const open = !outputOpen;
                setOutputOpen(open);
                if (open) void refreshOutputDevices();
              }}
            >{tr("输出", "Output")}</button>
            {outputOpen && <>
              <div role="dialog" aria-label={tr("音频输出设备", "Output audio device")} aria-busy={outputLoading || outputSwitching} className="absolute right-0 bottom-[48px] z-[61] w-64 p-3 rounded-xl glass-strong" style={{ boxShadow: "var(--bar-shadow)" }}>
                <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--ink-2)]">
                  <span>{tr("输出设备", "Output device")}</span>
                  <button type="button" className="btn-ghost !w-7 !h-7" aria-label={tr("刷新输出设备列表", "Refresh output device list")} title={tr("刷新", "Refresh")} disabled={outputLoading || outputSwitching} onClick={() => void refreshOutputDevices()}><RefreshCw size={13} className={outputLoading ? "animate-spin" : ""} /></button>
                </div>
                <select aria-label={tr("输出设备", "Output device")} className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-2 text-[12px] text-[var(--ink)]" value={outputPreference ?? ""} disabled={outputLoading || outputSwitching} onChange={(e) => void changeOutputDevice(e.currentTarget.value)}>
                  <option value="">{tr(`跟随系统默认${outputCurrent && outputPreference == null ? `（${outputCurrent}）` : ""}`, `Follow system default${outputCurrent && outputPreference == null ? ` (${outputCurrent})` : ""}`)}</option>
                  {outputDevices.map((device) => <option key={device.name} value={device.name}>{device.name}{device.isDefault ? ` · ${tr("系统默认", "System default")}` : ""}</option>)}
                </select>
                <div className="mt-2 min-h-4 break-words text-[10.5px] text-[var(--ink-3)]" aria-live="polite">{outputSwitching ? tr("正在切换并验证…", "Switching and verifying…") : outputCurrent ? tr(`当前生效：${outputCurrent}`, `Active: ${outputCurrent}`) : tr("当前设备未知", "Active device unknown")}</div>
                {outputError && <div role="alert" className="mt-1 break-words text-[11px] text-rose-400">{outputError}</div>}
              </div>
            </>}
          </div>
          <div data-player-popover="vocal" className="relative flex items-center">
            <button
              className={`btn-ghost ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0 ${vocalAmount > 0 ? "!text-[var(--accent)]" : ""}`}
              onClick={() => vocalInstalled && setVocalOpen((v) => !v)}
              disabled={!vocalInstalled}
              title={vocalInstalled ? tr("Remix VST 去人声", "Remix VST vocal removal") : tr("未检测到 Remix VST2 插件", "Remix VST2 plugin not detected")}
              aria-label={tr("Remix VST 去人声", "Remix VST vocal removal")}
            ><SlidersHorizontal size={15} /></button>
            {vocalOpen && (
              <div className="absolute right-0 bottom-[48px] z-[61] w-52 p-3 rounded-xl glass-strong" style={{ boxShadow: "var(--bar-shadow)" }}>
                <div className="flex items-center justify-between text-[11px] text-[var(--ink-2)] mb-2">
                  <span>{tr("去人声强度", "Vocal removal")}</span><span className="tabular-nums">{Math.round(vocalAmount)}</span>
                </div>
                <input
                  aria-label={tr("去人声强度", "Vocal removal strength")}
                  type="range" min="0" max="100" step="1" value={vocalAmount}
                  className="w-full accent-[var(--accent)]"
                  onChange={(e) => {
                    const amount = Number(e.currentTarget.value);
                    setVocalAmount(amount);
                    void invoke("set_vocal_removal", { amount }).catch(() => setVocalAmount(0));
                  }}
                />
                <div className="flex justify-between text-[10px] text-[var(--ink-3)]"><span>0 · {tr("原声", "Original")}</span><span>100 · {tr("最大", "Max")}</span></div>
              </div>
            )}
          </div>
          <div data-player-popover="pitch" className="relative flex items-center">
            <button
              type="button"
              className={`btn-ghost player-bar-text-button ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0 ${pitchOpen ? "!text-[var(--accent)]" : ""}`}
              aria-label={tr("自然升降调", "Pitch shift")}
              aria-expanded={pitchOpen}
              aria-haspopup="dialog"
              title={tr("自然升降调（变调不变速）", "Pitch shift (keep playback speed)")}
              onClick={() => {
                const open = !pitchOpen;
                setPitchOpen(open);
                if (open) void refreshPitchShift();
              }}
            >变调</button>
            {pitchOpen && <>
              <div role="dialog" aria-label={tr("自然升降调", "Pitch shift")} aria-busy={pitchLoading || pitchSaving} className="absolute right-0 bottom-[48px] z-[61] w-72 p-3 rounded-xl glass-strong" style={{ boxShadow: "var(--bar-shadow)" }}>
                <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--ink-2)]">
                  <span>{tr("半音", "Semitones")}</span>
                  <span className="tabular-nums text-[var(--ink)]">{pitchShift > 0 ? `+${pitchShift}` : pitchShift}</span>
                </div>
                <div className="mb-2 flex items-center justify-between">
                  <button type="button" className="btn-ghost !w-7 !h-8 shrink-0 text-[10px]" aria-label={tr("降低五个半音", "Lower five semitones")} title={tr("降低五个半音", "Lower five semitones")} disabled={pitchLoading || pitchSaving || pitchShift <= -12} onClick={() => void changePitchShift(pitchShift - 5)}>-5</button>
                  <button type="button" className="btn-ghost !w-8 !h-8 shrink-0" aria-label={tr("降低半音", "Lower one semitone")} title={tr("降低半音", "Lower one semitone")} disabled={pitchLoading || pitchSaving || pitchShift <= -12} onClick={() => void changePitchShift(pitchShift - 1)}><Minus size={14} /></button>
                  <input aria-label={tr("半音", "Semitones")} type="range" min="-12" max="12" step="1" value={pitchShift} disabled={pitchLoading || pitchSaving} className="mx-2 min-w-0 flex-1 accent-[var(--accent)]" onChange={(e) => void changePitchShift(Number(e.currentTarget.value))} />
                  <button type="button" className="btn-ghost !w-8 !h-8 shrink-0" aria-label={tr("升高半音", "Raise one semitone")} title={tr("升高半音", "Raise one semitone")} disabled={pitchLoading || pitchSaving || pitchShift >= 12} onClick={() => void changePitchShift(pitchShift + 1)}><Plus size={14} /></button>
                  <button type="button" className="btn-ghost !w-7 !h-8 shrink-0 text-[10px]" aria-label={tr("升高五个半音", "Raise five semitones")} title={tr("升高五个半音", "Raise five semitones")} disabled={pitchLoading || pitchSaving || pitchShift >= 12} onClick={() => void changePitchShift(pitchShift + 5)}>+5</button>
                </div>
                <button type="button" className="w-full h-7 px-2 rounded-lg flex items-center justify-center gap-1.5 text-[11px] text-[var(--ink-2)] hover:bg-[var(--shade-strong)] disabled:opacity-50" disabled={pitchLoading || pitchSaving || pitchShift === 0} onClick={() => void changePitchShift(0)}><RotateCcw size={12} />{tr("还原", "Reset")}</button>
                <div className="mt-2 text-[10px] leading-4 text-[var(--ink-3)]" aria-live="polite">{pitchLoading ? tr("正在读取…", "Reading…") : tr("变调不变速；大幅度调整可能影响音质。", "Keeps playback speed; large shifts may affect audio quality.")}</div>
              </div>
            </>}
          </div>
          <button
            className={`btn-ghost relative ${isSkeuo ? "w-[34px] h-[34px] text-[11px]" : "w-9 h-9 text-[11.5px]"} font-bold tabular-nums`}
            onClick={() => {
              const i = SPEEDS.indexOf(speed);
              if (i >= 0) {
                setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
              } else {
                setSpeed(SPEEDS.find((s) => s > speed) ?? SPEEDS[0]);
              }
            }}
            title={tr("播放速度", "Playback speed")}
          >
            <span className={isSkeuo && speed !== 1 ? "text-[var(--accent-strong)]" : !isSkeuo && speed !== 1 ? "!text-[var(--accent)]" : ""}>
              {speed}x
            </span>
            {isSkeuo && speed !== 1 && (
              <span className="skeuo-led-on absolute top-1 right-1 !w-[4px] !h-[4px]" />
            )}
          </button>

          {/* 音量 */}
          <div data-player-popover="vol" className="relative flex items-center">
            <button
              ref={volBtnRef}
              className={`btn-ghost ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0 ${
                volOpen
                  ? isSkeuo
                    ? "!text-[var(--accent-strong)] shadow-[inset_0_2px_4px_rgba(0,0,0,0.8)]"
                    : "!text-[var(--accent)]"
                  : ""
              }`}
              onClick={() => setVolOpen((v) => !v)}
              onWheel={(e) => {
                setVolume(Math.min(1, Math.max(0, volume + (e.deltaY < 0 ? 0.05 : -0.05))));
              }}
              title={tr("音量（滚轮调节）", "Volume (scroll wheel)")}
            >
              <VolIcon size={15} />
            </button>
            {volOpen && (
              <VolumePopover
                volume={volume}
                onSet={setVolume}
                muted={volume === 0}
                onToggleMute={() => {
                  if (volume > 0) {
                    lastVolRef.current = volume;
                    setVolume(0);
                  } else {
                    setVolume(lastVolRef.current || 0.8);
                  }
                }}
                onClose={() => setVolOpen(false)}
                uiTheme={uiTheme}
              />
            )}
          </div>

          {/* 定时停止 */}
          <div data-player-popover="sleep" className="relative flex items-center">
            <button
              className={`btn-ghost relative ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} shrink-0 ${
                sleepAt != null || sleepStopAfterTrack || sleepStopAfterQueue
                  ? isSkeuo
                    ? "!text-[var(--accent-strong)] shadow-[inset_0_2px_4px_rgba(0,0,0,0.8)]"
                    : "!text-[var(--accent)]"
                  : ""
              }`}
              onClick={() => setSleepOpen((v) => !v)}
              title={
                sleepAt != null
                  ? tr(
                      `定时停止：剩余约 ${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))} 分钟`,
                      `Sleep timer: ~${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))} min left`
                    )
                  : sleepStopAfterTrack
                    ? tr("定时停止：播完当前歌曲后停止", "Sleep timer: Stop after current track")
                    : sleepStopAfterQueue
                      ? tr("定时停止：播完当前列表后停止", "Sleep timer: Stop after current queue")
                      : tr("定时停止播放", "Sleep Timer")
              }
            >
              <Timer size={15} />
              {isSkeuo && (sleepAt != null || sleepStopAfterTrack || sleepStopAfterQueue) && (
                <span className="skeuo-led-on absolute top-1 right-1 !w-[4px] !h-[4px]" />
              )}
            </button>
            {sleepOpen && (
              <SleepPopover
                sleepAt={sleepAt}
                onSet={setSleepTimer}
                onMode={setSleepMode}
                stopAfterTrack={sleepStopAfterTrack}
                stopAfterQueue={sleepStopAfterQueue}
                onClose={() => setSleepOpen(false)}
                uiTheme={uiTheme}
              />
            )}
          </div>

          <button
            className={`btn-ghost relative ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} ${miniPlayer ? "!text-[var(--accent)]" : ""}`}
            onClick={() => setMiniPlayer(!miniPlayer)}
            title={tr("极简小窗模式", "Mini Player")}
          >
            <PictureInPicture2 size={isSkeuo ? 15 : 16} />
          </button>

          <AccompanimentTasks />
          <button
            className={`btn-ghost relative ${isSkeuo ? "w-[34px] h-[34px]" : "w-9 h-9"} ${
              queueOpen
                ? isSkeuo
                  ? "!text-[var(--accent-strong)] shadow-[inset_0_2px_4px_rgba(0,0,0,0.8)]"
                  : "!text-[var(--accent)]"
                : ""
            }`}
            onClick={() => setQueueOpen(!queueOpen)}
            title={tr("播放队列", "Play Queue")}
          >
            <ListMusic size={16} />
            {queue.length > 1 && (
              <span
                className={`absolute -top-1 -right-1 text-[9.5px] text-[var(--accent-on)] rounded-full min-w-[15px] leading-[15px] font-bold text-center px-0.5 ${
                  isSkeuo ? "border border-black/40 shadow" : ""
                }`}
                style={{ background: "var(--accent)" }}
              >
                {queue.length}
              </span>
            )}
          </button>
        </div>
        <TrackTitleLyric />
      </div>
    </div>
  );
}
