import { invoke } from "@tauri-apps/api/core";
import { getAccompanimentTasks, subscribeAccompanimentTasks, type AccompanimentResult } from "./accompanimentTasks";

export type AccompanimentSource = {
  kind: string; id?: string | number; path?: string;
  title?: string; artist?: string; album?: string; durationMs?: number;
};

let snapshot: readonly AccompanimentResult[] = [];
let loading: Promise<void> | undefined;
let loaded = false;
const listeners = new Set<() => void>();
const seenResults = new WeakSet<AccompanimentResult>();
const notify = () => listeners.forEach((listener) => listener());
const normalizePath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export function hasSavedAccompaniment(items: readonly AccompanimentResult[], source: AccompanimentSource) {
  const instrumental = items.filter((item) => item.stem !== "vocals" && !!item.path);
  if (instrumental.some((item) => source.id != null && String(source.id) !== ""
    && item.sourceKind === source.kind && item.sourceId === String(source.id)
    || !!source.path && [item.path, item.originalSource].some((path) => !!path && normalizePath(path) === normalizePath(source.path!))
    || source.kind === "netease" && item.cloudId != null && String(item.cloudId) === String(source.id))) return true;
  const equal = (left?: string, right?: string) => !!left?.trim() && left.trim().toLowerCase() === right?.trim().toLowerCase();
  return instrumental.filter((item) => equal(item.title, source.title) && equal(item.artist, source.artist)
    && equal(item.album, source.album) && item.durationMs > 0 && (source.durationMs ?? 0) > 0
    && Math.abs(item.durationMs - source.durationMs!) <= 2500).length === 1;
}

export function rememberAccompaniment(result: AccompanimentResult) {
  if (result.stem === "vocals" || !result.path || seenResults.has(result)) return;
  seenResults.add(result);
  snapshot = [...snapshot.filter((item) => item.path !== result.path), result];
  notify();
}

export function refreshAccompanimentAvailability() {
  if (loading) return loading;
  loading = invoke<AccompanimentResult[]>("list_accompaniments").then((items) => {
    snapshot = Array.isArray(items) ? items : [];
    for (const task of getAccompanimentTasks()) {
      if (task.result && !snapshot.some((item) => item.path === task.result!.path)) snapshot = [...snapshot, task.result];
    }
    loaded = true;
    notify();
  }).catch(() => { loaded = false; }).finally(() => { loading = undefined; });
  return loading;
}

subscribeAccompanimentTasks(() => {
  for (const task of getAccompanimentTasks()) if (task.result) rememberAccompaniment(task.result);
});

export function subscribeAccompanimentAvailability(listener: () => void) {
  if (!listeners.size) window.addEventListener("focus", refreshAccompanimentAvailability);
  listeners.add(listener);
  if (!loaded) void refreshAccompanimentAvailability();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("focus", refreshAccompanimentAvailability);
  };
}

export const getAccompanimentAvailability = () => snapshot;
