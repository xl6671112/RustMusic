import { useEffect, useState } from "react";
import { Copy, Pencil, Globe, ListMusic, Plus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import ViewShell from "../components/ViewShell";
import CoverImg from "../components/CoverImg";
import PlaylistAccompanimentButton from "../components/PlaylistAccompanimentButton";
import UserAccountSettings from "../components/UserAccountSettings";
import { InputModal, ConfirmModal } from "../components/Dialogs";
import { currentAccount, subscribeAccount } from "../userAccount";
import { syncAccountPages, replacePlaylistPageLink, editPlaylistPage, importLocalPages, deletePlaylistPage, openPlaylistPageEditor, playlistPageInput, readPlaylistPages, subscribePlaylistPages, type SavedPlaylistPage } from "../playlistPages";

export default function PlaylistPagesView() {
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const uiTheme = useStore((s) => s.uiTheme);
  const toast = useStore((s) => s.toast);
  const [creating, setCreating] = useState(false);
  const [pages, setPages] = useState(readPlaylistPages);
  const [account, setAccount] = useState(currentAccount);
  const [replacing, setReplacing] = useState<SavedPlaylistPage | null>(null);
  const [deleting, setDeleting] = useState<SavedPlaylistPage | null>(null);
  useEffect(() => subscribePlaylistPages(() => setPages(readPlaylistPages())), []);
  useEffect(() => subscribeAccount(() => setAccount(currentAccount())), []);
  useEffect(() => {
    const report = (e: Event) => toast((e as CustomEvent<string>).detail, "error");
    window.addEventListener("playlist-pages-error", report);
    return () => window.removeEventListener("playlist-pages-error", report);
  }, [toast]);
  const copy = (url: string) => void navigator.clipboard.writeText(url).then(() => toast("链接已复制", "success")).catch(() => toast("复制失败，请重试", "error"));
  return <ViewShell uiTheme={uiTheme} header={<div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">网页歌单</h1><p className="text-[var(--ink-3)] text-[12px] mt-2">收藏喜欢的歌曲，一键生成美观的歌单网页。</p></div><div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={!account} onClick={() => void syncAccountPages().catch(e => toast(String(e), "error"))}>同步帐号网页</button><button className="btn-secondary" disabled={!account} onClick={() => void importLocalPages().then(() => toast("本机旧网页已关联帐号", "success")).catch(e => toast(String(e), "error"))}>关联本机旧网页</button><PlaylistAccompanimentButton /><button className="btn-primary flex gap-2 items-center" onClick={() => setCreating(true)}><Plus size={15} />新建歌单</button></div></div>}>
    <div className="overflow-y-auto flex-1 min-h-0 p-4 space-y-6">
      {!account && <UserAccountSettings compact className="rounded-2xl border border-[var(--line)] p-4" />}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {playlists.map((playlist) => {
          const input = playlistPageInput(playlist, tracks);
          return <article key={playlist.id} onContextMenu={(e) => { e.preventDefault(); openPlaylistPageEditor(input); }} className="p-4 rounded-2xl bg-[var(--shade)] border border-[var(--line)] flex flex-wrap items-center gap-3">
            <button className="flex gap-3 items-center flex-1 min-w-[140px] text-left" onClick={() => useStore.getState().setView("playlist", playlist.id)}><CoverImg src={playlist.cover} seed={playlist.name} className="w-12 h-12 rounded-xl shrink-0" /><span className="min-w-0"><strong className="block truncate">{playlist.name}</strong><span className="text-xs text-[var(--ink-3)]">{input.tracks.length} 首歌曲</span></span></button>
            <button className="btn-secondary flex items-center gap-2" disabled={!input.tracks.length} onClick={() => openPlaylistPageEditor(input)}><Globe size={14} />生成网页</button>
            <PlaylistAccompanimentButton playlist={playlist} />
          </article>;
        })}
        {!playlists.length && <div className="p-8 text-[var(--ink-3)] text-center col-span-full"><ListMusic className="mx-auto mb-3" />还没有歌单。新建后，右键歌曲即可收藏到歌单。</div>}
      </section>
      {!!pages.length && <section><h2 className="font-semibold mb-3">已生成的网页</h2><div className="space-y-2">{pages.map((page) => <article key={page.slug} className="p-4 rounded-xl border border-[var(--line)] flex flex-wrap gap-3 items-center"><div className="flex-1 min-w-[140px]"><strong className="block truncate">{page.title}</strong><span className="block text-xs text-[var(--ink-3)] break-all">{page.url}</span></div><button className="btn-secondary" title="编辑歌单网页" disabled={!account} onClick={() => void editPlaylistPage(page).catch(e => toast(String(e), "error"))}><Pencil size={14} /></button><button className="btn-secondary" title="复制歌单网页链接" onClick={() => copy(page.url)}><Copy size={14} /></button><button className="btn-secondary" disabled={!account} onClick={() => setReplacing(page)}>更换链接</button><button className="btn-secondary" title="删除歌单网页" disabled={!account} onClick={() => setDeleting(page)}><Trash2 size={14} /></button></article>)}</div></section>}
    </div>
    <InputModal open={creating} title="新建歌单" placeholder="给歌单起个名字" onClose={() => setCreating(false)} onConfirm={(name) => void useStore.getState().createPlaylist(name).catch((e) => toast(String(e), "error"))} />
    <ConfirmModal open={!!replacing} title="删除旧链接并重新生成" children="旧链接会立即失效。歌单内容与外观设置会保留，随后可重新填写地址后缀并发布。" onClose={() => setReplacing(null)} onConfirm={() => { if (replacing) void replacePlaylistPageLink(replacing).then(() => setReplacing(null)).catch(e => toast(String(e), "error")); }} />
    <ConfirmModal open={!!deleting} title="删除歌单网页" children="删除后分享链接将失效，播放器中的歌单和歌曲会保留。" onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) void deletePlaylistPage(deleting).then(() => { setDeleting(null); toast("网页已删除", "success"); }).catch((e) => toast(String(e), "error")); }} />
  </ViewShell>;
}
