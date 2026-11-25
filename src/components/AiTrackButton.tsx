import { usePlayerPopover } from "./usePlayerPopover";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import type { CurrentTrack } from "../types";
import { hasPendingAccompaniment, enqueueAccompanimentTask, type AccompanimentResult, getAccompanimentTasks, subscribeAccompanimentTasks } from "../accompanimentTasks";

type Stem = "instrumental" | "vocals";
export default function AiTrackButton() {
  const current = useStore((s) => s.current);
  const [open, setOpen] = usePlayerPopover("AiTrackButton");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = useRef<{ path: string; result: AccompanimentResult }>();
  const [selected, setSelected] = useState<Stem | null>(null);
  const selectedRef = useRef<Stem | null>(null);
  const operation = useRef(0);
  const [requestedStem, setRequestedStem] = useState<Stem>("instrumental");
  const [accompanimentStatus, setAccompanimentStatus] = useState<{ path: string; checked: boolean; ready: boolean }>({ path: "", checked: false, ready: false });
  const tasks = useSyncExternalStore(subscribeAccompanimentTasks, getAccompanimentTasks);
  const currentRef = useRef(current);
  const accompanimentStatusRef = useRef(accompanimentStatus);
  const toggleRef = useRef<(stem: Stem) => Promise<void>>(async () => {});
  const publishConsoleState = useRef<() => void>(() => {});
  currentRef.current = current;
  accompanimentStatusRef.current = accompanimentStatus;
  const sourceId = current ? String(current.nid ?? current.qid ?? current.kgid ?? current.id ?? current.path) : "";
  const completed = tasks.filter((t) => t.result?.sourceKind === current?.kind && t.result?.sourceId === sourceId).length;
  const pending = current ? hasPendingAccompaniment(current.kind, sourceId, current.path) : false;
  useEffect(() => {
    operation.current += 1;
    session.current = undefined; selectedRef.current = null; setSelected(null); setBusy(false); setOpen(false); setError("");
  }, [current?.path]);
  useEffect(() => {
    const track = current;
    if (!track) {
      const next = { path: "", checked: false, ready: false };
      accompanimentStatusRef.current = next;
      setAccompanimentStatus(next);
      return;
    }
    let disposed = false;
    const checking = { path: track.path, checked: false, ready: false };
    accompanimentStatusRef.current = checking;
    setAccompanimentStatus(checking);
    void invoke<AccompanimentResult | null>("find_accompaniment", { query: queryFor(track) }).then((result) => {
      if (disposed) return;
      if (result?.path) session.current = { path: track.path, result };
      else if (session.current?.path === track.path) session.current = undefined;
      const next = { path: track.path, checked: true, ready: !!result?.path };
      accompanimentStatusRef.current = next;
      setAccompanimentStatus(next);
    }).catch((reason) => {
      if (disposed) return;
      if (session.current?.path === track.path) session.current = undefined;
      const next = { path: track.path, checked: true, ready: false };
      accompanimentStatusRef.current = next;
      setAccompanimentStatus(next);
      setError(String(reason));
    });
    return () => { disposed = true; };
  }, [current?.path, completed]);
  const queryFor = (track: CurrentTrack) => ({
    kind: track.kind, id: String(track.nid ?? track.qid ?? track.kgid ?? track.id ?? track.path),
    title: track.title, artist: track.artist, album: track.album, cover: track.cover,
    durationMs: track.durationMs, mediaMid: useStore.getState().qqCache[track.qid ?? ""]?.mediaMid ?? "",
  });
  const toggle = async (stem: Stem) => {
    if (!current || busy) return;
    const request = ++operation.current;
    setRequestedStem(stem);
    setBusy(true); setError(""); setOpen(false);
    try {
      let result = session.current?.path === current.path ? session.current.result : null;
      if (!result) result = await invoke<AccompanimentResult | null>("find_accompaniment", { query: queryFor(current) });
      if (request !== operation.current || useStore.getState().current?.path !== current.path) return;
      const path = stem === "instrumental" ? result?.path : result?.vocalsPath || (result?.vocalsCloudId ? `cloud:${result.vocalsCloudId}` : "");
      if (!result || !path) { setOpen(true); return; }
      const next = selectedRef.current === stem ? null : stem;
      await invoke("switch_accompaniment", { expectedPath: current.path, target: { ...current, path }, instrumental: next !== null });
      if (request !== operation.current || useStore.getState().current?.path !== current.path) return;
      session.current = { path: current.path, result };
      selectedRef.current = next; setSelected(next);
    } catch (e) { if (request === operation.current) { setError(String(e)); setOpen(true); } }
    finally { if (request === operation.current) setBusy(false); }
  };
  toggleRef.current = toggle;
  publishConsoleState.current = () => {
    const track = currentRef.current;
    void emit("host-console://state", {
      hasTrack: !!track,
      title: track?.title ?? "",
      instrumental: selectedRef.current === "instrumental",
      busy,
      accompanimentChecked: !!track && accompanimentStatusRef.current.path === track.path && accompanimentStatusRef.current.checked,
      accompanimentReady: !!track && accompanimentStatusRef.current.path === track.path && accompanimentStatusRef.current.checked && accompanimentStatusRef.current.ready,
    }).catch(() => {});
  };
  useEffect(() => {
    let disposed = false;
    let stopRequest: (() => void) | undefined;
    let stopToggle: (() => void) | undefined;
    void listen("host-console://request-state", () => publishConsoleState.current()).then((stop) => {
      if (disposed) stop(); else stopRequest = stop;
    }).catch(() => {});
    void listen("host-console://toggle-accompaniment", () => {
      const track = currentRef.current;
      const status = accompanimentStatusRef.current;
      if (track && status.path === track.path && status.checked && status.ready) void toggleRef.current("instrumental");
    }).then((stop) => {
      if (disposed) stop(); else stopToggle = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      stopRequest?.();
      stopToggle?.();
    };
  }, []);
  useEffect(() => { publishConsoleState.current(); }, [current?.path, current?.title, selected, busy, accompanimentStatus]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return <div data-player-popover="AiTrackButton" className="relative flex shrink-0 items-center">
    <button type="button" className={`btn-ghost !w-8 !h-9 shrink-0 text-[11px] font-bold ${selected === "instrumental" ? "!text-[var(--accent)]" : ""}`} aria-label="AI 音轨切换" aria-pressed={selected === "instrumental"} aria-expanded={open && requestedStem === "instrumental"} aria-haspopup="dialog" title={busy ? "正在准备音轨" : selected === "instrumental" ? "正在播放伴奏，点击切回原曲" : pending ? "伴奏生成中" : "切换 AI 伴奏 / 生成音轨"} disabled={!current || busy} onClick={() => void toggle("instrumental")}>{busy && requestedStem === "instrumental" ? "…" : selected === "instrumental" ? "伴奏" : "AI"}</button>
    <button type="button" className={`btn-ghost !w-8 !h-9 shrink-0 text-[11px] font-bold ${selected === "vocals" ? "!text-[var(--accent)]" : ""}`} aria-label="只听人声" aria-pressed={selected === "vocals"} aria-expanded={open && requestedStem === "vocals"} aria-haspopup="dialog" title={selected === "vocals" ? "正在只听人声，点击切回原曲" : "只听 AI 提取的人声"} disabled={!current || busy} onClick={() => void toggle("vocals")}>{busy && requestedStem === "vocals" ? "…" : "人声"}</button>
    {open && <>
      <div role="dialog" aria-label="AI 音轨" className="absolute right-0 bottom-[48px] z-[61] w-[340px] max-w-[calc(100vw-24px)] rounded-xl glass-strong p-3 text-[12px]" style={{ boxShadow: "var(--bar-shadow)" }}>
        <div className="mb-1 font-semibold text-[var(--ink)]">AI 音轨</div>
        <div className="mb-3 truncate text-[11px] text-[var(--ink-3)]" title={current?.title}>{current?.title}</div>
        <p role={error ? "alert" : "status"} className="mb-3 max-h-28 overflow-y-auto break-words text-[var(--ink-2)]">{error || (pending ? "正在生成，可在右侧任务列表查看进度。" : requestedStem === "vocals" ? "还没有人声音轨，请选择“人声 + 伴奏”一起提取。" : "还没有伴奏，请选择生成方式。")}</p>
        {error ? <button className="btn-ghost !w-auto px-2" onClick={() => void toggle(requestedStem)}>重试</button> : <div className="flex gap-2">{(requestedStem === "vocals" ? [true] : [false, true]).map((both) => <button key={String(both)} disabled={pending} className="disabled:opacity-40 disabled:cursor-not-allowed min-w-0 flex-1 h-11 rounded-lg border border-[var(--line)] bg-[var(--shade)] px-2 text-center font-medium hover:bg-[var(--shade-strong)]" onClick={() => {
          if (!current) return;
          enqueueAccompanimentTask({ source: current.kind === "track" || current.kind === "url" ? current.path : null, online: current.kind === "track" || current.kind === "url" ? null : queryFor(current), title: current.title, artist: current.artist, album: current.album, sourceKind: current.kind, sourceId: queryFor(current).id, both });
          setOpen(false);
        }}>{both ? "人声 + 伴奏" : "生成伴奏"}</button>)}</div>}
      </div>
    </>}
  </div>;
}
