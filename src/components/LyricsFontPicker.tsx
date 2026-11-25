import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { initial, type Config } from "../obsLyricsPresets";

type FontSelection = Pick<Config, "fontFile" | "fontName">;
export default function LyricsFontPicker({ value, onChange, disabled = false }: {
  value: FontSelection;
  onChange: (font: FontSelection & { font?: string }) => void | Promise<void>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function importFont(file?: File) {
    if (!file) return;
    setBusy(true);
    setStatus("正在检查并导入字体…");
    try {
      if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error("请选择 TTF、OTF、WOFF 或 WOFF2 字体");
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("字体文件须小于等于 20 MB");
      const buffer = await file.arrayBuffer();
      try { await new FontFace("RustMusicImportCheck", buffer).load(); }
      catch { throw new Error("无法读取此字体，请选择完整有效的字体文件"); }
      const bytes = new Uint8Array(buffer), parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      const font = await invoke<FontSelection>("import_obs_lyrics_font", { name: file.name, data: btoa(parts.join("")) });
      await onChange(font);
      setStatus("字体已导入");
    } catch (error) { setStatus(`导入失败：${String(error).replace(/^Error: /, "")}`); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function reset() {
    setBusy(true);
    try { await onChange({ fontFile: "", fontName: "", font: initial.font }); setStatus("已恢复默认字体"); }
    catch (error) { setStatus(`恢复失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  const button = "min-w-0 min-h-10 rounded-lg border border-[var(--line)] bg-[var(--shade)] px-3 py-2 text-[12px] leading-5 text-[var(--ink)] disabled:opacity-50";
  return <div className="min-w-0" aria-label="歌词字体">
    <div className="text-[12px] font-medium text-[var(--ink-2)]">导入歌词字体</div>
    <p className="mt-1 break-words text-[11px] leading-5 text-[var(--ink-3)]">{value.fontFile ? `当前导入：${value.fontName || "自定义字体"}` : "当前使用系统字体"} · 不影响其他界面</p>
    <input ref={input} type="file" accept=".ttf,.otf,.woff,.woff2" aria-label="选择歌词字体文件" className="hidden" disabled={disabled || busy} onChange={event => void importFont(event.target.files?.[0])} />
    <div className="mt-2 grid grid-cols-2 gap-3">
      <button type="button" className={button} disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? "处理中…" : "导入字体"}</button>
      <button type="button" className={button} disabled={disabled || busy || !value.fontFile} onClick={() => void reset()}>恢复默认字体</button>
    </div>
    <p className="mt-2 text-[10px] leading-5 text-[var(--ink-3)]">支持 TTF / OTF / WOFF / WOFF2，最大 20 MB。导入后可在本播放器对应的歌词设置中单独选择；缺少的字自动使用系统字体。</p>
    {status && <p role="status" className="mt-1 break-words text-[11px] leading-5 text-[var(--ink-3)]">{status}</p>}
  </div>;
}
