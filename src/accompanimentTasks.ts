import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AccompanimentOnlineInput = {
  kind: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  durationMs: number;
  mediaMid: string;
};

export type AccompanimentResult = {
  path: string;
  device: string;
  model: string;
  uploadStatus: string;
  uploadError?: string;
  uploadWarning?: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  durationMs: number;
  sourceKind: string;
  sourceId: string;
  originalSource?: string;
  online?: AccompanimentOnlineInput;
  vocalsPath?: string;
  vocalsCloudId?: number;
  stem?: "instrumental" | "vocals" | "";
  cloudId?: number;
  cloudAccount?: string;
};

export type AccompanimentTask = {
  id: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "warning" | "failed";
  phase?: string;
  progress?: number;
  completed?: number;
  total?: number;
  result?: AccompanimentResult;
  warning?: string;
  error?: string;
  retryOf?: string;
};

type TaskInput = {
  modelId?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: string | null;
  online?: AccompanimentOnlineInput | null;
  sourceKind?: string | null;
  sourceId?: string | null;
  taskLabel?: string;
  force?: boolean;
  both?: boolean;
  regeneratePath?: string;
  uploadPath?: string;
};

type StoredTask = AccompanimentTask & { input: TaskInput };
type ProgressEvent = { taskId: string; phase: string; progress?: number; percent?: number; completed?: number; total?: number };

const listeners = new Set<() => void>();
let tasks: StoredTask[] = [];
let snapshot: readonly AccompanimentTask[] = tasks;
let active = false;

export function formatAccompanimentTitle(title: string) {
  return title.endsWith("（伴奏）") ? title : `${title}（伴奏）`;
}

export function formatStemTitle(title: string, stem: "instrumental" | "vocals") {
  const original = title.replace(/（(?:伴奏|人声)）$/, "");
  return `${original}（${stem === "vocals" ? "人声" : "伴奏"}）`;
}

export function stemLibraryItems(results: AccompanimentResult[], stem: "instrumental" | "vocals") {
  const items = results.filter((item) => (item.stem || "instrumental") === stem);
  if (stem !== "vocals") return items;
  const paths = new Set(items.map((item) => item.path));
  for (const result of results) {
    if (result.stem === "vocals") continue;
    const path = result.vocalsPath || (result.vocalsCloudId ? `cloud:${result.vocalsCloudId}` : "");
    if (!path || paths.has(path)) continue;
    paths.add(path);
    items.push({ ...result, path, stem: "vocals", vocalsPath: undefined, vocalsCloudId: undefined,
      cloudId: result.vocalsCloudId, uploadStatus: result.vocalsCloudId ? "uploaded" : "local_only", uploadError: undefined });
  }
  return items;
}

function publish() {
  snapshot = tasks.map(({ input: _input, ...task }) => task);
  for (const listener of listeners) listener();
}

function updateTask(id: string, update: Partial<StoredTask>) {
  tasks = tasks.map((task) => task.id === id ? { ...task, ...update } : task);
  publish();
}

async function runNext() {
  if (active) return;
  const task = tasks.find((item) => item.status === "queued");
  if (!task) return;
  active = true;
  updateTask(task.id, { status: "running", phase: "starting", progress: undefined });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<ProgressEvent>("accompaniment://progress", ({ payload }) => {
      if (payload.taskId !== task.id) return;
      const completed = Number.isInteger(payload.completed) && payload.completed! >= 0 ? payload.completed : undefined;
      const total = Number.isInteger(payload.total) && payload.total! > 0 ? payload.total : undefined;
      const value = completed != null && total != null && completed <= total
        ? completed / total * 100
        : payload.percent ?? payload.progress;
      const progress = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : undefined;
      updateTask(task.id, { status: "running", phase: payload.phase, progress, completed, total });
    });
    const result = await invoke<AccompanimentResult>(task.input.uploadPath ? "retry_accompaniment_upload" : task.input.regeneratePath ? "regenerate_accompaniment" : "extract_accompaniment", task.input.uploadPath ? {
      path: task.input.uploadPath,
    } : task.input.regeneratePath ? {
      path: task.input.regeneratePath, taskId: task.id,
    } : {
      taskId: task.id,
      source: task.input.source ?? null,
      online: task.input.online ?? null,
      title: task.input.title,
      artist: task.input.artist,
      album: task.input.album,
      sourceKind: task.input.sourceKind ?? null,
      sourceId: task.input.sourceId ?? null,
      force: task.input.force ?? false,
      both: task.input.both ?? false,
      modelId: task.input.modelId ?? null,
    });
    const warning = result.uploadError || result.uploadWarning || (result.uploadStatus !== "uploaded" ? "upload-skipped" : undefined);
    updateTask(task.id, {
      status: warning ? "warning" : "succeeded",
      phase: "complete",
      progress: 100,
      completed: undefined,
      total: undefined,
      result: { ...result, cover: result.cover ?? "", durationMs: result.durationMs ?? 0 },
      warning,
    });
  } catch (error) {
    updateTask(task.id, { status: "failed", phase: undefined, progress: undefined, error: String(error) });
  } finally {
    unlisten?.();
    active = false;
    void runNext();
  }
}

export function regenerateAccompaniment(result: AccompanimentResult) {
  if (tasks.some((task) => task.input.regeneratePath === result.path && (task.status === "queued" || task.status === "running"))) return;
  enqueueAccompanimentTask({ regeneratePath: result.path, taskLabel: `${result.title} · 重新生成` });
}

export function uploadSavedAccompaniment(result: AccompanimentResult) {
  if (tasks.some((task) => task.input.uploadPath === result.path && (task.status === "queued" || task.status === "running"))) return;
  enqueueAccompanimentTask({ uploadPath: result.path, taskLabel: `${result.title} · 云盘同步` });
}

export function enqueueAccompanimentTask(input: TaskInput, retryOf?: string) {
  const id = crypto.randomUUID();
  tasks = [...tasks, {
    id,
    title: input.taskLabel ?? ([input.title, input.artist].filter(Boolean).join(" - ") || "AI 伴奏"),
    status: "queued",
    input,
    retryOf,
  }];
  publish();
  void runNext();
  return id;
}

export function retryAccompanimentUpload(id: string) {
  const task = tasks.find((item) => item.id === id);
  if (!task?.result || (task.result.uploadStatus === "uploaded" && !task.result.uploadError)) return;
  if (tasks.some((item) => item.retryOf === id && (item.status === "queued" || item.status === "running"))) return;
  const result = task.result;
  enqueueAccompanimentTask({
    ...task.input, uploadPath: result.path, regeneratePath: undefined, force: false,
    source: result.originalSource ?? task.input.source, online: result.online ?? task.input.online,
    title: result.title, artist: result.artist, album: result.album,
    sourceKind: result.sourceKind, sourceId: result.sourceId,
    taskLabel: `${task.title} · 上传重试`,
  }, id);
}

export function subscribeAccompanimentTasks(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccompanimentTasks() {
  return snapshot;
}

export function hasPendingAccompaniment(kind: string, id: string, path: string, modelId?: string) {
  return tasks.some((task) => (task.status === "queued" || task.status === "running") &&
    (!modelId || task.input.modelId === modelId) &&
    ((task.input.online?.kind === kind && task.input.online.id === id) ||
     (task.input.sourceKind === kind && task.input.sourceId === id) || task.input.source === path));
}
