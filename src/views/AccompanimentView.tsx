import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CloudUpload, Globe, ListMusic, Music2, Play, RefreshCw, Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { useStore } from "../store";
import ViewShell from "../components/ViewShell";
import CoverImg from "../components/CoverImg";
import { openPlaylistPageEditor } from "../playlistPages";
import {
  formatStemTitle,
  stemLibraryItems,
  getAccompanimentTasks,
  regenerateAccompaniment,
  uploadSavedAccompaniment,
  subscribeAccompanimentTasks,
  type AccompanimentResult,
} from "../accompanimentTasks";

export default function AccompanimentView({ stem = "instrumental" }: { stem?: "instrumental" | "vocals" }) {
  const { tr } = useI18n();
  const uiTheme = useStore((s) => s.uiTheme);
  const toast = useStore((s) => s.toast);
  const tasks = useSyncExternalStore(subscribeAccompanimentTasks, getAccompanimentTasks, getAccompanimentTasks);
  const [items, setItems] = useState<AccompanimentResult[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const vocals = stem === "vocals";
  const displayTitle = (title: string) => formatStemTitle(title, stem);
  const completionKey = tasks
    .filter((task) => (task.status === "succeeded" || task.status === "warning") && task.result)
    .map((task) => task.id)
    .join("|");
  const previousCompletion = useRef(completionKey);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const results = await invoke<AccompanimentResult[]>("list_accompaniments");
      setItems(stemLibraryItems(results, stem).map((result) => ({
        ...result,
        cover: result.cover ?? "",
        durationMs: result.durationMs ?? 0,
      })));
    } catch (reason) {
      const message = String(reason);
      setError(message);
      toast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast, stem]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (completionKey === previousCompletion.current) return;
    previousCompletion.current = completionKey;
    void refresh();
  }, [completionKey, refresh]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) => `${item.title} ${item.artist} ${item.album}`.toLocaleLowerCase().includes(query));
  }, [items, search]);

  const play = (item: AccompanimentResult) => {
    void invoke("play_accompaniment", {
      path: item.path,
      title: displayTitle(item.title),
      artist: item.artist,
      album: item.album,
      cover: item.cover,
      durationMs: item.durationMs,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
    }).catch((reason) => toast(String(reason), "error"));
  };

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--ink-3)]">
          <Music2 size={12} className="text-[var(--accent)]" />
          {tr("已生成的音轨", "Generated tracks")}
        </div>
        <div className="flex items-baseline gap-3">
          <h1 className="text-[28px] font-extrabold leading-none text-[var(--ink)]">{vocals ? tr("AI 人声", "AI Vocals") : tr("AI 伴奏", "AI Accompaniments")}</h1>
          <span className="text-[12px] tabular-nums text-[var(--ink-2)]">{tr(`${items.length} 首`, `${items.length} tracks`)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary flex items-center gap-2" disabled={!filtered.length} onClick={() => openPlaylistPageEditor({ sourceKey: vocals ? "ai:vocals" : "ai:instrumental", title: vocals ? "AI 人声" : "AI 伴奏", tracks: filtered.map((item) => ({ title: displayTitle(item.title), artist: item.artist, cover: item.cover })) })}><Globe size={13} />{tr("生成歌单网页", "Create Playlist Page")}</button>
        <label className="relative block w-[min(34vw,240px)] min-w-[140px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)]" />
          <input
            aria-label={vocals ? tr("搜索人声", "Search vocals") : tr("搜索伴奏", "Search accompaniments")}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={vocals ? tr("搜索人声…", "Search vocals…") : tr("搜索伴奏…", "Search accompaniments…")}
            className={`h-8 w-full pl-8 pr-2 text-[12px] text-[var(--ink)] outline-none ${uiTheme === "liquid" ? "liquid-input rounded-xl" : "rounded-lg border border-[var(--line)] bg-[var(--shade)]"}`}
          />
        </label>
        <button type="button" className="btn-ghost h-8 w-8 shrink-0" aria-label={vocals ? tr("刷新人声列表", "Refresh vocals") : tr("刷新伴奏列表", "Refresh accompaniments")} title={tr("刷新", "Refresh")} disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
    </div>
  );

  return (
    <ViewShell uiTheme={uiTheme} header={header} headerClass="px-8 pt-6 pb-4 shrink-0" liquidHeaderClass="px-5 pt-4 pb-4 shrink-0">
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(80px,0.45fr)_minmax(70px,0.4fr)_128px] items-center gap-3 border-b border-[var(--line)] px-6 py-2.5 text-[10.5px] font-semibold tracking-wide text-[var(--ink-3)]">
        <span>{tr("标题", "TITLE")}</span>
        <span>{tr("歌手", "ARTIST")}</span>
        <span>{tr("设备", "DEVICE")}</span>
        <span className="text-right">{tr("操作", "ACTIONS")}</span>
      </div>
      {error && <div role="alert" className="px-6 py-2 text-[12px] text-rose-400 break-words">{error}</div>}
      {loading && !items.length ? (
        <div role="status" className="p-8 text-center text-[12px] text-[var(--ink-3)]">{vocals ? tr("正在加载人声…", "Loading vocals…") : tr("正在加载伴奏…", "Loading accompaniments…")}</div>
      ) : filtered.length ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((item) => (
            <div
              key={item.path}
              data-accompaniment-path={item.path}
              className="grid grid-cols-[minmax(0,1fr)_minmax(80px,0.45fr)_minmax(70px,0.4fr)_128px] items-center gap-3 border-b border-[var(--line)]/60 px-6 py-2.5 text-[12px] hover:bg-[var(--shade-hover)]"
              onDoubleClick={() => play(item)}
              title={tr("双击播放", "Double-click to play")}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <CoverImg src={item.cover} seed={`${item.artist}-${item.album}`} className="h-8 w-8 shrink-0 rounded-lg" small />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[var(--ink)]">{displayTitle(item.title)}</span>
                  {item.album && <span className="block truncate text-[10.5px] text-[var(--ink-3)]">{item.album}</span>}
                  {item.uploadError && <span className="block truncate text-[10.5px] text-amber-400" title={item.uploadError}>{tr("云盘同步未完成，本地音轨已保留", "Cloud sync pending; local audio preserved")}</span>}
                  {item.uploadWarning && <span className="block truncate text-[10.5px] text-amber-400" title={item.uploadWarning}>{item.uploadWarning}</span>}
                </span>
              </span>
              <span className="truncate text-[var(--ink-2)]">{item.artist}</span>
              <span className="truncate text-[var(--ink-3)]">{item.device}</span>
              <span className="flex justify-end" onDoubleClick={(event) => event.stopPropagation()}>
                {!item.path.startsWith("cloud:") && (item.uploadError || item.uploadStatus !== "uploaded") && <button type="button" className="btn-ghost h-8 w-8 shrink-0" aria-label={tr(`同步云盘 ${item.title}`, `Sync ${item.title} to cloud`)} title={tr("重试云盘同步", "Retry cloud sync")} onClick={() => uploadSavedAccompaniment(item)}><CloudUpload size={14} /></button>}
                {!vocals && (item.vocalsPath || item.vocalsCloudId) && <button type="button" className="btn-ghost h-8 w-8 shrink-0" aria-label={tr(`播放人声 ${item.title}`, `Play vocals ${item.title}`)} title={tr("播放人声", "Play vocals")} onClick={() => { void invoke("play_accompaniment", { path:item.vocalsPath || `cloud:${item.vocalsCloudId}`, title:formatStemTitle(item.title, "vocals"), artist:item.artist, album:item.album, cover:item.cover, durationMs:item.durationMs, sourceKind:item.sourceKind, sourceId:item.sourceId }).catch((reason) => toast(String(reason), "error")); }}><Music2 size={14} /></button>}
                {!vocals && (item.originalSource || item.online) && <button type="button" className="btn-ghost h-8 w-8 shrink-0" aria-label={tr(`重新生成 ${item.title}`, `Regenerate ${item.title}`)} title={tr("感觉不对？重新生成并替换", "Regenerate and replace")} onClick={() => regenerateAccompaniment(item)}><RefreshCw size={14} /></button>}
                <button type="button" className="btn-ghost h-8 w-8 shrink-0" aria-label={tr(`播放 ${displayTitle(item.title)}`, `Play ${displayTitle(item.title)}`)} title={tr("播放", "Play")} onClick={() => play(item)}><Play size={14} /></button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <ListMusic size={28} className="text-[var(--ink-3)]" />
          <div className="text-[13px] font-medium text-[var(--ink-2)]">{search ? (vocals ? tr("没有匹配的人声", "No matching vocals") : tr("没有匹配的伴奏", "No matching accompaniments")) : (vocals ? tr("暂无 AI 人声", "No AI vocals yet") : tr("暂无 AI 伴奏", "No AI accompaniments yet"))}</div>
          {!search && <div className="text-[11px] text-[var(--ink-3)]">{vocals ? tr("选择“人声 + 伴奏”提取后，人声会保存在这里。", "Choose Vocals + Instrumental to save vocals here.") : tr("提取完成后，伴奏会保存在这里。", "Completed accompaniments will appear here.")}</div>}
        </div>
      )}
    </ViewShell>
  );
}
