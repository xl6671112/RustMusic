import { usePlayerPopover } from "./usePlayerPopover";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Activity, Check, CircleAlert, CircleX, ListChecks, Music2, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../i18n";
import { formatAccompanimentTitle, formatStemTitle, getAccompanimentTasks, regenerateAccompaniment, retryAccompanimentUpload, subscribeAccompanimentTasks } from "../accompanimentTasks";

const phaseText: Record<string, [string, string]> = {
  starting: ["启动中", "Starting"],
  cloud_check: ["检查云盘伴奏", "Checking cloud accompaniments"],
  download: ["下载中", "Downloading"],
  decoding: ["准备音频", "Preparing audio"],
  processing: ["提取处理中", "Processing"],
  inference: ["模型提取中", "Extracting"],
  loading: ["加载模型中", "Loading model"],
  saving: ["保存音轨中", "Saving tracks"],
  upload: ["上传云盘中", "Uploading"],
  ready: ["音轨已生成", "Tracks ready"],
};

export default function AccompanimentTasks() {
  const tasks = useSyncExternalStore(subscribeAccompanimentTasks, getAccompanimentTasks, getAccompanimentTasks);
  const [open, setOpen] = usePlayerPopover("AccompanimentTasks");
  const [playErrors, setPlayErrors] = useState<Record<string, string>>({});
  const activeCount = tasks.filter((task) => task.status === "queued" || task.status === "running").length;

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div data-player-popover="AccompanimentTasks" className="relative flex items-center">
      <button
        type="button"
        className={`btn-ghost relative w-9 h-9 shrink-0 ${open ? "!text-[var(--accent)]" : ""}`}
        aria-label={tr("AI 处理任务", "AI tasks")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={tr("AI 处理任务", "AI tasks")}
        onClick={() => setOpen((value) => !value)}
      >
        <ListChecks size={16} />
        {activeCount > 0 && <span className="absolute -top-1 -right-1 min-w-[15px] px-1 rounded-full text-[9px] leading-[15px] text-[var(--accent-on)] font-bold" style={{ background: "var(--accent)" }}>{activeCount > 99 ? "99+" : activeCount}</span>}
      </button>
      {open && <>
        <div role="dialog" aria-label={tr("AI 处理任务", "AI tasks")} className="absolute right-0 bottom-[48px] z-[61] w-[340px] max-w-[calc(100vw-24px)] rounded-xl glass-strong p-3" style={{ boxShadow: "var(--bar-shadow)" }}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[12px] font-semibold text-[var(--ink)]">{tr("AI 伴奏任务", "AI accompaniment tasks")}</span>
            <span className="text-[10px] tabular-nums text-[var(--ink-3)]">{activeCount ? tr(`${activeCount} 项进行中或排队`, `${activeCount} active or queued`) : tr(`${tasks.length} 项`, `${tasks.length} total`)}</span>
          </div>
          {tasks.length === 0 ? <div className="py-5 text-center text-[11px] text-[var(--ink-3)]">{tr("尚无处理任务", "No processing tasks")}</div> :
            <div className="max-h-[min(60vh,360px)] space-y-1 overflow-y-auto">
              {tasks.map((task) => {
                const activeTask = task.status === "queued" || task.status === "running";
                const result = task.result;
                const playError = playErrors[task.id];
                const retryPending = tasks.some((item) => item.retryOf === task.id && (item.status === "queued" || item.status === "running"));
                const warning = task.warning === "upload-skipped"
                  ? tr("未登录网易云，已跳过上传", "Upload skipped because NetEase is not logged in")
                  : task.warning;
                const phase = phaseText[task.phase ?? ""] ?? ["处理中", "Processing"];
                const status = task.status === "queued"
                  ? tr("排队中", "Queued")
                  : task.status === "running"
                    ? tr(phase[0], phase[1])
                    : task.status === "failed"
                      ? tr("失败", "Failed")
                      : task.status === "warning"
                        ? tr("本地已完成，有提示", "Local result ready with notice")
                        : tr("已完成", "Completed");
                const StatusIcon = task.status === "failed" ? CircleX : task.status === "warning" ? CircleAlert : task.status === "succeeded" ? Check : activeTask ? Activity : Music2;
                const percentage = task.progress == null ? null : `${Number(task.progress.toFixed(1))}%`;
                const progressText = percentage == null ? status : task.phase === "inference" ? tr(`模型处理 ${percentage}`, `Model processing ${percentage}`) : `${status} ${percentage}`;
                return <div key={task.id} data-ai-task={task.id} className="min-w-0 rounded-lg px-2.5 py-2 hover:bg-[var(--shade)]">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusIcon size={14} className={`shrink-0 ${task.status === "failed" ? "text-rose-400" : task.status === "warning" ? "text-amber-400" : task.status === "succeeded" ? "text-emerald-400" : "text-[var(--accent-strong)]"}`} />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--ink)]" title={task.title}>{task.title}</span>
                    <span className="shrink-0 text-[10px] text-[var(--ink-3)]">{status}</span>
                  </div>
                  {activeTask && <div className="mt-1.5 ml-[22px] h-1.5 overflow-hidden rounded-full bg-[var(--shade-strong)]" role="progressbar" aria-label={task.title} aria-valuemin={task.progress == null ? undefined : 0} aria-valuemax={task.progress == null ? undefined : 100} aria-valuenow={task.progress} aria-valuetext={progressText}>
                    {task.progress != null
                      ? <div className="ai-progress-fill h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${task.progress}%` }} />
                      : task.status === "running" ? <div className="ai-progress-indeterminate h-full w-1/3 rounded-full bg-[var(--accent)]" /> : null}
                  </div>}
                  {task.progress != null && <div className="mt-1 ml-[22px] flex flex-wrap justify-end gap-x-2 text-[10px] tabular-nums text-[var(--ink-3)]"><span>{progressText}</span>{task.completed != null && task.total != null && <span>{task.completed} / {task.total}</span>}</div>}
                  {result && <div className="mt-1.5 ml-[22px] flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[10px] text-[var(--ink-3)]" title={`${result.device} · ${result.model}`}>{result.device} · {result.model}</span>
                    <div className="flex max-w-full flex-wrap items-center gap-1">
                      {(result.originalSource || result.online) && <button type="button" className="btn-ghost !w-auto !h-6 !px-2 text-[10px]" title={tr("重新提取，成功后替换旧伴奏", "Regenerate and replace after success")} onClick={() => regenerateAccompaniment(result)}>{tr("重新生成", "Regenerate")}</button>}
                      {task.status === "warning" && (result.uploadError || result.uploadStatus !== "uploaded") && <button type="button" className="btn-ghost !w-7 !h-6" aria-label={tr("重试上传", "Retry upload")} title={tr("重试网易云云盘上传", "Retry NetEase cloud upload")} disabled={retryPending} onClick={() => retryAccompanimentUpload(task.id)}><RefreshCw size={11} /></button>}
                      {(result.vocalsPath || result.vocalsCloudId) && <button type="button" className="btn-ghost !w-auto !h-6 !px-2 text-[10px]" onClick={() => {
                        void invoke("play_accompaniment", { path: result.vocalsPath || `cloud:${result.vocalsCloudId}`, title: formatStemTitle(result.title, "vocals"), artist: result.artist, album: result.album, cover: result.cover, durationMs: result.durationMs, sourceKind: result.sourceKind, sourceId: result.sourceId }).catch((error) => setPlayErrors((value) => ({ ...value, [task.id]: String(error) })));
                      }}>播放人声</button>}
                      <button type="button" className="btn-ghost !w-auto !h-6 !px-2 text-[10px] flex items-center gap-1" onClick={() => {
                        setPlayErrors((value) => ({ ...value, [task.id]: "" }));
                        void invoke("play_accompaniment", {
                          path: result.path,
                          title: formatAccompanimentTitle(result.title),
                          artist: result.artist,
                          album: result.album,
                          cover: result.cover,
                          durationMs: result.durationMs,
                          sourceKind: result.sourceKind,
                          sourceId: result.sourceId,
                        }).catch((error) => setPlayErrors((value) => ({ ...value, [task.id]: String(error) })));
                      }}><Music2 size={11} />{tr("播放伴奏", "Play accompaniment")}</button>
                    </div>
                  </div>}
                  {(warning || task.error || playError || result?.path) && <details className="mt-1 ml-[22px] text-[10px] text-[var(--ink-3)]">
                    <summary className="cursor-pointer">{tr("详情", "Details")}</summary>
                    {warning && <div className="mt-1 break-words text-amber-400">{warning}</div>}
                    {task.error && <div className="mt-1 break-all text-rose-400">{task.error}</div>}
                    {playError && <div className="mt-1 break-all text-rose-400">{playError}</div>}
                    {result?.path && <div className="mt-1 break-all">{result.path}</div>}
                  </details>}
                </div>;
              })}
            </div>}
        </div>
      </>}
    </div>
  );
}
