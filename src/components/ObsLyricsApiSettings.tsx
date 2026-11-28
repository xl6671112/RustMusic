import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpen, Copy, RotateCcw } from "lucide-react";

type ApiInfo = { url: string; apiKey: string; enabled: boolean; error?: string };
export default function ObsLyricsApiSettings() {
  const [info, setInfo] = useState<ApiInfo | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  useEffect(() => { void invoke<ApiInfo>("get_obs_lyrics_api").then(setInfo).catch(error => setStatus(String(error))); }, []);
  const button = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--shade)] px-2.5 py-1.5 text-[12px] text-[var(--ink)] disabled:opacity-40";
  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setStatus(message); }
    catch (error) { setStatus(`复制失败：${String(error)}`); }
  }
  async function change(action: "toggle" | "rotate") {
    if (!info) return;
    setBusy(true);
    try {
      const next = await invoke<ApiInfo>(action === "toggle" ? "set_obs_lyrics_api_enabled" : "rotate_obs_lyrics_api_key", action === "toggle" ? { enabled: !info.enabled } : undefined);
      setInfo(next); setStatus(action === "rotate" ? "密钥已更换，旧密钥立即失效" : next.enabled ? "本机 AI 控制已开启" : "本机 AI 控制已关闭");
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }
  return <details className="mt-4 min-w-0 border-t border-[var(--line)] pt-3" data-obs-lyrics-api>
    <summary className="cursor-pointer text-[12px] font-medium text-[var(--ink-2)]">本机 AI 控制</summary>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <label className="inline-flex items-center gap-2 text-[12px] text-[var(--ink)]"><input type="checkbox" aria-label="启用本机 AI 歌词控制" className="accent-[var(--accent)]" checked={info?.enabled ?? false} disabled={busy || !info} onChange={() => void change("toggle")}/>启用本机 AI 歌词控制</label>
      <button type="button" className={button} title="更换 API 密钥" disabled={busy || !info} onClick={() => void change("rotate")}><RotateCcw size={14}/>更换密钥</button>
    </div>
    {info && <>
      <code className="mt-3 block break-all text-[11px] text-[var(--ink-3)]">{info.url}</code>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!!info.error} onClick={() => void copy(info.url, "API 地址已复制")}><Copy size={14}/>复制 API</button>
        <button type="button" className={button} disabled={!!info.error} onClick={() => void copy(info.apiKey, "API Key 已复制")}><Copy size={14}/>复制 API Key</button>
        <button type="button" className={button} disabled={!info.enabled || !!info.error} onClick={() => void copy(`请使用本机 RustMusic 歌词 API，按我的要求调整 OBS 歌词（包括普通 HTML、Folia 和 JIZURA）与模板。\nAPI 与文档首页：${info.url}\nOpenAPI：${info.url}/openapi.json\nAPI Key：${info.apiKey}\n请求头：Authorization: Bearer ${info.apiKey}\n请先读取文档和 GET /settings，再按需要 PATCH /settings；修改后重新读取核实结果。`, "API、密钥和说明已一起复制，可发送给本机 AI 工具")}><Copy size={14}/>复制给 AI</button>
        <button type="button" className={button} disabled={!!info.error} onClick={() => void invoke("open_url", { url: info.url }).catch(error => setStatus(`打开文档失败：${String(error)}`))}><BookOpen size={14}/>API 文档</button>
      </div>
    </>}
    {(info?.error || status) && <p className="mt-2 break-words text-[11px] leading-5 text-[var(--ink-3)]" role="status">{info?.error || status}</p>}
  </details>;
}
