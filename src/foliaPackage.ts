import { invoke } from "@tauri-apps/api/core";
import { presets, type Config } from "./obsLyricsPresets";

const format = "rustmusic-folia-preset";
export const maxFoliaPackageBytes = 32 * 1024 * 1024;
const fontId = /^[a-f0-9]{64}\.(ttf|otf|woff2?)$/;
const imageId = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const validMode = (mode: string) => presets.some(([key]) => key === `folia-${mode}`);

function references(appearance: Record<string, unknown>, assets: Record<string, unknown>) {
  const files = new Map<string, "font" | "image">();
  for (const field of ["fontFile", "subtitleFontFile"]) {
    const id = appearance[field];
    if (id === undefined) continue;
    if (typeof id !== "string" || !fontId.test(id)) throw new Error("Folia 字体引用无效");
    files.set(id, "font");
  }
  for (const [slot, entries] of Object.entries(assets)) {
    if (!["monet", "emoji", "avatar", "tempera"].includes(slot) || !Array.isArray(entries) || entries.length > 30) {
      throw new Error("Folia 图片分组无效");
    }
    for (const entry of entries) {
      if (!object(entry) || typeof entry.file !== "string" || !imageId.test(entry.file) ||
          typeof entry.id !== "string" || !entry.id || entry.id.length > 120 ||
          typeof entry.name !== "string" || entry.name.length > 120) throw new Error("Folia 图片引用无效");
      files.set(entry.file, "image");
    }
  }
  return files;
}

export async function exportFoliaPackage(draft: Config, mode: string, tuning: Record<string, unknown>, enabled: boolean) {
  const appearance = draft.foliaAppearance ?? {};
  const assets = draft.foliaAssets ?? {};
  const files: Record<string, string> = {};
  let encodedBytes = 0;
  for (const [id, kind] of references(appearance, assets)) {
    const route = kind === "font" ? "fonts" : "folia-images";
    const response = await fetch(`http://127.0.0.1:17842/${route}/${id}`);
    if (!response.ok) throw new Error(`找不到引用的 Folia 素材 ${id}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    encodedBytes += Math.ceil(bytes.length / 3) * 4;
    if (encodedBytes > maxFoliaPackageBytes) throw new Error("歌词包最大 32 MB");
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
    files[id] = btoa(chunks.join(""));
  }
  const blob = new Blob([JSON.stringify({ format, version: 2, mode, tuning, enabled, appearance, assets, files })], { type: "application/json" });
  if (blob.size > maxFoliaPackageBytes) throw new Error("歌词包最大 32 MB");
  return blob;
}

export async function importFoliaPackage(file: File, fallbackMode: string) {
  if (file.size > maxFoliaPackageBytes) throw new Error("歌词包最大 32 MB");
  const parsed: unknown = JSON.parse(await file.text());
  if (!object(parsed)) throw new Error("Folia 歌词包格式无效");
  const packaged = parsed.format === format;
  if ("format" in parsed && !packaged || packaged && parsed.version !== 1 && parsed.version !== 2) {
    throw new Error("歌词包格式或版本不受支持");
  }
  const mode = typeof parsed.mode === "string" ? parsed.mode : fallbackMode;
  const tuning = packaged || "tuning" in parsed ? parsed.tuning : parsed;
  if (!validMode(mode) || !object(tuning) || JSON.stringify(tuning).length > 120 * 1024) {
    throw new Error("Folia 效果或动画参数无效");
  }
  const appearance = packaged && object(parsed.appearance) ? parsed.appearance : undefined;
  if (parsed.version !== 2 || !packaged) return { mode, tuning, appearance, assets: undefined, enabled: true };
  if (!appearance || !object(parsed.assets) || !object(parsed.files) || typeof parsed.enabled !== "boolean") {
    throw new Error("Folia 歌词包缺少设置或素材");
  }
  const refs = references(appearance, parsed.assets);
  for (const [id, kind] of refs) {
    const data = parsed.files[id];
    const limit = kind === "font" ? 20 : 8;
    if (typeof data !== "string" || !data || data.length > Math.ceil(limit * 1024 * 1024 / 3) * 4) {
      throw new Error(`素材缺失或超出 ${limit} MB`);
    }
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== id.slice(0, 64)) throw new Error("Folia 素材校验失败");
  }
  for (const [id, kind] of refs) {
    const data = parsed.files[id];
    const stored = kind === "font"
      ? (await invoke<{fontFile: string}>("import_obs_lyrics_font", { name: id, data })).fontFile
      : await invoke<string>("import_folia_image", { data });
    if (stored !== id) throw new Error("Folia 素材格式与包中声明不符");
  }
  return { mode, tuning, appearance, assets: parsed.assets, enabled: parsed.enabled };
}
