import { Music2 } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enqueueAccompanimentTask } from "../accompanimentTasks";
import { contextModels, subscribeContextModels } from "../aiContextModels";
import type { TrackMeta } from "../types";
import type { OnlineRow } from "../views/online/shared";

type AccompanimentOnlineRow = Omit<OnlineRow, "kind"> & { kind: OnlineRow["kind"] | "bilibili" | "navidrome" };

export default function AccompanimentAction({ track, online, onStatus }: { track?: TrackMeta; online?: AccompanimentOnlineRow; onStatus?: (text: string) => void }) {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelId, setModelId] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void invoke<{ id: string; name: string }[]>("list_ai_models").then((available) => {
        if (disposed) return;
        const allowed = contextModels(available);
        setModels(allowed);
        setModelId((id) => allowed.some((model) => model.id === id) ? id : "");
      }).catch(() => { /* Default extraction remains available if discovery fails. */ });
    };
    refresh();
    const unsubscribe = subscribeContextModels(refresh);
    window.addEventListener("ai-models-changed", refresh);
    return () => { disposed = true; unsubscribe(); window.removeEventListener("ai-models-changed", refresh); };
  }, []);
  const enqueue = (force: boolean, both = false) => {
      enqueueAccompanimentTask({
        source: track?.path ?? null,
        online: online ? {
          kind: online.kind,
          id: String(online.id),
          title: online.name,
          artist: online.artist,
          album: online.album,
          cover: online.cover,
          durationMs: online.durationMs,
          mediaMid: online.mediaMid ?? "",
        } : null,
        title: track?.title ?? online?.name,
        artist: track?.artist ?? online?.artist,
        album: track?.album ?? online?.album,
        sourceKind: track ? "track" : null,
        sourceId: track ? String(track.id) : null,
        force,
        both,
        modelId: modelId || undefined,
      });
      onStatus?.(force ? "已加入重新生成任务，完成后替换旧伴奏" : both ? "已加入人声 + 伴奏生成队列" : "已加入 AI 伴奏任务队列");
  };
  const className = "w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left";
  return <>
    {!!models.length && <label className="block px-2.5 py-2 text-[11px] text-[var(--ink-3)]">
      本次提取模型
      <select aria-label="单曲提取模型" value={modelId} onChange={(e) => setModelId(e.target.value)}
        className="mt-1 block w-full min-w-0 max-w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[12px] text-[var(--ink)]">
        <option value="">使用设置中的默认模型</option>
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label>}
    <button className={className} onClick={() => enqueue(false)}><Music2 size={13} />AI 提取伴奏</button>
    <button className={className} onClick={() => enqueue(false, true)}><Music2 size={13} />同时生成人声和伴奏</button>
    <button className={className} onClick={() => enqueue(true)}><Music2 size={13} />重新生成 AI 伴奏</button>
  </>;
}
