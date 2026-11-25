import { useState } from "react";
import type { PlaylistPageOptions } from "../playlistPages";
import { playlistLooks, playlistMotionCSS, validPlaylistBackground } from "../playlistAppearance";
export default function PlaylistAppearance({ value, onChange, allowCustomCss = true }: { value: PlaylistPageOptions; onChange: (v: Partial<PlaylistPageOptions>) => void; allowCustomCss?: boolean }) {
  const [status, setStatus] = useState("");
  const css = value.customCss || "";
  const size = Number(css.match(/--song-size:(\d+)px/)?.[1] || 16);
  const speed = Number(css.match(/--motion:(\d+)s/)?.[1] || 10);
  function adjust(name: string, v: string) {
    const without = css.replace(new RegExp(`:root\\{--${name}:[^}]*\\}`, "g"), "");
    onChange({ customCss: without + `\n:root{--${name}:${v};}` + (name === "song-size" && !without.includes("font-size:var(--song-size") ? "strong{font-size:var(--song-size,16px)}" : "") });
  }
  async function importFont(file?: File) {
    if (!file) return;
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!["ttf", "otf", "woff", "woff2"].includes(ext || "") || !file.size || file.size > 1048576) throw new Error("请选择不超过 1 MB 的 TTF / OTF / WOFF / WOFF2 字体");
      const buffer = await file.arrayBuffer();
      await new FontFace("PlaylistCheck", buffer).load();
      const bytes = new Uint8Array(buffer), parts = [];
      for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      onChange({ fontData: `data:font/${ext};base64,${btoa(parts.join(""))}`, fontName: file.name });
      setStatus("字体已导入，预览、下载及发布网页都会保留");
    } catch (e) { setStatus(String(e)); }
  }
  return <section className="mt-5 rounded-2xl border border-[var(--line)] p-4 space-y-3 min-w-0">
    <h3 className="font-semibold">灵动外观与字体</h3>
    <div className="flex flex-wrap gap-4">
      <label className="flex items-center gap-2"><input aria-label="歌曲卡片无边框" type="checkbox" checked={!!value.cardBorderless} onChange={e => onChange({cardBorderless:e.target.checked})} />歌曲卡片无边框</label>
      <label className="flex items-center gap-2"><input aria-label="歌曲卡片无底色" type="checkbox" checked={!!value.cardTransparent} onChange={e => onChange({cardTransparent:e.target.checked})} />歌曲卡片无底色</label>
    </div>
    <p className="text-xs text-[var(--ink-3)]">只移除歌曲卡片的边框或底色，网页背景保持不变；无边框时同时隐藏边框辉光。</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <label className="text-xs min-w-0">字间距 · {value.letterSpacing ?? 0}px<input aria-label="歌单字间距" className="mt-2 w-full" type="range" min={0} max={20} step={0.5} value={value.letterSpacing ?? 0} onChange={e => onChange({letterSpacing:Number(e.target.value)})} /></label>
      <label className="text-xs min-w-0">行间距 · {value.lineHeight ?? 1.7} 倍<input aria-label="歌单行间距" className="mt-2 w-full" type="range" min={1} max={3} step={0.1} value={value.lineHeight ?? 1.7} onChange={e => onChange({lineHeight:Number(e.target.value)})} /></label>
      <label className="text-xs min-w-0">边框宽度 · {value.borderWidth ?? 1}px<input aria-label="歌曲卡片边框宽度" className="mt-2 w-full disabled:opacity-40" type="range" min={0} max={12} step={0.5} disabled={!!value.cardBorderless} value={value.borderWidth ?? 1} onChange={e => onChange({borderWidth:Number(e.target.value)})} /></label>
    </div>
    <p className="text-xs text-[var(--ink-3)]">字间距与行间距用于标题、介绍和歌曲文字。启用无边框时不显示边框，关闭后恢复已设宽度；未调整时沿用模板原有间距。</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <label className="text-xs">文字动效<select aria-label="文字动效" className="mt-2 w-full h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)]" value={value.textEffect || "none"} onChange={e => onChange({ textEffect: e.target.value as PlaylistPageOptions["textEffect"] })}><option value="none">无动效</option><option value="wave">逐字波浪</option><option value="blink">缓慢闪动</option><option value="breathe">明暗呼吸</option></select></label>
      <label className="text-xs">边框发光<select aria-label="边框发光" className="mt-2 w-full h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)]" value={value.borderEffect || "none"} onChange={e => onChange({ borderEffect: e.target.value as PlaylistPageOptions["borderEffect"] })}><option value="none">关闭</option><option value="neon">荧光辉光</option><option value="breathe">呼吸辉光</option></select></label>
      <label className="text-xs flex items-center gap-2"><input aria-label="文字发光" type="checkbox" checked={!!value.textGlow} onChange={e => onChange({ textGlow: e.target.checked })} />文字发光（不改变原字色）</label>
      <label className="text-xs">发光颜色<input aria-label="发光颜色" type="color" className="block mt-2 w-full h-9" value={value.glowColor || "#8b5cf6"} onChange={e => onChange({ glowColor: e.target.value })} /></label>
      <label className="text-xs">发光强度 · {value.glowStrength ?? 60}%<input aria-label="发光强度" className="mt-2 w-full" type="range" min={0} max={100} value={value.glowStrength ?? 60} onChange={e => onChange({ glowStrength: Number(e.target.value) })} /></label>
      <label className="text-xs">发光扩散宽度 · {value.glowWidth ?? 12}px<input aria-label="发光扩散宽度" className="mt-2 w-full" type="range" min={0} max={40} value={value.glowWidth ?? 12} onChange={e => onChange({ glowWidth: Number(e.target.value) })} /></label>
      <label className="text-xs sm:col-span-2">文字与辉光周期 · {value.effectDuration || 6}秒<input aria-label="文字与辉光周期" className="mt-2 w-full" type="range" min={3} max={15} value={value.effectDuration || 6} onChange={e => onChange({ effectDuration: Number(e.target.value) })} /></label>
    </div>
    <p className="text-xs text-[var(--ink-3)]">强度 0% 关闭辉光，宽度 0px 为清晰光边。波浪用于标题和歌名；系统减少动效时保留静态辉光。</p>
    <label className="block text-xs">背景图片链接（HTTPS，留空移除）<input aria-label="背景图片链接" type="url" maxLength={2048} className="mt-2 w-full min-w-0 h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)]" placeholder="https://example.com/background.jpg" value={value.backgroundImage || ""} onChange={e => onChange({ backgroundImage: e.target.value })} /></label>
    {!validPlaylistBackground(value.backgroundImage) && <p role="alert" className="text-xs text-red-500">请填写有效的 HTTPS 图片直链，不含空格或引号。</p>}
    <p className="text-xs text-[var(--ink-3)]">请使用可公开访问的图片直链；发布后访客会从该地址加载图片，链接失效时显示背景颜色。</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <label className="text-xs">背景颜色<input aria-label="页面背景颜色" type="color" className="block mt-2 w-full h-9" value={value.background} onChange={e => onChange({ background: e.target.value })} /></label>
      <label className="text-xs">文字颜色<input aria-label="文字颜色" type="color" className="block mt-2 w-full h-9" value={value.textColor || "#282c29"} onChange={e => onChange({ textColor: e.target.value })} /></label>
      <label className="text-xs">歌曲卡片（文本框）颜色<input aria-label="歌曲卡片颜色" type="color" className="block mt-2 w-full h-9" value={value.cardColor || "#ffffff"} onChange={e => onChange({ cardColor: e.target.value })} /></label>
    </div>
    <label className="block text-xs">背景特效<select aria-label="背景特效" className="mt-2 w-full h-10 px-3 rounded-xl bg-[var(--shade)] border border-[var(--line)]" value={value.effect || "none"} onChange={e => onChange({ effect: e.target.value as PlaylistPageOptions["effect"] })}><option value="none">无特效</option><option value="sakura">樱花缓落</option><option value="meteor">流星掠过</option><option value="stars">小星星闪烁</option></select></label>
    {allowCustomCss && <>
    <p className="text-xs text-[var(--ink-3)]">参考歌词的流彩、霓虹与飞字效果；应用预设会替换下方自定义 CSS，官网风格仍可叠加。</p>
    <div className="grid grid-cols-2 gap-3">{playlistLooks.map(([name, css]) => <button type="button" className="btn-secondary min-w-0" key={name} onClick={() => onChange({ customCss: css + playlistMotionCSS })}>{name}</button>)}</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <label className="text-xs">歌名字号 · {size}px<input aria-label="歌名字号" className="mt-2 w-full" type="range" min={12} max={32} value={size} onChange={e => adjust("song-size", `${e.target.value}px`)} /></label>
      <label className="text-xs">动效周期 · {speed}秒<input aria-label="动效周期" className="mt-2 w-full" type="range" min={3} max={30} value={speed} onChange={e => adjust("motion", `${e.target.value}s`)} /></label>
    </div>
    </>}
    <label className="block text-xs">导入歌单字体（仅影响此网页）<input aria-label="导入歌单字体" type="file" accept=".ttf,.otf,.woff,.woff2" className="block mt-2 w-full min-w-0 text-xs" onChange={e => { void importFont(e.target.files?.[0]); e.target.value = ""; }} /></label>
    <p className="text-xs break-words text-[var(--ink-3)]">{value.fontName || "使用系统字体"} · 最大 1 MB，推荐 WOFF2；仅导入有权分享的字体。</p>
    <button type="button" className="btn-secondary" disabled={!value.fontData} onClick={() => onChange({ fontData: "", fontName: "" })}>恢复系统字体</button>
    {status && <p role="status" className="text-xs break-words">{status}</p>}
  </section>;
}
