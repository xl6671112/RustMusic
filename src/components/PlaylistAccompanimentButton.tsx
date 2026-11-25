import { Music2 } from "lucide-react";
import { useStore } from "../store";
import type { Playlist } from "../types";
import { enqueuePlaylistAccompaniments } from "../playlistAccompaniment";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "./Modal";

type Model = { id: string; name: string; architecture: string; description: string };

export default function PlaylistAccompanimentButton({ playlist }: { playlist?: Playlist }) {
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const toast = useStore((s) => s.toast);
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const enqueue = (modelId: string) => {
      const result = enqueuePlaylistAccompaniments(playlist ? [playlist] : playlists, tracks, modelId);
      const details = [
        `已加入 ${result.queued} 首伴奏任务`,
        result.pending ? `${result.pending} 首已在队列` : "",
        result.duplicates ? `${result.duplicates} 首重复歌曲已合并` : "",
        result.unavailable ? `${result.unavailable} 首缺失或不支持，已跳过` : "",
      ].filter(Boolean).join("；");
      toast(details + "。可在下方 AI 处理任务中查看进度。", result.queued ? "success" : "info");
      setOpen(false);
  };
  return <><button
    type="button"
    className="btn-secondary flex items-center justify-center gap-2 shrink-0"
    disabled={busy || (playlist ? !playlist.entries?.length && !playlist.trackIds.length : !playlists.length)}
    title="按歌单顺序加入 AI 处理任务，重复歌曲不重复排队，已有伴奏优先复用"
    onClick={async () => {
      setBusy(true);
      try {
        const [available, settings] = await Promise.all([
          invoke<Model[]>("list_ai_models"), invoke<{ modelId: string }>("get_ai_runtime_settings"),
        ]);
        if (!available.length) throw new Error("请先在设置中下载或导入 AI 模型");
        const preferred = available.find((m) => m.id === settings.modelId)
          ?? available.find((m) => m.architecture === "mdx-hq3") ?? available[0];
        if (available.length === 1) enqueue(preferred.id);
        else { setModels(available); setSelected(preferred.id); setOpen(true); }
      } catch (error) { toast(String(error), "error"); }
      finally { setBusy(false); }
    }}
  ><Music2 size={14} />{busy ? "正在读取模型…" : playlist ? "整单生成伴奏" : "所有歌单生成伴奏"}</button>
    <Modal open={open} onClose={() => setOpen(false)} title="选择本次提取模型" width={Math.min(440, window.innerWidth - 24)}>
      <div className="space-y-4 text-[13px]">
        <select aria-label="本次提取模型" className="w-full h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)]" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
        <p className="text-[var(--ink-3)] leading-relaxed break-words">{models.find((m) => m.id === selected)?.description || "使用所选模型生成伴奏。"}</p>
        <p className="text-[11px] text-[var(--ink-3)]">本批歌曲使用同一模型，不改变全局设置；仅复用相同模型的本地缓存。</p>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>取消</button><button className="btn-primary" disabled={!selected} onClick={() => enqueue(selected)}>开始生成</button></div>
      </div>
    </Modal></>;
}
