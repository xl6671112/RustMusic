import { playlistFontCSS, playlistLayoutCSS, playlistDecorCSS, playlistEffectsHTML, playlistAnimatedText } from "./playlistAppearance";
import type { Playlist, TrackMeta } from "./types";
import { accountRequest, currentAccount, subscribeAccount } from "./userAccount";
import { applyPlaylistTemplate, playlistEditableGroups, validPlaylistTemplate, type PlaylistEditableGroup } from "./playlistTemplates";

export type PlaylistPageTrack = { title: string; artist: string; cover: string; color?: string };
export type PlaylistPageInput = { sourceKey?: string; draft?: PlaylistPageOptions; title: string; tracks: PlaylistPageTrack[] };
export type PlaylistPageOptions = PlaylistPageInput & {
  cardBorderless?: boolean; cardTransparent?: boolean;
  letterSpacing?: number; lineHeight?: number; borderWidth?: number;
  songGap?: number; autoColumns?: boolean;
  textEffect?: "none" | "wave" | "blink" | "breathe"; textGlow?: boolean;
  borderEffect?: "none" | "neon" | "breathe"; glowColor?: string;
  glowStrength?: number; glowWidth?: number; effectDuration?: number;
  pageTitle?: string; description?: string; columns?: number; rowCounts?: number[];
  backgroundImage?: string; textColor?: string; cardColor?: string; effect?: "none" | "sakura" | "meteor" | "stars";
  fontData?: string; fontName?: string; slug: string; showArtist: boolean; showCover: boolean; background: string;
  animation: "none" | "fade" | "float"; alignChars: number; customCss?: string; styleId?: string;
};
export type SavedPlaylistPage = { id: string; slug: string; url: string; editToken: string; title: string; created: number; sourceKey?: string };
const event = "playlist-page-editor";
const changed = "playlist-pages-changed";
const key = "rustmusic-playlist-pages";
function storageKey() { return currentAccount() ? `${key}:${currentAccount()!.id}` : key; }

export function openPlaylistPageEditor(input: PlaylistPageInput) {
  if (!input.sourceKey) {
    const identity = JSON.stringify([input.title, input.tracks.map(t => [t.title,t.artist]).sort()]);
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)).then(hash => openPlaylistPageEditor({...input,sourceKey:"collection:"+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("")}));
    return;
  }
  window.dispatchEvent(new CustomEvent(event, { detail: input }));
}
export function subscribePlaylistEditor(listener: (input: PlaylistPageInput) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<PlaylistPageInput>).detail);
  window.addEventListener(event, handler);
  return () => window.removeEventListener(event, handler);
}
export function playlistPageInput(playlist: Playlist, tracks: TrackMeta[]): PlaylistPageInput {
  const byID = new Map(tracks.map((track) => [track.id, track]));
  const seen = new Set<number>();
  const rows: PlaylistPageTrack[] = [];
  for (const entry of playlist.entries ?? []) {
    if (entry.kind === "local" && entry.trackId != null) {
      seen.add(entry.trackId);
      const track = byID.get(entry.trackId);
      rows.push(track ? { title: track.title, artist: track.artist, cover: track.cover } : entry);
    } else rows.push(entry);
  }
  for (const id of playlist.trackIds) {
    const track = byID.get(id);
    if (track && !seen.has(id)) rows.push({ title: track.title, artist: track.artist, cover: track.cover });
  }
  return { sourceKey: localPlaylistSource(playlist.id), title: playlist.name, tracks: rows.map(({ title, artist, cover }) => ({ title, artist, cover })) };
}
export function localPlaylistSource(id: number) {
  let instance = localStorage.getItem("rustmusic-playlist-instance");
  if (!instance) { instance = crypto.randomUUID(); localStorage.setItem("rustmusic-playlist-instance", instance); }
  return `local:${instance}:${id}`;
}
export function readPlaylistPages(): SavedPlaylistPage[] {
  try { return JSON.parse(localStorage.getItem(storageKey()) ?? "[]"); } catch { return []; }
}
function savePages(pages: SavedPlaylistPage[]) {
  localStorage.setItem(storageKey(), JSON.stringify(pages));
  window.dispatchEvent(new Event(changed));
}
export async function syncAccountPages() {
  const user = currentAccount();
  if (!user) return;
  const { pages } = await accountRequest<{ pages: SavedPlaylistPage[] }>("pages");
  if (currentAccount()?.id === user.id) savePages(pages);
}
export async function importLocalPages() {
  if (!currentAccount()) throw new Error("请先登录帐号");
  const legacy = JSON.parse(localStorage.getItem(key) ?? "[]") as SavedPlaylistPage[];
  await accountRequest("pages-import", { pages: legacy.map(({ slug, editToken }) => ({ slug, editToken })) });
  // Retain local recovery data; the server verifies ownership and rejects another owner's page.
  await syncAccountPages();
}
export function subscribePlaylistPages(listener: () => void) {
  window.addEventListener(changed, listener);
  const off = subscribeAccount(() => { listener(); void syncAccountPages().catch(e => window.dispatchEvent(new CustomEvent("playlist-pages-error", { detail: String(e) }))); });
  void syncAccountPages().catch(e => window.dispatchEvent(new CustomEvent("playlist-pages-error", { detail: String(e) })));
  return () => { window.removeEventListener(changed, listener); off(); };
}
export async function publishPlaylistPage(options: PlaylistPageOptions): Promise<SavedPlaylistPage> {
  if (!currentAccount()) throw new Error("请先登录帐号，再保存网页歌单");
  const owner = currentAccount()!.id;
  const value = await accountRequest<SavedPlaylistPage>("playlist-publish", (({draft, ...body}) => body)(options));
  if (currentAccount()?.id !== owner) throw new Error("帐号已切换，请刷新网页歌单");
  if (!value.slug || !value.url || !value.editToken) throw new Error("歌单网页返回信息不完整");
  const saved = { ...value, sourceKey: options.sourceKey, title: options.title, created: Date.now() };
  savePages([saved, ...readPlaylistPages().filter((page) => page.slug !== saved.slug)]);
  return saved;
}
export async function deletePlaylistPage(page: SavedPlaylistPage) {
  const owner = currentAccount()?.id;
  await accountRequest("playlist-delete", { slug: page.slug, editToken: page.editToken });
  if (currentAccount()?.id === owner) savePages(readPlaylistPages().filter((item) => item.slug !== page.slug));
}
export type PlaylistStylePack = { version: string; styles: { id: string; name: string; css: string; html?: string; editable?: PlaylistEditableGroup[] | null }[] };
export function validPlaylistCSS(css: string): boolean {
  return new TextEncoder().encode(css).length <= 6000 && !/[\\<>]|url|@import|expression|image-set/i.test(css);
}
export async function fetchPlaylistStyles(): Promise<PlaylistStylePack> {
  const response = await fetch("https://music.xn--hlr32k.com/api/playlist-styles", { cache: "no-store" });
  if (!response.ok) throw new Error("网页歌单风格暂时无法获取，请稍后刷新");
  const pack = await response.json() as PlaylistStylePack;
  const ids = new Set<string>();
  if (!pack || typeof pack.version !== "string" || !Array.isArray(pack.styles) || pack.styles.length > 30) throw new Error("网页歌单风格格式无效");
  for (const style of pack.styles) {
    if (!style || typeof style.id !== "string" || !/^[a-z0-9-]{1,48}$/.test(style.id) || ids.has(style.id) ||
      typeof style.name !== "string" || !style.name || typeof style.css !== "string" || !validPlaylistCSS(style.css) ||
      (style.html !== undefined && (typeof style.html !== "string" || !validPlaylistTemplate(style.html))) ||
      (style.editable != null && (!Array.isArray(style.editable) || new Set(style.editable).size !== style.editable.length || style.editable.some(field => !playlistEditableGroups.includes(field))))) throw new Error("网页歌单风格格式无效");
    ids.add(style.id);
  }
  return pack;
}
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function playlistPageHTML(options: PlaylistPageOptions, officialCss = "", fragment = ""): string {
  const css = [officialCss, options.customCss ?? ""].filter(validPlaylistCSS).join("\n");
  const background = /^#[a-f0-9]{6}$/i.test(options.background) ? options.background : "#fbfaf6";
  const animation = options.animation === "float" ? "float 5s ease-in-out infinite" : options.animation === "fade" ? "fade .6s both" : "none";
  const align = Number.isInteger(options.alignChars) && options.alignChars > 0 && options.alignChars <= 40 ? `${options.alignChars}em` : "auto";
  const rows = options.tracks.map((track, index) => {
    const cover = /^https:\/\//i.test(track.cover) ? `<img src="${escape(track.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="cover">♪</span>`;
    return `<li style="animation-delay:${index % 12 * 60}ms"><span class="number">${String(index + 1).padStart(2, "0")}</span>${options.showCover ? cover : ""}<div class="info"><strong style="color:${/^#[a-f0-9]{6}$/i.test(track.color ?? "") ? track.color : "inherit"}">${playlistAnimatedText(track.title || "未命名歌曲", options.textEffect)}</strong>${options.showArtist ? `<small>${escape(track.artist || "未知歌手")}</small>` : ""}</div></li>`;
  }).join("");
  const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.pageTitle?.trim() || options.title)}</title><style>*{box-sizing:border-box}body{margin:0;background:${background};color:#282c29;font:16px/1.7 "Microsoft YaHei",system-ui,sans-serif}body:before{content:"";position:fixed;inset:0;background:radial-gradient(ellipse at 90% 5%,#ffdda466,transparent 55%),radial-gradient(ellipse at 5% 80%,#ddeddf88,transparent 55%);pointer-events:none}main{position:relative;max-width:960px;margin:auto;padding:clamp(24px,6vw,70px) 20px}header{margin-bottom:30px}p{color:#7a8075}h1{font-size:clamp(30px,5vw,54px);line-height:1.3;overflow-wrap:anywhere}ul{list-style:none;padding:0;display:grid;gap:12px}li{display:flex;align-items:center;gap:16px;min-width:0;padding:16px;border:1px solid #ffffffd9;border-radius:22px;background:#ffffffb8;backdrop-filter:blur(15px);box-shadow:0 12px 35px #5d6f5d10;animation:${animation}}.info{display:flex;align-items:center;gap:18px;min-width:0;flex:1}strong{display:block;overflow-wrap:anywhere;min-width:0;flex:${align === "auto" ? "1" : `0 0 ${align}`};max-width:65%}small{color:#7a8075;overflow-wrap:anywhere;flex:1;min-width:0}.number{font-size:12px;color:#92978a;flex:0 0 24px}img,.cover{width:52px;height:52px;object-fit:cover;border-radius:12px;flex-shrink:0}.cover{display:grid;place-items:center;background:#fbefdf;color:#b47b29}@keyframes fade{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes float{50%{transform:translateY(-3px)}}@media(prefers-reduced-motion:reduce){li{animation:none}}@media(max-width:520px){li{padding:12px;gap:10px}img,.cover{width:42px;height:42px}.info{display:block}strong{max-width:none}small{display:block}}</style><style>${playlistLayoutCSS(options.columns)}${playlistFontCSS(options.fontData)}</style><style>${css}</style><style>${playlistDecorCSS(options)}</style><main class="${options.animation}" data-text-effect="${["wave","blink","breathe"].includes(options.textEffect || "") ? options.textEffect : "none"}" data-border-effect="${["neon","breathe"].includes(options.borderEffect || "") ? options.borderEffect : "none"}" data-text-glow="${!!options.textGlow}">${playlistEffectsHTML(options.effect)}<header><p class="brand">MY MUSIC COLLECTION · ${options.tracks.length} 首歌曲</p><h1>${playlistAnimatedText(options.title, options.textEffect)}</h1>${(options.description ?? "把喜欢的旋律，整理成一份美好的歌单。") ? `<p class="description">${escape(options.description ?? "把喜欢的旋律，整理成一份美好的歌单。")}</p>` : ""}</header><ul>${rows}</ul></main></html>`;
  return applyPlaylistTemplate(page, fragment);
}
export function downloadPlaylistPage(options: PlaylistPageOptions, officialCss = "", fragment = "") {
  const url = URL.createObjectURL(new Blob([playlistPageHTML(options, officialCss, fragment)], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = (options.slug || "playlist") + ".html"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function editPlaylistPage(page: SavedPlaylistPage) {
  const draft = await accountRequest<PlaylistPageOptions>("playlist-get", {slug:page.slug});
  openPlaylistPageEditor({...draft,draft});
}
export async function replacePlaylistPageLink(page: SavedPlaylistPage) {
  const owner = currentAccount()?.id;
  const draft = await accountRequest<PlaylistPageOptions>("playlist-get", {slug:page.slug});
  if (currentAccount()?.id !== owner) throw new Error("帐号已切换，请重试");
  await deletePlaylistPage(page);
  if (currentAccount()?.id !== owner) throw new Error("帐号已切换，请重试");
  openPlaylistPageEditor({...draft, draft:{...draft,slug:""}});
}
