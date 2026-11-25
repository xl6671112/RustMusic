//! 「添加到播放列表」弹窗：单行右键 / 批量多选共用（在线条目）。
import { useState } from "react";
import { useStore } from "../../store";
import { useI18n } from "../../i18n";
import Modal from "../../components/Modal";
import type { Store } from "../../store/contract";
import type { PlaylistEntryMeta } from "../../types";

type PlaylistPickerRow = Parameters<Store["addOnlineToPlaylist"]>[1] | { kind: "local"; id: number };

export function playlistEntryToPickerRow(entry: PlaylistEntryMeta): PlaylistPickerRow {
  if (entry.kind === "local") return { kind: "local", id: entry.trackId! };
  return {
    kind: entry.kind, id: entry.onlineId ?? "", name: entry.title,
    artist: entry.artist, album: entry.album, cover: entry.cover,
    durationMs: Math.round(entry.duration * 1000), mediaMid: entry.mediaMid, vip: entry.vip,
  };
}

export function PlaylistPickerModal({
  rows,
  onClose,
}: {
  rows: PlaylistPickerRow[] | null;
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const playlists = useStore((s) => s.playlists);
  const createPlaylist = useStore((s) => s.createPlaylist);
  const addOnlineToPlaylist = useStore((s) => s.addOnlineToPlaylist);
  const addToPlaylist = useStore((s) => s.addToPlaylist);
  const uiTheme = useStore((s) => s.uiTheme);
  const isLiquid = uiTheme === "liquid";
  const [newPlName, setNewPlName] = useState("");
  // “创建并添加”进行中：双击会创建两个同名歌单（后端不按名去重）
  const [creatingPl, setCreatingPl] = useState(false);

  const collect = async (pid: number) => {
    for (const row of rows ?? []) {
      if ("name" in row) await addOnlineToPlaylist(pid, row);
      else await addToPlaylist(pid, row.id);
    }
  };

  return (
    <Modal
      open={rows != null}
      onClose={onClose}
      title={
        rows && rows.length > 1
          ? tr(`收藏 ${rows.length} 首到歌单`, `Save ${rows.length} Tracks to Playlist`)
          : tr("收藏到歌单", "Save to Playlist")
      }
      width={380}
    >
      <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto">
        {playlists.map((p) => (
          <button
            key={p.id}
            disabled={creatingPl}
            className="shrink-0 h-10 gap-3 px-3 rounded-lg text-left text-[13px] text-[var(--ink)] hover:bg-[var(--shade)] flex items-center justify-between transition-colors"
            onClick={async () => {
              if (creatingPl || !rows?.length) return;
              setCreatingPl(true);
              try {
                await collect(p.id);
                onClose();
              } finally {
                setCreatingPl(false);
              }
            }}
          >
            <span className="truncate">{p.name}</span>
            <span className="shrink-0 text-[11px] text-[var(--ink-2)]">
              {tr(`${p.entries.length} 首`, `${p.entries.length} ${p.entries.length === 1 ? "track" : "tracks"}`)}
            </span>
          </button>
        ))}
        {!playlists.length && (
          <div className="text-[12.5px] text-[var(--ink-2)] py-2">
            {tr("还没有歌单，在下方创建", "No playlists yet. Create one below.")}
          </div>
        )}
      </div>
      <div className="flex gap-2 mt-3">
        <input
          type="text"
          value={newPlName}
          onChange={(e) => setNewPlName(e.target.value)}
          placeholder={tr("新歌单名称", "New playlist name")}
          className={
            isLiquid
              ? "liquid-input min-w-0 flex-1 h-9 rounded-lg px-3 text-[13px]"
              : "min-w-0 flex-1 h-9 rounded-lg bg-[var(--shade)] border border-[var(--line)] px-3 text-[13px] focus:border-[var(--line)] outline-none"
          }
        />
        <button
          className="btn-secondary shrink-0 whitespace-nowrap"
          disabled={creatingPl}
          onClick={async () => {
            if (creatingPl || !newPlName.trim() || !rows?.length) return;
            setCreatingPl(true);
            try {
              const pid = await createPlaylist(newPlName.trim());
              if (pid < 0) return;
              await collect(pid);
              setNewPlName("");
              onClose();
            } finally {
              setCreatingPl(false);
            }
          }}
        >
          {tr("新建并收藏", "Create & Save")}
        </button>
      </div>
    </Modal>
  );
}
