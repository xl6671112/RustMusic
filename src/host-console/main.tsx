import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { AudioLines, ChevronDown, ChevronRight, Eye, EyeOff, Mic2, Minus, Pin, Plus, Radio, RotateCcw, SlidersHorizontal, Volume2, X } from "lucide-react";
import { api } from "../api";
import { initI18n } from "../i18n";
import { initTheme } from "../theme";
import "../index.css";
import { readEffectShortcuts, shortcutFor } from "./effect-shortcuts";
import "./fader.css";

initI18n();
initTheme();

type OutputState = Awaited<ReturnType<typeof api.listOutputDevices>>;
type ConsoleState = {
  hasTrack: boolean;
  title: string;
  instrumental: boolean;
  busy: boolean;
  accompanimentChecked: boolean;
  accompanimentReady: boolean;
};
type StudioOneHost = { pid: number; thread: number; name: string; title: string; hidden: boolean };
type StudioOneChannel = {
  token: string;
  id: string | null;
  name: string | null;
  channelType: number | null;
  index: number | null;
  volume: number | null;
  maxVolume: number | null;
  mute: boolean | null;
  monitor: boolean | null;
  plugin: string | null;
  pluginEnabled: boolean | null;
};

type StudioOneGroup = { key: string; name: string; index: number | null; channels: StudioOneChannel[] };
type RackMenu = { x: number; y: number; group: string; effect?: string; slot?: number };
type PluginSlots = Record<string, (string | null)[]>;
const PLUGIN_SLOT_COUNT = 4;
const PLUGIN_SLOTS_KEY = "studioOne.pluginSlots";

function studioOneGroupKey(channel: StudioOneChannel) {
  if (channel.id) return `id:${channel.id}`;
  if (channel.name && channel.index != null) return `track:${channel.channelType}:${channel.index}:${channel.name}`;
  return `token:${channel.token}`;
}

function groupStudioOneChannels(channels: StudioOneChannel[]): StudioOneGroup[] {
  const groups = new Map<string, StudioOneGroup>();
  channels.forEach((channel) => {
    const key = studioOneGroupKey(channel);
    const group = groups.get(key);
    if (group) group.channels.push(channel);
    else groups.set(key, { key, name: channel.name || (channel.index == null ? "通道名称未知" : `音轨 ${channel.index}`), index: channel.index, channels: [channel] });
  });
  return Array.from(groups.values()).sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
}

function readConsoleSet(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function effectKey(channel: StudioOneChannel, field: "monitor" | "pluginEnabled") {
  return JSON.stringify([studioOneGroupKey(channel), channel.name, field,
    field === "monitor" ? null : [channel.token, channel.plugin]]);
}

function readPluginSlots(): PluginSlots {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PLUGIN_SLOTS_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, value]) =>
      Array.isArray(value) && value.length === PLUGIN_SLOT_COUNT &&
      value.every((item) => item == null || typeof item === "string")));
  } catch {
    return {};
  }
}

function pluginSlotKeys(assigned?: (string | null)[]) {
  return assigned ?? Array<null>(PLUGIN_SLOT_COUNT).fill(null);
}

// Studio Pro 8 sends fader positions over UCNET, with unity at about 0.76.
const FADER_SCALE = [[0, -144], [0.01, -123], [0.1, -50], [0.22, -35], [0.52, -10], [0.7600051164627075, 0], [1, 10]] as const;

function convertFaderValue(value: number, from: 0 | 1) {
  const to = from === 0 ? 1 : 0;
  for (let i = 1; i < FADER_SCALE.length; i++) {
    const lower = FADER_SCALE[i - 1], upper = FADER_SCALE[i];
    if (value <= upper[from]) {
      const fraction = Math.max(0, (value - lower[from]) / (upper[from] - lower[from]));
      return lower[to] + fraction * (upper[to] - lower[to]);
    }
  }
  return FADER_SCALE[FADER_SCALE.length - 1][to];
}

function formatFaderDb(position: number) {
  if (position <= 0) return "−∞";
  const db = Math.round(convertFaderValue(position, 0) * 10) / 10;
  return db > 0 ? `+${db}` : String(db);
}

function FaderVolumeInput({ name, value, max, onChange }: {
  name: string; value: number; max: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = formatFaderDb(value / max);
  return <label className="studio-one-fader-value" title="输入推子增益（dB）">
    <input aria-label={`${name}音量（dB）`} type="text" inputMode="decimal"
      value={draft ?? display}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        setDraft(null);
        const text = draft?.trim().replaceAll("−", "-");
        if (!text || text === display.replaceAll("−", "-")) return;
        const db = Number(text);
        const silent = /^-(∞|inf(?:inity)?)$/i.test(text);
        if (!silent && !Number.isFinite(db)) return;
        const next = silent ? 0 : convertFaderValue(db, 1) * max;
        if (next !== value) onChange(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(null);
      }} />
  </label>;
}

function HostConsole() {
  const [track, setTrack] = useState<ConsoleState>({
    hasTrack: false, title: "", instrumental: false, busy: false, accompanimentChecked: false, accompanimentReady: false,
  });
  const [outputs, setOutputs] = useState<OutputState["devices"]>([]);
  const [currentOutput, setCurrentOutput] = useState("");
  const [outputPreference, setOutputPreference] = useState<string | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [vocalAmount, setVocalAmount] = useState(0);
  const [vocalAvailable, setVocalAvailable] = useState(false);
  const [vocalError, setVocalError] = useState("");
  const [pitch, setPitch] = useState(0);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [studioOneEnabled, setStudioOneEnabled] = useState(false);
  const [studioOneExpanded, setStudioOneExpanded] = useState(true);
  const [studioOneHost, setStudioOneHost] = useState<StudioOneHost | null>(null);
  const [studioOneVisibilityBusy, setStudioOneVisibilityBusy] = useState(false);
  const [studioOneChannels, setStudioOneChannels] = useState<StudioOneChannel[]>([]);
  const [studioOneError, setStudioOneError] = useState("");
  const [studioOneWriteError, setStudioOneWriteError] = useState("");
  const [hiddenStudioOneGroups, setHiddenStudioOneGroups] = useState(() => readConsoleSet("studioOne.hiddenGroups"));
  const [pluginSlots, setPluginSlots] = useState(readPluginSlots);
  const [showAllStudioOneGroups, setShowAllStudioOneGroups] = useState(false);
  const [rackMenu, setRackMenu] = useState<RackMenu | null>(null);
  const [recordingEffect, setRecordingEffect] = useState<string | null>(null);
  const [manualShortcut, setManualShortcut] = useState<string | null>(null);
  const [effectShortcuts, setEffectShortcuts] = useState(readEffectShortcuts);
  const [shortcutError, setShortcutError] = useState("");
  const [shortcutSetupError, setShortcutSetupError] = useState("");
  const studioOneToggleBusy = useRef(false);
  const shortcutBusy = useRef(false);
  const shortcutRestore = useRef(Promise.resolve());
  const dispatchShortcut = useRef<(effect: string) => void>(() => {});
  const [error, setError] = useState("");
  const requestTimer = useRef<number[]>([]);
  const volumeTimer = useRef<number>();
  const studioOneFaderWrites = useRef(new Map<string, { value: number; queued: boolean }>());
  const refreshStudioOne = useRef(() => {});
  const studioOneGroups = groupStudioOneChannels(studioOneChannels);
  const visibleStudioOneGroups = studioOneGroups.filter((group) => !hiddenStudioOneGroups.has(group.key));
  const showRack = studioOneEnabled && studioOneExpanded;

  useEffect(() => localStorage.setItem("studioOne.hiddenGroups", JSON.stringify(Array.from(hiddenStudioOneGroups))), [hiddenStudioOneGroups]);
  useEffect(() => localStorage.setItem("studioOne.effectShortcuts", JSON.stringify(effectShortcuts)), [effectShortcuts]);
  useEffect(() => localStorage.setItem(PLUGIN_SLOTS_KEY, JSON.stringify(pluginSlots)), [pluginSlots]);
  useEffect(() => {
    const fit = () => {
      const columns = Math.max(1, Math.floor((window.innerWidth - 24 + 8) / 132));
      const rows = Math.max(1, Math.ceil(visibleStudioOneGroups.length / columns));
      const height = showRack ? Math.max(336, Math.min(window.screen.availHeight, 680 + (rows - 1) * 190)) : 336;
      if (window.innerHeight !== height) {
        void getCurrentWindow().setSize(new LogicalSize(window.innerWidth, height)).catch((reason) => setError(String(reason)));
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [showRack, visibleStudioOneGroups.length]);
  useEffect(() => {
    if (!showRack) {
      setRackMenu(null);
      setRecordingEffect(null);
      setShortcutError("");
      setShowAllStudioOneGroups(false);
    }
  }, [showRack]);
  useEffect(() => {
    setStudioOneWriteError("");
  }, [studioOneHost?.pid]);
  const assignPluginSlot = (groupKey: string, slot: number, pluginKey: string | null) => {
    setPluginSlots((current) => ({
      ...current,
      [groupKey]: pluginSlotKeys(current[groupKey]).map((key, index) =>
        index === slot ? pluginKey : key),
    }));
  };

  useEffect(() => {
    const syncTheme = () => initTheme();
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  useEffect(() => {
    if (!studioOneEnabled) return;
    let disposed = false;
    let refreshing = false;
    let connectedPid = 0;
    let refreshRequested = false;
    const refresh = async (afterWrite = false) => {
      if (disposed) return;
      if (refreshing) {
        refreshRequested ||= afterWrite;
        return;
      }
      refreshing = true;
      try {
        const hosts = await invoke<StudioOneHost[]>("studio_one_hosts");
        if (disposed) return;
        const host = hosts[0] ?? null;
        setStudioOneHost(host);
        if (!host) {
          connectedPid = 0;
          studioOneFaderWrites.current.clear();
          setStudioOneChannels([]);
          setStudioOneError("");
          return;
        }
        if (connectedPid !== host.pid) {
          studioOneFaderWrites.current.clear();
          setStudioOneChannels([]);
          await invoke("studio_one_connect", { pid: host.pid, thread: host.thread });
          if (disposed) return;
          connectedPid = host.pid;
        }
        const channels = await invoke<StudioOneChannel[]>("studio_one_snapshot", { pid: host.pid });
        if (!disposed && !refreshRequested) {
          setStudioOneChannels(channels.map((item) => {
            const write = item.volume == null ? undefined : studioOneFaderWrites.current.get(studioOneGroupKey(item));
            return write ? { ...item, volume: write.value } : item;
          }));
          setStudioOneError("");
        }
      } catch (reason) {
        if (!disposed) setStudioOneError(String(reason));
      } finally {
        refreshing = false;
        if (refreshRequested) {
          refreshRequested = false;
          void refresh();
        }
      }
    };
    refreshStudioOne.current = () => void refresh(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      refreshStudioOne.current = () => {};
      studioOneFaderWrites.current.clear();
      void invoke("studio_one_set_enabled", { enabled: false });
    };
  }, [studioOneEnabled]);

  const toggleStudioOne = async () => {
    if (studioOneToggleBusy.current || shortcutBusy.current) return;
    studioOneToggleBusy.current = true;
    const enabled = !studioOneEnabled;
    setStudioOneError("");
    try {
      if (!enabled) {
        await shortcutRestore.current;
        await invoke("studio_one_shortcuts_clear");
      }
      await invoke("studio_one_set_enabled", { enabled });
      setStudioOneEnabled(enabled);
      if (!enabled) {
        setStudioOneHost(null);
        setStudioOneChannels([]);
        studioOneFaderWrites.current.clear();
      }
    } catch (reason) {
      setStudioOneEnabled(false);
      setStudioOneHost(null);
      setStudioOneChannels([]);
      setStudioOneError(String(reason));
    } finally {
      studioOneToggleBusy.current = false;
    }
  };
  const toggleStudioOneVisibility = async () => {
    if (!studioOneHost || studioOneVisibilityBusy) return;
    const { pid, hidden } = studioOneHost;
    setStudioOneVisibilityBusy(true);
    setStudioOneWriteError("");
    try {
      await invoke("studio_one_set_host_hidden", { pid, hidden: !hidden });
      setStudioOneHost((host) => host?.pid === pid ? { ...host, hidden: !hidden } : host);
    } catch (reason) {
      setStudioOneWriteError(String(reason));
    } finally {
      setStudioOneVisibilityBusy(false);
    }
  };
  const setStudioOneValue = (channel: StudioOneChannel, field: "volume" | "monitor" | "pluginEnabled" | "mute", value: number) => {
    if (!studioOneHost) return;
    const { pid } = studioOneHost;
    const write = async (next: number) => {
      setStudioOneWriteError("");
      try {
        await invoke("studio_one_set", { pid, token: channel.token, field, value: next });
      } catch (reason) {
        setStudioOneWriteError(String(reason));
      }
    };
    if (field !== "volume") {
      void write(value).then(refreshStudioOne.current);
      return;
    }
    const key = studioOneGroupKey(channel);
    const writes = studioOneFaderWrites.current;
    setStudioOneChannels((current) => current.map((item) => item.volume != null && studioOneGroupKey(item) === key ? { ...item, volume: value } : item));
    const pending = writes.get(key);
    if (pending) {
      pending.value = value;
      pending.queued = true;
      return;
    }
    const entry = { value, queued: true };
    writes.set(key, entry);
    void (async () => {
      // Send immediately, and only send the latest position while the host confirms the last one.
      while (writes.get(key) === entry && entry.queued) {
        entry.queued = false;
        await write(entry.value);
      }
      if (writes.get(key) !== entry) return;
      writes.delete(key);
      refreshStudioOne.current();
    })();
  };

  const updateShortcut = async (effect: string, binding: string | null) => {
    if (shortcutBusy.current || studioOneToggleBusy.current) return;
    shortcutBusy.current = true;
    setShortcutError("");
    try {
      await shortcutRestore.current;
      if (binding && Object.entries(effectShortcuts).some(([key, current]) => key !== effect && current === binding)) {
        throw new Error("该快捷键已被其他效果占用，请换一个按键。");
      }
      await invoke("studio_one_shortcut_set", { effect, binding });
      setEffectShortcuts((current) => {
        const next = { ...current };
        if (binding) next[effect] = binding;
        else delete next[effect];
        return next;
      });
      setRecordingEffect(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (binding) setShortcutError(message);
      else setStudioOneWriteError(message);
    } finally {
      shortcutBusy.current = false;
    }
  };

  dispatchShortcut.current = (effect) => {
    if (!studioOneEnabled || studioOneToggleBusy.current || !effectShortcuts[effect]) return;
    if (recordingEffect) {
      if (effect !== recordingEffect) setShortcutError("该快捷键已被其他效果占用，请换一个按键。");
      return;
    }
    for (const field of ["monitor", "pluginEnabled"] as const) {
      const channel = studioOneChannels.find((row) => row[field] != null && effectKey(row, field) === effect);
      if (channel) {
        setStudioOneValue(channel, field, channel[field] ? 0 : 1);
        return;
      }
    }
  };

  useEffect(() => {
    let disposed = false;
    const subscription = listen<string>("studio-one://shortcut", ({ payload }) => dispatchShortcut.current(payload), { target: "host-console" });
    void subscription.catch((reason) => { if (!disposed) setStudioOneWriteError(String(reason)); });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!studioOneEnabled) return;
    setShortcutSetupError("");
    shortcutRestore.current = Promise.all(Object.entries(readEffectShortcuts()).map(async ([effect, binding]) => {
      try {
        await invoke("studio_one_shortcut_set", { effect, binding });
        return "";
      } catch (reason) {
        return `${binding}：${reason}`;
      }
    })).then((results) => setShortcutSetupError(results.filter(Boolean).join("；")));
  }, [studioOneEnabled]);

  useEffect(() => {
    if (!rackMenu) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRackMenu(null);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [rackMenu]);

  function openRackMenu(event: React.MouseEvent, group: string, effect?: string, slot?: number) {
    event.preventDefault();
    event.stopPropagation();
    setRackMenu({
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 204)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 104)),
      group, effect, slot,
    });
  }

  useEffect(() => {
    void getCurrentWindow().isAlwaysOnTop()
      .then(setAlwaysOnTop)
      .catch((reason) => setError(String(reason)));
  }, []);

  const toggleAlwaysOnTop = async () => {
    if (pinBusy) return;
    setPinBusy(true);
    try {
      const next = !alwaysOnTop;
      await getCurrentWindow().setAlwaysOnTop(next);
      setAlwaysOnTop(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPinBusy(false);
    }
  };

  const refreshOutputs = async () => {
    try {
      const state = await api.listOutputDevices();
      setOutputs(state.devices);
      setCurrentOutput(state.current);
      setOutputPreference(state.preference);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => {
    let disposed = false;
    let volumeEventSeen = false;
    const unlisten: (() => void)[] = [];
    void Promise.all([
      listen<ConsoleState>("host-console://state", ({ payload }) => setTrack(payload)),
      listen<number>("player://volume", ({ payload }) => {
        if (Number.isFinite(payload)) {
          volumeEventSeen = true;
          setVolume(Math.max(0, Math.min(1, payload)));
        }
      }),
      listen<number>("player://pitch", ({ payload }) => {
        if (Number.isFinite(payload)) setPitch(Math.max(-12, Math.min(12, Math.round(payload))));
      }),
      listen<number>("player://vocal-removal", ({ payload }) => {
        if (Number.isFinite(payload)) setVocalAmount(Math.max(0, Math.min(100, payload)));
      }),
      listen("player://output-device", () => void refreshOutputs()),
    ]).then((stops) => {
      if (disposed) stops.forEach((stop) => stop());
      else unlisten.push(...stops);
      [100, 450, 1200].forEach((delay) => {
        requestTimer.current.push(window.setTimeout(() => void emit("host-console://request-state"), delay));
      });
      void api.getSettings().then((settings) => {
        if (!disposed && !volumeEventSeen) setVolume(Math.max(0, Math.min(1, settings.volume)));
      }).catch((reason) => setError(String(reason)));
      void invoke<number>("get_pitch_shift").then((value) => {
        if (Number.isFinite(value)) setPitch(Math.max(-12, Math.min(12, Math.round(value))));
      }).catch((reason) => setError(String(reason)));
      void invoke<number>("get_vocal_removal").then((value) => {
        if (Number.isFinite(value)) setVocalAmount(Math.max(0, Math.min(100, value)));
      }).catch((reason) => setError(String(reason)));
      void invoke<{ installed: boolean; supportedPlatform: boolean; error?: string }>("vocal_removal_status")
        .then((value) => { setVocalAvailable(value.installed && value.supportedPlatform); setVocalError(value.error ?? ""); })
        .catch((reason) => { setVocalAvailable(false); setVocalError(String(reason)); });
    }).catch((reason) => setError(String(reason)));
    void refreshOutputs();
    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
      requestTimer.current.forEach(window.clearTimeout);
      requestTimer.current = [];
      if (volumeTimer.current != null) window.clearTimeout(volumeTimer.current);
    };
  }, []);

  const toggleAccompaniment = async () => {
    setTrack((value) => ({ ...value, busy: true }));
    try {
      await emit("host-console://toggle-accompaniment");
    } catch (reason) {
      setTrack((value) => ({ ...value, busy: false }));
      setError(String(reason));
    }
  };
  const changeOutput = async (name: string) => {
    setOutputBusy(true);
    setError("");
    try {
      await api.setOutputDevice(name || null);
      await refreshOutputs();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setOutputBusy(false);
    }
  };
  const changeVolume = (value: number) => {
    const next = Math.max(0, Math.min(100, value)) / 100;
    setVolume(next);
    if (volumeTimer.current != null) window.clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => {
      void api.setVolume(next).catch((reason) => setError(String(reason)));
    }, 120);
  };
  const changePitch = async (semitones: number) => {
    const next = Math.max(-12, Math.min(12, semitones));
    setPitch(next);
    try {
      await invoke("set_pitch_shift", { semitones: next });
    } catch (reason) {
      setError(String(reason));
    }
  };
  const changeVocalAmount = async (amount: number) => {
    setVocalAmount(amount);
    try {
      await invoke("set_vocal_removal", { amount });
    } catch (reason) {
      setError(String(reason));
    }
  };

  return <main className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--ink)]">
    <header data-tauri-drag-region className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <Radio size={17} className="shrink-0 text-[var(--accent-strong)]" />
        <div data-tauri-drag-region className="min-w-0">
          <div data-tauri-drag-region className="text-[13px] font-semibold">主播控制台</div>
          <div data-tauri-drag-region className="max-w-[330px] truncate text-[10px] text-[var(--ink-3)]" title={track.title}>{track.title || "等待播放歌曲"}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" className={`btn-ghost !h-8 !w-8 shrink-0 ${alwaysOnTop ? "!text-[var(--accent-strong)]" : ""}`} aria-label={alwaysOnTop ? "取消置顶主播控制台" : "置顶主播控制台"} aria-pressed={alwaysOnTop} title={alwaysOnTop ? "取消置顶" : "置顶"} disabled={pinBusy} onClick={() => void toggleAlwaysOnTop()}><Pin size={15} /></button>
        <button type="button" className="btn-ghost !h-8 !w-8 shrink-0" aria-label="关闭主播控制台" title="关闭" onClick={() => void getCurrentWindow().close()}><X size={15} /></button>
      </div>
    </header>

    <div className="host-console-body flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <div className="grid shrink-0 gap-3 sm:grid-cols-3">
        <section aria-label="输出设备和音轨切换" className="min-w-0 space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
          <div>
            <label htmlFor="host-console-output" className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--ink-2)]"><AudioLines size={14} />输出设备</label>
            <select id="host-console-output" className="h-9 w-full truncate rounded-lg border border-[var(--line)] bg-[var(--shade)] px-2.5 text-[12px] text-[var(--ink)] disabled:opacity-50" value={outputPreference ?? ""} disabled={outputBusy} onChange={(event) => void changeOutput(event.currentTarget.value)}>
              <option value="">{`跟随系统默认${currentOutput && outputPreference == null ? `（${currentOutput}）` : ""}`}</option>
              {outputs.map((device) => <option key={device.name} value={device.name}>{device.name}{device.isDefault ? " · 系统默认" : ""}</option>)}
            </select>
            <div className="mt-1 truncate text-[10px] text-[var(--ink-3)]" title={currentOutput}>{outputBusy ? "正在切换…" : currentOutput ? `当前：${currentOutput}` : "当前设备未知"}</div>
          </div>
          <div className="border-t border-[var(--line)] pt-2.5">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--ink-2)]"><Mic2 size={14} />音轨切换</div>
            <button type="button" className={`h-9 w-full rounded-lg border border-[var(--line)] px-2.5 text-[12px] font-semibold transition-colors ${track.instrumental ? "bg-[var(--accent)] text-[var(--accent-on)]" : "bg-[var(--shade)] text-[var(--ink)] hover:bg-[var(--shade-strong)]"} disabled:cursor-not-allowed disabled:opacity-50`} disabled={!track.hasTrack || !track.accompanimentChecked || !track.accompanimentReady || track.busy} aria-pressed={track.instrumental} onClick={() => void toggleAccompaniment()}>
              {track.busy ? "正在切换…" : !track.hasTrack ? "等待歌曲" : !track.accompanimentChecked ? "正在检查 AI 伴奏…" : !track.accompanimentReady ? "暂无 AI 伴奏" : track.instrumental ? "切回原曲" : "AI 伴奏已就绪"}
            </button>
          </div>
        </section>

        <section aria-label="音量和实时伴奏" className="min-w-0 space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--ink-2)]">
              <span className="flex items-center gap-2"><Volume2 size={14} />音量</span>
              <span className="tabular-nums text-[var(--ink)]">{Math.round(volume * 100)}%</span>
            </div>
            <input aria-label="播放器音量" className="w-full accent-[var(--accent)]" type="range" min="0" max="100" step="1" value={Math.round(volume * 100)} onChange={(event) => changeVolume(Number(event.currentTarget.value))} />
            <div className="mt-1 flex justify-between text-[10px] text-[var(--ink-3)]"><span>0 · 静音</span><span>100 · 最大</span></div>
          </div>
          <div className="border-t border-[var(--line)] pt-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--ink-2)]">
              <span>实时伴奏（音质不如 AI）</span>
              <span className="shrink-0 tabular-nums text-[var(--ink)]">{Math.round(vocalAmount)}</span>
            </div>
            <input aria-label="实时伴奏去人声强度" className="w-full accent-[var(--accent)] disabled:opacity-40" type="range" min="0" max="100" step="1" value={vocalAmount} disabled={!vocalAvailable} onChange={(event) => void changeVocalAmount(Number(event.currentTarget.value))} />
            <div className="mt-1 flex justify-between gap-2 text-[10px] text-[var(--ink-3)]"><span>0 · 原声</span><span className="text-right">{vocalAvailable ? "100 · 最大" : "未检测到 Remix VST"}</span></div>
            {!vocalAvailable && vocalError && <div role="alert" className="mt-1 break-words text-[10px] text-rose-400">{vocalError}</div>}
          </div>
        </section>

        <section aria-label="变调" className="min-w-0 space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--ink-2)]">
              <span className="flex items-center gap-2"><Mic2 size={14} />变调</span>
              <span className="tabular-nums text-[var(--ink)]">{pitch > 0 ? `+${pitch}` : pitch} 半音</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" className="btn-ghost !h-7 !w-7 shrink-0 text-[10px]" aria-label="降低五个半音" title="-5 半音" disabled={pitch <= -12} onClick={() => void changePitch(pitch - 5)}>-5</button>
              <button type="button" className="btn-ghost !h-7 !w-7 shrink-0" aria-label="降低一个半音" title="-1 半音" disabled={pitch <= -12} onClick={() => void changePitch(pitch - 1)}><Minus size={13} /></button>
              <input aria-label="自然变调半音" className="mx-1 min-w-0 flex-1 accent-[var(--accent)]" type="range" min="-12" max="12" step="1" value={pitch} onChange={(event) => void changePitch(Number(event.currentTarget.value))} />
              <button type="button" className="btn-ghost !h-7 !w-7 shrink-0" aria-label="升高一个半音" title="+1 半音" disabled={pitch >= 12} onClick={() => void changePitch(pitch + 1)}><Plus size={13} /></button>
              <button type="button" className="btn-ghost !h-7 !w-7 shrink-0 text-[10px]" aria-label="升高五个半音" title="+5 半音" disabled={pitch >= 12} onClick={() => void changePitch(pitch + 5)}>+5</button>
            </div>
            <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-[var(--ink-3)]">
              <span>-12</span>
              <button type="button" className="flex h-6 items-center justify-center gap-1 rounded-md px-1.5 hover:bg-[var(--shade-strong)] disabled:opacity-40" disabled={pitch === 0} onClick={() => void changePitch(0)}><RotateCcw size={11} />还原原调</button>
              <span>+12</span>
            </div>
          </div>
        </section>
      </div>

      <section className="studio-one-rack flex min-h-0 flex-col border-t border-[var(--line)] pt-1">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <label className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-[var(--ink-2)]">
            <SlidersHorizontal size={14} />
            <span>Studio One 控制</span>
            <input aria-label="启用 Studio One 推子、监听和插件控制" type="checkbox" className="accent-[var(--accent)]" checked={studioOneEnabled} onChange={() => void toggleStudioOne()} />
          </label>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-right text-[10px] text-[var(--ink-3)]" title={studioOneHost?.title}>
              {!studioOneEnabled ? "已关闭" : studioOneHost ? studioOneHost.title : "等待 Studio One"}
            </span>
            {studioOneHost && <button type="button" className="btn-ghost !h-7 shrink-0 !px-2 text-[10px]" disabled={studioOneVisibilityBusy} onClick={() => void toggleStudioOneVisibility()}>
              {studioOneHost.hidden ? "显示宿主" : "隐藏宿主"}
            </button>}
            {showRack && studioOneGroups.length > 0 && <button type="button" className="btn-ghost !h-7 shrink-0 !px-2 text-[10px]" aria-expanded={showAllStudioOneGroups} onClick={() => setShowAllStudioOneGroups((value) => !value)}>
              {showAllStudioOneGroups ? <EyeOff size={12} /> : <Eye size={12} />}全部通道
            </button>}
            <button type="button" className="btn-ghost !h-7 shrink-0 !px-2 text-[10px]" aria-controls="studio-one-controls" aria-expanded={studioOneEnabled && studioOneExpanded} disabled={!studioOneEnabled} onClick={() => setStudioOneExpanded(value => !value)}>
              {studioOneEnabled && studioOneExpanded ? <><ChevronDown size={12} />收起控制</> : <><ChevronRight size={12} />展开控制</>}
            </button>
          </div>
        </div>
        {studioOneError && <div role="alert" className="break-words py-1 text-[10px] text-rose-500">{studioOneError}</div>}
        {studioOneWriteError && <div role="alert" className="break-words py-1 text-[10px] text-rose-500">{studioOneWriteError}</div>}
        {studioOneEnabled && shortcutSetupError && <div role="alert" className="break-words py-1 text-[10px] text-rose-500">{shortcutSetupError}</div>}
        {showRack && <div id="studio-one-controls" className="relative flex min-h-0 flex-1 flex-col">
          {showAllStudioOneGroups && <div className="absolute right-0 top-0 z-10 grid max-w-full grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2 shadow-lg">
            {studioOneGroups.map((group) => <label key={group.key} className="flex min-w-0 items-center gap-2 text-[10px]">
              <input type="checkbox" className="accent-[var(--accent)]" checked={!hiddenStudioOneGroups.has(group.key)} onChange={() => setHiddenStudioOneGroups((current) => {
                const next = new Set(current);
                if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                return next;
              })} />
              <span className="truncate">{group.name}</span>
            </label>)}
            {!studioOneGroups.length && <span className="text-[10px] text-[var(--ink-3)]">尚未检测到可控通道</span>}
          </div>}
          <div className="studio-one-channels mt-1">
            {visibleStudioOneGroups.map((group) => {
              const volumeChannel = group.channels.find((item) => item.volume != null);
              const muteChannel = group.channels.find((item) => item.mute != null);
              const monitorChannel = group.channels.find((item) => item.monitor != null);
              const plugins = group.channels.filter((item) => item.plugin != null);
              const availablePlugins = new Map(plugins.map((plugin) => [effectKey(plugin, "pluginEnabled"), plugin]));
              const slots = pluginSlotKeys(pluginSlots[group.key]);
              const options = Array.from(availablePlugins).filter(([key]) => !slots.includes(key));
              const monitorKey = monitorChannel && effectKey(monitorChannel, "monitor");
              return <div key={group.key} onContextMenu={(event) => openRackMenu(event, group.key, monitorKey ?? undefined)} className="studio-one-channel rounded-lg border border-[var(--line)] bg-[var(--shade)] p-2" title="右键打开通道菜单">
                <div className="flex items-center">
                  <span className="min-w-0 truncate text-[12px] font-medium" title={group.name}>{group.name}</span>
                </div>
                <ul className="studio-one-plugin-slots">
                  {slots.map((key, index) => {
                    const plugin = key ? availablePlugins.get(key) : undefined;
                    const shortcut = key ? effectShortcuts[key] : undefined;
                    return plugin && key ? <li key={index} onContextMenu={(event) => openRackMenu(event, group.key, plugin.pluginEnabled == null ? undefined : key, index)}>
                      <button type="button" className="studio-one-plugin flex h-6 w-full items-center justify-between gap-1 rounded border border-[var(--line)] px-1.5 text-[10px] aria-disabled:opacity-60" aria-disabled={plugin.pluginEnabled == null} aria-pressed={plugin.pluginEnabled ?? undefined} title={shortcut ? `${plugin.plugin} · ${shortcut}` : plugin.plugin ?? undefined} onClick={() => { if (plugin.pluginEnabled != null) setStudioOneValue(plugin, "pluginEnabled", plugin.pluginEnabled ? 0 : 1); }}>
                        <span className="min-w-0 flex-1 truncate text-left">{plugin.plugin}</span>
                        <span className="shrink-0">{plugin.pluginEnabled == null ? "只读" : plugin.pluginEnabled ? "关闭" : "启动"}</span>
                      </button>
                    </li> : <li key={index}>
                      <select className="studio-one-plugin studio-one-plugin-empty h-6 w-full truncate rounded border border-dashed border-[var(--line)] bg-[var(--shade)] px-1.5 text-[10px] text-[var(--ink-2)]"
                        aria-label={`${group.name} 插槽 ${index + 1}：选择已加载插件`} value=""
                        onChange={(event) => { if (event.currentTarget.value) assignPluginSlot(group.key, index, event.currentTarget.value); }}>
                        <option value="">＋ 空插槽 {index + 1}</option>
                        {options.length > 0 ? options.map(([optionKey, option]) => <option key={optionKey} value={optionKey}>{option.plugin}</option>)
                          : <option disabled>没有可展示的已加载插件</option>}
                      </select>
                    </li>;
                  })}
                </ul>
                <div className="studio-one-fader-wrap">
                  {volumeChannel && <>
                    <input aria-label={`${group.name}推子`} aria-valuetext={`${formatFaderDb((volumeChannel.volume ?? 0) / (volumeChannel.maxVolume || 1))} dB`} aria-orientation="vertical" type="range" min="0" max={volumeChannel.maxVolume ?? 1} step="0.001" className="studio-one-fader" style={{ "--fader-fill": `${(volumeChannel.volume ?? 0) / (volumeChannel.maxVolume || 1) * 100}%` } as CSSProperties} value={volumeChannel.volume ?? 0} onChange={(event) => setStudioOneValue(volumeChannel, "volume", Number(event.currentTarget.value))} />
                    <FaderVolumeInput key={volumeChannel.token} name={group.name} value={volumeChannel.volume ?? 0}
                      max={volumeChannel.maxVolume ?? 1} onChange={(value) => setStudioOneValue(volumeChannel, "volume", value)} />
                  </>}
                </div>
                <div className="flex gap-1">
                  {muteChannel && <button type="button" className="btn-ghost !h-7 flex-1 !px-1 text-[11px] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-strong)]" aria-pressed={muteChannel.mute ?? false} onClick={() => setStudioOneValue(muteChannel, "mute", muteChannel.mute ? 0 : 1)}>静音</button>}
                  {monitorChannel && <button type="button" className="btn-ghost !h-7 flex-1 !px-1 text-[11px] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-strong)]" title={monitorKey && effectShortcuts[monitorKey] ? `切换通道监听 · ${effectShortcuts[monitorKey]}` : "切换通道监听；宿主报告同一输入的通道互斥"} aria-pressed={monitorChannel.monitor ?? false} onClick={() => setStudioOneValue(monitorChannel, "monitor", monitorChannel.monitor ? 0 : 1)}>切换效果</button>}
                </div>
              </div>;
            })}
            {!studioOneGroups.length && !studioOneError && <div role="status" className="px-1 py-2 text-[11px] leading-relaxed text-[var(--ink-2)]">
              {studioOneHost
                ? "已识别到 Studio One，尚未收到混音台数据。请确认 Studio One 已打开工程并允许远程控制。"
                : "正在等待 Studio One 打开工程。"}
            </div>}
          </div>
        </div>}
      </section>

      {error && <div role="alert" className="break-words rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-500">{error}</div>}
    </div>
    {rackMenu && <div className="fixed inset-0 z-50" onClick={() => setRackMenu(null)} onContextMenu={(event) => { event.preventDefault(); setRackMenu(null); }}>
      <div role="menu" className="absolute grid w-48 gap-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] p-1 text-[11px] shadow-lg" style={{ left: rackMenu.x, top: rackMenu.y }}>
        {rackMenu.slot == null
          ? <button type="button" role="menuitem" className="btn-ghost !h-6 !justify-start" onClick={() => setHiddenStudioOneGroups((current) => new Set(current).add(rackMenu.group))}>隐藏通道</button>
          : <button type="button" role="menuitem" className="btn-ghost !h-6 !justify-start" onClick={() => assignPluginSlot(rackMenu.group, rackMenu.slot!, null)}>隐藏此插件</button>}
        {rackMenu.effect && <button type="button" role="menuitem" className="btn-ghost !h-6 !justify-start" onClick={() => { setShortcutError(""); setManualShortcut(null); setRecordingEffect(rackMenu.effect!); }}>设置效果快捷键</button>}
        {rackMenu.effect && effectShortcuts[rackMenu.effect] && <button type="button" role="menuitem" className="btn-ghost !h-6 !justify-start" onClick={() => void updateShortcut(rackMenu.effect!, null)}>清除快捷键 · {effectShortcuts[rackMenu.effect]}</button>}
      </div>
    </div>}
    {recordingEffect && <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onClick={() => { setRecordingEffect(null); setShortcutError(""); }}>
      <form role="dialog" aria-label="设置效果快捷键" className="grid w-64 gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-4 text-[12px] shadow-xl" onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); if (manualShortcut?.trim()) void updateShortcut(recordingEffect, manualShortcut.trim()); }}>
        <label htmlFor="effect-shortcut-input" className="font-semibold">按下按键或组合键</label>
        <input id="effect-shortcut-input" readOnly={manualShortcut === null} autoFocus className="min-w-0 rounded border border-[var(--line)] bg-[var(--shade)] px-2 py-1.5"
          value={manualShortcut ?? effectShortcuts[recordingEffect] ?? ""} placeholder="例如 F8 或 Ctrl+Shift+J"
          onChange={(event) => setManualShortcut(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setRecordingEffect(null); setShortcutError(""); return; }
            if (manualShortcut !== null || (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey)) return;
            event.preventDefault();
            const binding = shortcutFor(event.nativeEvent);
            if (binding) void updateShortcut(recordingEffect, binding);
          }} />
        <span className="text-[var(--ink-2)]">主播控制台最小化或切到其他应用时也能使用。</span>
        {shortcutError && <span role="alert" className="text-rose-500">{shortcutError}</span>}
        <div className="flex justify-end gap-1">
          {manualShortcut === null
            ? <button type="button" className="btn-ghost !h-7" onClick={() => setManualShortcut("")}>手动输入</button>
            : <button type="submit" className="btn-ghost !h-7">保存</button>}
          <button type="button" className="btn-ghost !h-7" onClick={() => { setRecordingEffect(null); setShortcutError(""); }}>取消</button>
        </div>
      </form>
    </div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<HostConsole />);
