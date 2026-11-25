//! 在线曲目右键菜单（Portal 到 body）。
import { createPortal } from "react-dom";
import { Globe, Heart, Play } from "lucide-react";
import { useStore } from "../../store";
import { useI18n } from "../../i18n";
import { clampMenuPos } from "../../utils";
import type { OnlineRow } from "./shared";
import AccompanimentAction from "../../components/AccompanimentAction";
import { useState } from "react";

export function RowMenu({
  menu,
  onClose,
  menuAction,
  onAddToPlaylist,
  onCreatePlaylistPage,
}: {
  menu: { x: number; y: number; row: OnlineRow };
  onClose: () => void;
  menuAction: (row: OnlineRow, action: "play" | "next" | "queue") => void;
  onAddToPlaylist: (row: OnlineRow) => void;
  onCreatePlaylistPage?: () => void;
}) {
  const { tr } = useI18n();
  const toggleLikeOnline = useStore((s) => s.toggleLikeOnline);
  const downloadOnline = useStore((s) => s.downloadOnline);
  const uiTheme = useStore((s) => s.uiTheme);
  const isLiquid = uiTheme === "liquid";
  const [status, setStatus] = useState("");

  return createPortal(
    <div
      className={`fixed z-[75] w-[215px] max-h-[calc(100vh-24px)] overflow-y-auto glass-strong p-1.5 shadow-2xl anim-menu ${
        isLiquid ? "!rounded-2xl" : "rounded-xl"
      }`}
      style={(() => {
        const p = clampMenuPos(menu.x, menu.y, 215, Math.min(400, window.innerHeight - 24));
        return { left: p.x, top: p.y };
      })()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      {[
        { label: tr("播放", "Play"), action: "play" as const },
        { label: tr("下一首播放", "Play Next"), action: "next" as const },
        { label: tr("加入队列", "Add to Queue"), action: "queue" as const },
      ].map((item) => (
        <button
          key={item.action}
          className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left"
          onClick={() => {
            menuAction(menu.row, item.action);
            onClose();
          }}
        >
          <Play size={13} /> {item.label}
        </button>
      ))}
      <div className="my-1 mx-2 border-t border-[var(--line)]" />
      <button
        className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left"
        onClick={() => {
          onAddToPlaylist(menu.row);
          onClose();
        }}
      >
        <Heart size={13} /> {tr("收藏到歌单…", "Save to Playlist…")}
      </button>
      <AccompanimentAction online={menu.row} onStatus={setStatus} />
      {onCreatePlaylistPage && <button className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left" onClick={() => { onCreatePlaylistPage(); onClose(); }}>
        <Globe size={13} />{tr("当前列表生成网页", "Create Page from List")}
      </button>}
      {status && <div role="status" className="px-2.5 py-1 text-[11px] text-[var(--ink-2)] break-all">{status}</div>}
      <button
        className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left"
        onClick={() => {
          toggleLikeOnline({
            kind: menu.row.kind,
            id: menu.row.id,
            name: menu.row.name,
            artist: menu.row.artist,
            album: menu.row.album,
            cover: menu.row.cover,
            durationMs: menu.row.durationMs,
            mediaMid: menu.row.mediaMid,
            vip: menu.row.vip,
          });
          onClose();
        }}
      >
        <Heart size={13} /> {tr("收藏到“我喜欢”", "Add to Favorites")}
      </button>
      <button
        className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--shade-strong)] text-left"
        onClick={() => {
          downloadOnline({
            kind: menu.row.kind,
            id: menu.row.id,
            name: menu.row.name,
            artist: menu.row.artist,
            album: menu.row.album,
            cover: menu.row.cover,
            durationMs: menu.row.durationMs,
            mediaMid: menu.row.mediaMid,
          });
          onClose();
        }}
      >
        <Play size={13} /> {tr("下载到本地", "Download to Library")}
      </button>
    </div>,
    document.body
  );
}
