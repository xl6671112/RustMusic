import effectsCSS from "./playlist_effects.css?raw";
import type { PlaylistPageOptions } from "./playlistPages";
export function validPlaylistBackground(value = "") {
  if (!value) return true;
  try { const url = new URL(value); return value.length <= 2048 && url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !/[\s"'\\<>()]/.test(value); } catch { return false; }
}
export function playlistDecorCSS(value: PlaylistPageOptions) {
  const color = (v?: string) => /^#[a-f0-9]{6}$/i.test(v || "");
  const bounded = (v: number | undefined, min: number, max: number, fallback: number) => v != null && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  const finite = (v: number | undefined, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const textSelector = "main h1,main .description,main .brand,main li strong,main li small,main li .number";
  const gap = finite(value.songGap, 0, 80) ? value.songGap! : 12;
  const alpha = Math.round(bounded(value.glowStrength, 0, 100, 60) * 255 / 100).toString(16).padStart(2, "0");
  return effectsCSS + playlistRowsCSS(value.rowCounts, gap) + (finite(value.songGap, 0, 80) ? `main ul{gap:${gap}px}` : "") + `:root{--pg-glow:${color(value.glowColor) ? value.glowColor : "#8b5cf6"}${alpha};--pg-glow-width:${bounded(value.glowWidth, 0, 40, 12)}px;--pg-fx-duration:${bounded(value.effectDuration, 3, 15, 6)}s}` + (color(value.textColor) ? `body,header p,small,.brand{color:${value.textColor}}` : "") +
    (color(value.cardColor) ? `li{background:${value.cardColor}}` : "") +
    (finite(value.letterSpacing, 0, 20) ? `${textSelector}{letter-spacing:${value.letterSpacing}px}` : "") +
    (finite(value.lineHeight, 1, 3) ? `${textSelector}{line-height:${value.lineHeight}}` : "") +
    (finite(value.borderWidth, 0, 12) ? `main li{border-width:${value.borderWidth}px}` : "") +
    (value.backgroundImage && validPlaylistBackground(value.backgroundImage) ? `body:before{background-image:url("${value.backgroundImage}");background-size:cover;background-position:center}` : "") +
    (value.cardTransparent ? "main li{background:transparent!important;backdrop-filter:none!important;box-shadow:none!important}" : "") +
    (value.cardBorderless ? "main li{border-width:0!important;border-color:transparent!important;box-shadow:none!important}main li:after{display:none!important}" : "") +
    (value.autoColumns ? `main{max-width:1280px}main ul{display:flex;flex-wrap:wrap;justify-content:space-between;gap:${gap}px}main ul>li:nth-child(n):nth-child(n){flex:0 0 auto;width:max-content;max-width:100%;min-width:0}main ul>li .info{flex:0 1 auto;max-width:100%;min-width:0;overflow:hidden}main ul>li strong,main ul>li small{flex:0 1 auto;max-width:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` : "");
}
export function playlistRowsCSS(counts?: number[], gap = 12) {
  if (!counts?.length || counts.length > 200 || counts.some(n => !Number.isInteger(n) || n < 1 || n > 12)) return "";
  const width = (n: number) => `calc((100% - ${(n - 1) * gap}px) / ${n})`;
  let start = 1;
  const rules = counts.map(n => {
    const rule = `main ul>li:nth-child(n+${start}):nth-child(-n+${start + n - 1}){flex-basis:${width(n)}}`;
    start += n;
    return rule;
  }).join("");
  return `main{max-width:${Math.max(960, Math.max(...counts) * 280)}px}main ul{display:flex;flex-wrap:wrap;gap:${gap}px}main ul>li{flex:0 0 ${width(counts[counts.length - 1])}}${rules}@media(max-width:800px){main ul>li:nth-child(n):nth-child(n){flex-basis:calc((100% - ${gap}px) / 2)}}@media(max-width:520px){main ul>li:nth-child(n):nth-child(n){flex-basis:100%}}`;
}
export function playlistAnimatedText(value: string, mode = "none") {
  const escape = (v: string) => v.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
  return mode === "wave" ? [...value].map((c,i) => `<span class="pg-letter" style="--letter:${i}">${escape(c)}</span>`).join("") : escape(value);
}
export function playlistEffectsHTML(effect = "none") {
  return ["sakura", "meteor", "stars"].includes(effect) ? `<div class="pg-effects pg-${effect}" aria-hidden="true">${Array.from({length:16}, (_, i) => `<i style="--i:${i};top:${i * 17 % 95}%"></i>`).join("")}</div>` : "";
}
export const playlistLooks = [
  ["明亮玻璃", "li{background:#ffffffb8;box-shadow:0 12px 35px #5d6f5d18}"],
  ["极光流彩", "body:before{background:linear-gradient(125deg,#c8f7e6aa,#e9d5ff99,#ffdfb099);background-size:240% 240%;animation:pg-flow var(--motion,10s) ease infinite}h1{color:#6952a2}li{border-color:#ffffffcc}"],
  ["霓虹应援", "body{color:#edecff}body:before{background:linear-gradient(125deg,#16152e,#2c2045,#153640);background-size:240% 240%;animation:pg-flow var(--motion,10s) ease infinite}h1{color:#bffaff;text-shadow:0 0 20px #50d8e988}li{background:#181c3cd9;border-color:#92e9ff55;box-shadow:0 0 18px #bf83ff22}small,header p{color:#c5bddf}"],
  ["樱花飞字", "body:before{background:radial-gradient(ellipse at 20% 20%,#ffd9edbb,transparent 65%),linear-gradient(120deg,#fff1f8,#eee9ff)}.brand:after{content:' ✿ · ✧ · ✿';display:inline-block;color:#da84b5;animation:pg-petal var(--motion,10s) ease-in-out infinite}h1{color:#b35b8c}li{animation:pg-enter .7s both;animation-delay:.1s}"],
] as const;
export const playlistMotionCSS = "@keyframes pg-flow{50%{background-position:100% 100%}}@keyframes pg-petal{50%{transform:translate(25px,20px) rotate(35deg);opacity:.4}}@keyframes pg-enter{from{opacity:0;transform:translateY(20px) rotate(-2deg);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}li{transition:transform .3s,box-shadow .3s}li:hover{transform:translateY(-4px);box-shadow:0 18px 38px #77777725}strong{font-size:var(--song-size,16px)}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}";
export function playlistFontCSS(data = "") {
  return /^data:font\/(?:ttf|otf|woff2?);base64,[A-Za-z0-9+/=]+$/.test(data) && data.length <= 1400000
    ? `@font-face{font-family:PlaylistImported;src:url("${data}");font-display:swap}body{font-family:PlaylistImported,"Microsoft YaHei",sans-serif}` : "";
}
export function playlistLayoutCSS(value = 1) {
  const columns = Number.isInteger(value) && value >= 1 && value <= 12 ? value : 1;
  return `main{max-width:${Math.max(960, columns * 280)}px}ul{grid-template-columns:repeat(${columns},minmax(0,1fr))}@media(max-width:1200px){ul{grid-template-columns:repeat(${Math.min(columns, 3)},minmax(0,1fr))}}@media(max-width:800px){ul{grid-template-columns:repeat(${Math.min(columns, 2)},minmax(0,1fr))}}@media(max-width:520px){ul{grid-template-columns:1fr}}`;
}
