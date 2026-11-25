import { useEffect, useState } from "react";
import Modal from "./Modal";
import { validPlaylistBackground } from "../playlistAppearance";
import PlaylistAppearance from "./PlaylistAppearance";
import UserAccountSettings from "./UserAccountSettings";
import { currentAccount, subscribeAccount } from "../userAccount";
import { downloadPlaylistPage, fetchPlaylistStyles, validPlaylistCSS, type PlaylistStylePack, playlistPageHTML, publishPlaylistPage, subscribePlaylistEditor, readPlaylistPages, type PlaylistPageOptions } from "../playlistPages";

export default function PlaylistPageDialog() {
  const [draft, setDraft] = useState<PlaylistPageOptions | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionColor, setSelectionColor] = useState("#b47b29");
  const [styles, setStyles] = useState<PlaylistStylePack["styles"]>([]);
  const [stylesBusy, setStylesBusy] = useState(false);
  const [stylesMessage, setStylesMessage] = useState("");
  const refreshStyles = async () => {
    setStylesBusy(true); setStylesMessage("");
    try { setStyles((await fetchPlaylistStyles()).styles); }
    catch (error) { setStylesMessage(error instanceof Error ? error.message : String(error)); }
    finally { setStylesBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [url, setURL] = useState("");
  const [account, setAccount] = useState(currentAccount);
  useEffect(() => subscribeAccount(() => { setAccount(currentAccount()); setMessage(""); }), []);
  useEffect(() => subscribePlaylistEditor((input) => {
    setDraft({ ...input, pageTitle: "", description: "把喜欢的旋律，整理成一份美好的歌单。", columns: 1, slug: "", showArtist: true, showCover: true, background: "#fbfaf6", animation: "fade", alignChars: 0, customCss: "", styleId: "", ...input.draft });
    void refreshStyles();
    setMessage(""); setURL(""); setSelected(new Set());
  }), []);
  const update = (value: Partial<PlaylistPageOptions>) => { setDraft((old) => old ? { ...old, ...value } : old); setURL(""); };
  const move = (index: number, direction: number) => {
    if (!draft) return;
    const tracks = [...draft.tracks];
    [tracks[index], tracks[index + direction]] = [tracks[index + direction], tracks[index]];
    update({ tracks });
    setSelected((old) => new Set([...old].map((i) => i === index ? index + direction : i === index + direction ? index : i)));
  };
  const existing = readPlaylistPages().find(page => page.sourceKey && page.sourceKey === draft?.sourceKey);
  const officialStyle = styles.find((style) => style.id === draft?.styleId);
  const officialCss = officialStyle?.css ?? "";
  const editableGroups = { content: "名称与文案", layout: "排版与显示", appearance: "外观与字体", tracks: "歌曲顺序与颜色", customCss: "自定义 CSS" };
  const canEdit = (group: keyof typeof editableGroups) => officialStyle?.editable == null || officialStyle.editable.includes(group);
  const cssValid = validPlaylistCSS(draft?.customCss ?? "");
  const valid = cssValid && validPlaylistBackground(draft?.backgroundImage) && draft && draft.title.trim() && draft.tracks.length > 0 && (!draft.slug || /^[a-z0-9][a-z0-9-]{2,47}$/.test(draft.slug));
  const inputClass = "w-full h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)] outline-none disabled:opacity-40";
  return <Modal open={!!draft} onClose={() => { if (!busy) setDraft(null); }} title="创建歌单网页" width={Math.min(860, window.innerWidth - 24)}>
    {draft && <div className="max-h-[75vh] overflow-y-auto text-[13px]">
      <section className="mb-5 rounded-2xl border border-[var(--line)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">网页歌单模板</h3><button className="btn-secondary" disabled={stylesBusy} onClick={() => void refreshStyles()}>{stylesBusy ? "正在获取…" : "刷新官网风格"}</button></div>
        <label className="block space-y-2"><span>官网推送风格</span><select aria-label="官网歌单风格" className={inputClass} value={draft.styleId || ""} onChange={(e) => update({ styleId: e.target.value })}><option value="">默认风格</option>{styles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}</select></label>
        <p className="text-[12px] text-[var(--ink-2)]" data-template-editable>此模板可调整：{Object.entries(editableGroups).filter(([group]) => canEdit(group as keyof typeof editableGroups)).map(([, label]) => label).join("、") || "无（保留当前内容，仅切换模板）"}</p>
        <p className="text-[11px] text-[var(--ink-3)] leading-relaxed">模板决定布局与可调整选项。切换模板不会清除已填写的内容；已发布网页刷新后使用官网最新模板，下载的网页保留当前模板。</p>
        {stylesMessage && <p role="status" className="text-[12px] break-words">{stylesMessage}</p>}
      </section>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-4 min-w-0">
          {canEdit("content") && <>
          <label className="block space-y-2"><span>歌单名称</span><input className={inputClass} maxLength={100} value={draft.title} onChange={(e) => update({ title: e.target.value })} /></label>
          <label className="block space-y-2"><span>网页标题（浏览器标签名）</span><input aria-label="网页标题" className={inputClass} maxLength={100} placeholder="留空使用歌单名称" value={draft.pageTitle || ""} onChange={(e) => update({ pageTitle: e.target.value })} /></label>
          <label className="block space-y-2"><span>介绍文案（可留空隐藏）</span><textarea aria-label="介绍文案" className={`${inputClass} !h-20 py-2 resize-y`} maxLength={300} value={draft.description ?? ""} onChange={(e) => update({ description: e.target.value })} /></label>
          </>}
          {canEdit("layout") && <>
          <label className="flex items-center gap-2"><input aria-label="自动按歌曲宽度排列" type="checkbox" checked={!!draft.autoColumns} onChange={e => update({autoColumns:e.target.checked})} />自动按歌曲宽度排列</label>
          {draft.autoColumns && <p className="text-[11px] text-[var(--ink-3)]">自适应按歌曲内容自动排列，关闭后可手动设置列数、每排数量和 X 字对齐；原设置已保留。</p>}
          <label className="block space-y-2"><span>歌曲间距 · {draft.songGap ?? 12}px</span><input aria-label="歌曲间距" className="w-full" type="range" min={0} max={80} step={1} value={draft.songGap ?? 12} onChange={e => update({songGap:Number(e.target.value)})} /><span className="block text-[11px] text-[var(--ink-3)]">设置歌曲之间的最小横向与纵向距离；自适应时每排剩余空间会均匀分配。</span></label>
          <label className="block space-y-2"><span>每行歌曲数量</span><input disabled={!!draft.autoColumns} aria-label="每行歌曲数量" className={inputClass} type="number" min={1} max={12} value={draft.columns ?? 1} onChange={(e) => update({ columns: Math.min(12, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })} /><span className="block text-[11px] text-[var(--ink-3)]">1–12 列，可双排、三排或自定；窄屏自动减少列数，歌曲按从左到右排列。</span></label>
          <section className="space-y-3">
            <label className="flex items-center gap-2"><input disabled={!!draft.autoColumns} aria-label="逐排自定义数量" type="checkbox" checked={!!draft.rowCounts?.length} onChange={e => update({rowCounts: e.target.checked ? [draft.columns || 1] : []})} />逐排自定义数量</label>
            {!!draft.rowCounts?.length && <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {draft.rowCounts.map((count, index) => <label key={index} className="block space-y-1"><span>第 {index + 1} 排</span><input disabled={!!draft.autoColumns} aria-label={`第 ${index + 1} 排歌曲数量`} className={inputClass} type="number" min={1} max={12} value={count} onChange={e => update({rowCounts: draft.rowCounts!.map((n, i) => i === index ? Math.min(12, Math.max(1, Math.trunc(Number(e.target.value) || 1))) : n)})} /></label>)}
              </div>
              <div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={!!draft.autoColumns || draft.rowCounts.length >= 200} onClick={() => update({rowCounts: [...draft.rowCounts!, draft.rowCounts![draft.rowCounts!.length - 1]]})}>增加一排</button><button className="btn-secondary" disabled={!!draft.autoColumns || draft.rowCounts.length <= 1} onClick={() => update({rowCounts: draft.rowCounts!.slice(0, -1)})}>删除末排</button></div>
              <p className="text-[11px] text-[var(--ink-3)]">例如依次填写 3、5、2，前三排分别显示 3、5、2 首。剩余歌曲沿用最后一排数量；窄屏自动减列。仅改变网页排版，不打乱歌曲。</p>
            </>}
          </section>
          </>}
          <label className="block space-y-2"><span>网页地址后缀（留空自动生成）</span><input className={inputClass} placeholder="例如 my-favorite-songs" maxLength={48} disabled={!!existing || !!draft.draft?.slug} value={existing?.slug || draft.slug} onChange={(e) => update({ slug: e.target.value.toLowerCase() })} /><span className="block text-[11px] text-[var(--ink-3)]">生成地址：gedan.声卡.com/p/后缀。3–48 个小写字母、数字或短横线；后缀需未被使用。</span></label>
          {canEdit("layout") && <>
          <div className="flex flex-wrap gap-5"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.showArtist} onChange={(e) => update({ showArtist: e.target.checked })} />显示原歌手</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.showCover} onChange={(e) => update({ showCover: e.target.checked })} />显示歌曲封面</label></div>
          <label className="block space-y-2"><span>歌名字数对齐</span><input disabled={!!draft.autoColumns} aria-label="歌名字数对齐" type="number" min={0} max={40} className={inputClass} value={draft.alignChars} onChange={(e) => update({ alignChars: Math.min(40, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} /><span className="block text-[11px] text-[var(--ink-3)]">0 为自动；1–40 按中文字宽对齐歌名列，窄屏自动换行。</span></label>
          </>}
          {canEdit("appearance") && <label className="block space-y-2"><span>歌单动效</span><select className={inputClass} value={draft.animation} onChange={(e) => update({ animation: e.target.value as PlaylistPageOptions["animation"] })}><option value="none">静态简约</option><option value="fade">轻盈入场</option><option value="float">缓慢悬浮</option></select></label>}
          <p className="text-[11px] text-[var(--ink-3)] leading-relaxed">共 {draft.tracks.length} 首。网页展示歌单信息，不上传歌曲文件。本地封面无法供访客访问时显示音乐图标。</p>
        </div>
        <iframe title="歌单网页实时预览" sandbox="" srcDoc={playlistPageHTML(draft, officialCss, officialStyle?.html)} className="w-full h-[320px] md:h-[390px] rounded-2xl border border-[var(--line)] bg-white" />
      </div>
      {canEdit("appearance") && <PlaylistAppearance value={draft} onChange={update} allowCustomCss={canEdit("customCss")} />}
      {canEdit("customCss") && <section className="mt-5 rounded-2xl border border-[var(--line)] p-4 space-y-3">
        <h3 className="font-semibold">自定义 CSS</h3>
        <label className="block space-y-2"><span>自定义 CSS（选填，最多 6000 字节）</span><textarea aria-label="网页歌单自定义CSS" className="w-full min-h-[150px] rounded-xl bg-[var(--shade)] border border-[var(--line)] p-3 font-mono text-xs resize-y outline-none" maxLength={6000} spellCheck={false} placeholder={"h1 { color: #b47b29; }\nli { border-radius: 18px; }"} value={draft.customCss || ""} onChange={(e) => update({ customCss: e.target.value })} /></label>
        <p className="text-[11px] text-[var(--ink-3)] leading-relaxed">可修改：body 背景、h1 标题、li 歌曲卡片、strong 歌名、small 歌手、.number 序号、.cover 封面占位。支持 @keyframes 动效；不支持外部资源、导入、脚本及 HTML 标签。覆盖单曲颜色请用 !important。</p>
        {!cssValid && <p role="alert" className="text-red-500 text-xs">CSS 超出 6000 字节或包含不支持的内容，请精简并移除外部资源、导入、反斜杠或 HTML 标签后再生成。</p>}
      </section>}
      {canEdit("tracks") && <section className="mt-5 rounded-2xl border border-[var(--line)] p-3 space-y-3">
        <div className="flex flex-wrap gap-3 items-center justify-between"><div><h3 className="font-semibold">歌曲顺序与颜色</h3><p className="text-[11px] text-[var(--ink-3)] mt-1">默认沿用歌单顺序；仅调整网页展示，不修改原歌单。</p></div><span className="text-xs text-[var(--ink-3)]">已选 {selected.size} 首</span></div>
        <div className="flex flex-wrap gap-3 items-center">
          <label className="flex items-center gap-2"><input type="checkbox" aria-label="全选歌曲" checked={draft.tracks.length > 0 && selected.size === draft.tracks.length} onChange={(e) => setSelected(new Set(e.target.checked ? draft.tracks.map((_, i) => i) : []))} />全选</label>
          <label className="flex items-center gap-2">批量颜色<input aria-label="批量歌曲颜色" type="color" className="w-10 h-8 cursor-pointer" value={selectionColor} onChange={(e) => setSelectionColor(e.target.value)} /></label>
          <button className="btn-secondary" disabled={!selected.size} onClick={() => update({ tracks: draft.tracks.map((t, i) => selected.has(i) ? { ...t, color: selectionColor } : t) })}>应用到所选</button>
          <span className="text-[11px] text-[var(--ink-3)]">全选后应用即可统一颜色。</span>
        </div>
        <div className="max-h-[240px] overflow-y-auto space-y-1 pr-1">
          {draft.tracks.map((track, index) => <div key={index} className="flex items-center gap-2 rounded-xl bg-[var(--shade)] p-2 min-w-0">
            <input type="checkbox" aria-label={`选择第 ${index + 1} 首`} checked={selected.has(index)} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(index); else next.delete(index); return next; })} />
            <span className="w-6 shrink-0 text-[11px] text-[var(--ink-3)]">{index + 1}</span>
            <div className="min-w-0 flex-1"><span className="block truncate" style={{ color: track.color }}>{track.title || "未命名歌曲"}</span><span className="block truncate text-[11px] text-[var(--ink-3)]">{track.artist || "未知歌手"}</span></div>
            <input type="color" aria-label={`第 ${index + 1} 首歌曲颜色`} className="w-8 h-8 shrink-0 cursor-pointer" value={track.color || "#282c29"} onChange={(e) => update({ tracks: draft.tracks.map((t, i) => i === index ? { ...t, color: e.target.value } : t) })} />
            <button className="btn-secondary !px-2" aria-label={`上移第 ${index + 1} 首`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button className="btn-secondary !px-2" aria-label={`下移第 ${index + 1} 首`} disabled={index === draft.tracks.length - 1} onClick={() => move(index, 1)}>↓</button>
          </div>)}
        </div>
      </section>}
      {!account && <UserAccountSettings compact className="mt-5 rounded-2xl border border-[var(--line)] p-4" />}
      {message && <p role="status" className="mt-4 break-words text-[var(--ink-2)]">{message}</p>}
      {url && <div className="mt-4 flex flex-wrap items-center gap-2"><input readOnly aria-label="歌单网页链接" className={`${inputClass} !w-auto flex-1 min-w-[160px]`} value={url} /><button className="btn-secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => setMessage("链接已复制")).catch(() => setMessage("请手动复制链接"))}>复制链接</button></div>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="btn-secondary" disabled={!valid || busy} onClick={() => downloadPlaylistPage(draft, officialCss, officialStyle?.html)}>下载网页</button>
        <button className="btn-primary" disabled={!account || !valid || busy} onClick={async () => {
          setBusy(true); setMessage("");
          try { const result = await publishPlaylistPage(draft); setURL(result.url); setMessage("歌单网页已生成，可以分享给朋友。"); }
          catch (error) { setMessage(String(error instanceof Error ? error.message : error)); }
          finally { setBusy(false); }
        }}>{busy ? "正在保存…" : existing || draft.draft?.slug ? "更新原网页" : "一键生成网页"}</button>
      </div>
    </div>}
  </Modal>;
}
