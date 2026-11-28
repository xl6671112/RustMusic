import { invoke } from "@tauri-apps/api/core";
import { initial, loadLyricsSettings, styleFields, styleKey, type Config } from "./obsLyricsPresets";

export type LyricsTemplate = { id: string; name: string; settings: Config };
const origin = "https://music.xn--hlr32k.com";
export const maxTemplateBytes = 32 * 1024 * 1024;
const fontId = /^[a-f0-9]{64}\.(ttf|otf|woff2?)$/;
const imageId = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function templateSnapshot(draft: Config): Config {
  // Save the active values before loading: styleSettings otherwise wins over the visible draft.
  const settings = structuredClone(draft);
  delete settings.localStyleId;
  if (settings.preset === "custom-html") { settings.preset = "classic"; settings.customHtmlEnabled = true; }
  settings.styleSettings = { [styleKey(settings)]: Object.fromEntries(styleFields.map(key => [key, settings[key]])) };
  if (!settings.preset.startsWith("folia-")) {
    delete settings.foliaTunings; delete settings.foliaTuningEnabled; delete settings.foliaAppearance; delete settings.foliaAssets;
  }
  if (settings.preset !== "jizura") delete settings.jizura;
  return loadLyricsSettings(settings);
}

function references(settings: Config) {
  const files = new Map<string, "font" | "image">();
  const font = (id: unknown) => {
    if (id === undefined || id === "") return;
    if (typeof id !== "string" || !fontId.test(id)) throw new Error("模板字体引用无效");
    files.set(id, "font");
  };
  font(settings.fontFile);
  for (const values of Object.values(settings.styleSettings ?? {})) font(values.fontFile);
  for (const value of Object.values(settings.jizura?.fontFiles ?? {})) font(value);
  font(settings.foliaAppearance?.fontFile); font(settings.foliaAppearance?.subtitleFontFile);
  for (const entries of Object.values(settings.foliaAssets ?? {})) {
    if (!Array.isArray(entries)) throw new Error("模板图片分组无效");
    for (const entry of entries) {
      if (!object(entry) || typeof entry.file !== "string" || !imageId.test(entry.file)) throw new Error("模板图片引用无效");
      files.set(entry.file, "image");
    }
  }
  return files;
}

export async function readLyricsTemplates(): Promise<LyricsTemplate[]> {
  const value: unknown = JSON.parse(await invoke<string>("get_obs_lyrics_templates"));
  if (!Array.isArray(value)) throw new Error("已保存模板格式无效");
  return value;
}
export async function writeLyricsTemplates(templates: LyricsTemplate[]) {
  await invoke("set_obs_lyrics_templates", { templates: JSON.stringify(templates) });
}
let pendingMutation: Promise<unknown> = Promise.resolve();
export function updateLyricsTemplates(update: (templates: LyricsTemplate[]) => LyricsTemplate[]): Promise<LyricsTemplate[]> {
  const action = async () => {
    const next = update(await readLyricsTemplates());
    await writeLyricsTemplates(next);
    window.dispatchEvent(new Event("obs-lyrics-templates-changed"));
    return next;
  };
  const result = pendingMutation.then(action, action);
  pendingMutation = result.catch(() => {});
  return result;
}

export async function exportLyricsTemplate(template: LyricsTemplate): Promise<Blob> {
  const settings = templateSnapshot(template.settings);
  // Audio analysis and track identity belong to the local song, not a shared visual style.
  if (settings.jizura) {
    delete settings.jizura.analysis; delete settings.jizura.sourceTrackKey; delete settings.jizura.lineEffectsTrackKey;
    if (settings.jizura.project) {
      const visualFields = "version timingOrder themeId style mood extra wa horror typo kinetic extra2 lang keyBg unify typeset centerDir centerFree seed aspect res fps fx enabled timing locks colors fonts userFonts".split(" ");
      settings.jizura.project = Object.fromEntries(Object.entries(settings.jizura.project).filter(([key]) => visualFields.includes(key)));
      settings.jizura.project.overrides = {};
    }
  }
  await invoke("validate_obs_lyrics_template", { settings });
  const files: Record<string, string> = {};
  let size = new TextEncoder().encode(JSON.stringify(settings)).length;
  for (const [id, kind] of references(settings)) {
    const response = await fetch(`http://127.0.0.1:17842/${kind === "font" ? "fonts" : "folia-images"}/${id}`);
    if (!response.ok) throw new Error("找不到模板引用的字体或图片，请重新导入素材");
    const bytes = new Uint8Array(await response.arrayBuffer());
    size += Math.ceil(bytes.length / 3) * 4;
    if (size > maxTemplateBytes) throw new Error("分享模板最大 32 MB");
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
    files[id] = btoa(parts.join(""));
  }
  const blob = new Blob([JSON.stringify({ format: "rustmusic-lyrics-template", version: 1, name: template.name, settings, files })], { type: "application/json" });
  if (blob.size > maxTemplateBytes) throw new Error("分享模板最大 32 MB");
  return blob;
}

export async function importLyricsTemplate(blob: Blob): Promise<LyricsTemplate> {
  if (blob.size > maxTemplateBytes) throw new Error("分享模板最大 32 MB");
  const p: unknown = JSON.parse(await blob.text());
  if (!object(p) || p.format !== "rustmusic-lyrics-template" || p.version !== 1 ||
      typeof p.name !== "string" || !p.name.trim() || [...p.name].length > 80 || !object(p.settings) || !object(p.files)) {
    throw new Error("歌词模板格式或版本无效");
  }
  // Copy only known OBS settings; imported links cannot carry application/account settings.
  const keys = [...Object.keys(initial), "styleSettings", "officialCss", "officialStyleId", "officialStyleVersion", "htmlTuningEnabled",
    "jizura", "foliaTunings", "foliaTuningEnabled", "foliaAppearance", "foliaAssets"];
  const rawSettings = p.settings;
  const settings = loadLyricsSettings(Object.fromEntries(keys.filter(key => key in rawSettings).map(key => [key, rawSettings[key]])));
  await invoke("validate_obs_lyrics_template", { settings });
  const refs = references(settings);
  for (const [id, kind] of refs) {
    const data = p.files[id];
    if (typeof data !== "string" || !data || data.length > Math.ceil((kind === "font" ? 20 : 8) * 1024 * 1024 / 3) * 4) throw new Error("模板素材缺失或过大");
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== id.slice(0, 64)) throw new Error("模板素材校验失败");
  }
  for (const [id, kind] of refs) {
    const data = p.files[id];
    const stored = kind === "font" ? (await invoke<{ fontFile: string }>("import_obs_lyrics_font", { name: id, data })).fontFile
      : await invoke<string>("import_folia_image", { data });
    if (stored !== id) throw new Error("模板素材类型无效");
  }
  return { id: crypto.randomUUID(), name: p.name.trim(), settings };
}

export function templateLinkId(link: string): string {
  const url = new URL(link.trim());
  const match = /^\/(?:lyrics-template|api\/lyrics-templates)\/([a-f0-9]{64})$/.exec(url.pathname);
  if (url.origin !== origin || url.search || url.hash || !match) throw new Error("请粘贴有效的 RustMusic 歌词模板分享链接");
  return match[1];
}
async function responseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  throw new Error(body?.error || `模板服务返回 ${response.status}`);
}
export async function shareLyricsTemplate(template: LyricsTemplate) {
  const body = await exportLyricsTemplate(template);
  const response = await fetch(`${origin}/api/lyrics-templates`, { method: "POST", body, signal: AbortSignal.timeout(120000) });
  if (!response.ok) return responseError(response);
  const result = await response.json();
  if (typeof result.url !== "string") throw new Error("模板服务返回信息不完整");
  templateLinkId(result.url);
  return result.url as string;
}
export async function importLyricsTemplateLink(link: string) {
  const id = templateLinkId(link);
  const response = await fetch(`${origin}/api/lyrics-templates/${id}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) return responseError(response);
  if (Number(response.headers.get("Content-Length")) > maxTemplateBytes) throw new Error("分享模板最大 32 MB");
  const reader = response.body!.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxTemplateBytes) throw new Error("分享模板最大 32 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return importLyricsTemplate(new Blob(chunks));
}
