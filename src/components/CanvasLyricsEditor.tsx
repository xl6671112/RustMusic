import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { widgets, type Config } from "../obsLyricsPresets";
import { templateSnapshot } from "../obsLyricsTemplates";
import { readLyricHtmlSettings, validateLyricHtml } from "../lyricHtml";
import LyricsFontPicker from "./LyricsFontPicker";

const JizuraSettings = lazy(() => import("./JizuraSettings"));
const labels = {
  size: "字号", width: "宽度", color: "文字色", weight: "字重", font: "系统／回退字体", stroke: "描边色", strokeWidth: "描边宽度", shadow: "阴影", lineHeight: "行距", letterSpacing: "字距", translationSize: "翻译字号", rows: "显示行数", offsetY: "垂直偏移",
  motion: "动画", particleDissolve: "粒子消散", particleSize: "粒子大小", particleColor: "粒子颜色", particleColorIntensity: "粒子颜色强度", particleGlow: "粒子光晕", particleGlowStrength: "粒子光晕强度", particleHdr: "粒子 HDR", particleCount: "粒子数量", particleLifetime: "粒子寿命", particleSpeed: "粒子速度", particleFragmentation: "粒子碎片度", particleEdgeHighlight: "粒子边缘高光", lyricGlowStrength: "歌词光晕强度",
  rawEffectsEnabled: "原始效果自定义", rawShadow: "原始投影色", rawAccent: "原始高光色", rawGlow: "原始辉光色", rawStroke: "原始描边色", rawStrokeWidth: "原始描边宽度", bounceTrailDuration: "弹跳拖尾时长", bounceTrailLength: "弹跳拖尾长度",
} as const;

export default function CanvasLyricsEditor({ value, disabled, onSave }: { value: Config; disabled: boolean; onSave: (settings: Config) => Promise<void> }) {
  const [draft, setDraft] = useState(() => templateSnapshot(value));
  const [error, setError] = useState("");
  const panel = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(300);
  const folia = draft.preset.startsWith("folia-");
  const mode = draft.preset.slice(6);
  const control = "mt-1 block h-9 w-full min-w-0 rounded-md border border-[var(--line)] bg-[var(--shade)] px-2 text-[12px] text-[var(--ink)]";
  function patch(values: Partial<Config>) { setDraft(previous => ({ ...previous, ...values })); setError(""); }
  const current = useRef(draft);
  current.current = draft;
  function sync() { panel.current?.contentWindow?.postMessage({ type: "folia-settings-init", settings: current.current, altMode: "translation", daylight: document.documentElement.dataset.theme === "light" }, "http://127.0.0.1:17842"); }
  useEffect(() => { sync(); }, [draft]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:17842" || event.source !== panel.current?.contentWindow) return;
      const message = event.data;
      if (message?.type === "folia-settings-ready") sync();
      if (message?.type === "folia-settings-height" && Number.isFinite(message.height)) setHeight(Math.max(90, Math.min(6000, message.height)));
      if (message?.type === "folia-settings-change" && message.values) {
        const values = Object.fromEntries((["foliaAppearance", "foliaTunings", "foliaAssets"] as const).flatMap(key => {
          const item = message.values[key];
          return item && typeof item === "object" && !Array.isArray(item) ? [[key, item]] : [];
        }));
        patch(values);
      }
      if (message?.type === "folia-asset-import" && message.blob instanceof Blob && typeof message.id === "string" && typeof message.name === "string" && (message.kind === "image" || message.kind === "font")) {
        const source = event.source as Window;
        const reply = (value: { file?: string; error?: string }) => source.postMessage({ type: "folia-asset-result", id: message.id, ...value }, event.origin);
        void (async () => {
          const isFont = message.kind === "font", limit = isFont ? 20 : 8;
          if (!message.blob.size || message.blob.size > limit * 1024 * 1024) throw new Error(`文件最大 ${limit} MB`);
          const bytes = new Uint8Array(await message.blob.arrayBuffer()), parts: string[] = [];
          for (let index = 0; index < bytes.length; index += 32768) parts.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
          const data = btoa(parts.join(""));
          const file = isFont ? (await invoke<{ fontFile: string }>("import_obs_lyrics_font", { name: message.name, data })).fontFile : await invoke<string>("import_folia_image", { data });
          reply({ file });
        })().catch(error => reply({ error: String(error) }));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  async function save() {
    const invalid = draft.customHtmlEnabled ? validateLyricHtml(draft.customHtml) : "";
    if (invalid) { setError(invalid); return; }
    try { await onSave(templateSnapshot(draft)); }
    catch (error) { setError(String(error)); }
  }
  return <div className="min-w-0 border-t border-[var(--line)] pt-3">
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-50">
      {draft.preset === "jizura" ? <Suspense fallback={<p>正在加载设置…</p>}><JizuraSettings value={draft.jizura} onChange={jizura => patch({ jizura })}/></Suspense> : folia ? <>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.foliaTuningEnabled?.[mode] !== false} onChange={event => patch({ foliaTuningEnabled: { ...draft.foliaTuningEnabled, [mode]: event.target.checked } })}/>自定义动画</label>
        <iframe ref={panel} title="画布 Folia 歌词样式设置" src="http://127.0.0.1:17842/folia#settings" onLoad={sync} className="block w-full border-0" style={{ height }}/>
      </> : <>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.htmlTuningEnabled !== false} onChange={event => patch({ htmlTuningEnabled: event.target.checked })}/>自定义动画</label>
        <div className="grid min-w-0 grid-cols-2 gap-3 text-[12px]">
          <label className="min-w-0">显示方式<select className={control} value={draft.mode} onChange={event => patch({ mode: event.target.value })}><option value="current">当前句</option><option value="current-next">当前句＋下一句</option><option value="multi">滚动多行</option></select></label>
          <label className="min-w-0">对齐<select className={control} value={draft.align} onChange={event => patch({ align: event.target.value })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
          <label className="min-w-0">歌词时间轴<select className={control} value={draft.lyricTimeline} onChange={event => patch({ lyricTimeline: event.target.value as Config["lyricTimeline"] })}><option value="original">原歌词时间轴</option><option value="split">切分时间轴</option></select></label>
          <label className="min-w-0">歌词互动挂件<select className={control} value={draft.widget} onChange={event => patch({ widget: event.target.value })}>{widgets.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="min-w-0">弹跳拖尾<select className={control} value={draft.bounceTrailType} onChange={event => patch({ bounceTrailType: event.target.value as Config["bounceTrailType"] })}><option value="none">无</option><option value="single">单拖尾</option><option value="double">双拖尾</option><option value="particles">粒子</option></select></label>
          {Object.entries(labels).map(([name, label]) => {
            const key = name as keyof typeof labels, value = draft[key];
            return <label key={key} className="min-w-0">{label}{typeof value === "boolean" ? <input aria-label={label} type="checkbox" className="ml-2 accent-[var(--accent)]" checked={value} onChange={event => patch({ [key]: event.target.checked })}/> : <input aria-label={label} className={control} type={typeof value === "number" ? "number" : /^#[\da-f]{6}$/i.test(value) ? "color" : "text"} step="any" value={value} onChange={event => { const next = typeof value === "number" ? event.target.valueAsNumber : event.target.value; if (typeof next !== "number" || Number.isFinite(next)) patch({ [key]: next }); }}/>}</label>;
          })}
        </div>
        <LyricsFontPicker value={draft} disabled={disabled} onChange={font => patch(font)}/>
        {draft.customHtmlEnabled && <label className="block text-[12px]">自定义 HTML<textarea aria-label="画布自定义 HTML" className={control + " !h-48 py-2 font-mono"} value={draft.customHtml} onChange={event => patch({ customHtml: event.target.value })}/></label>}
        {draft.customHtmlEnabled && <div className="grid min-w-0 grid-cols-2 gap-3 text-[12px]">{readLyricHtmlSettings(draft.customHtml).map(setting => <label key={setting.id} className="min-w-0">{setting.label}
          <input aria-label={setting.label} className={control} type={setting.type === "color" ? "color" : "number"} min={setting.min} max={setting.max} step={setting.step} value={draft.customHtmlValues[setting.id] ?? setting.defaultValue} onChange={event => {
            const value = setting.type === "color" ? event.target.value : event.target.valueAsNumber;
            if (typeof value !== "number" || Number.isFinite(value)) patch({ customHtmlValues: { ...draft.customHtmlValues, [setting.id]: value } });
          }}/>
        </label>)}</div>}
        <label className="block text-[12px]">自定义 CSS<textarea aria-label="画布自定义 CSS" className={control + " !h-24 py-2 font-mono"} value={draft.css} onChange={event => patch({ css: event.target.value })}/></label>
      </>}
      <button type="button" className={control + " !w-auto px-3"} onClick={() => void save()}>保存画布设置</button>
    </fieldset>
    {error && <p role="alert" className="mt-2 break-words text-[12px]">{error}</p>}
  </div>;
}
