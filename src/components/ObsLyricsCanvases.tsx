import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, Eye, EyeOff, PanelsTopLeft, Plus, RotateCw, Trash2 } from "lucide-react";
import { defaultStyleValues, initial, presets, type Config } from "../obsLyricsPresets";
import { readLyricsTemplates, templateSnapshot, type LyricsTemplate } from "../obsLyricsTemplates";
import { createJizuraSettings, JIZURA_STYLES } from "../jizuraSettings";
import CanvasLyricsEditor from "./CanvasLyricsEditor";

type Canvas = { id: string; name: string; settings: Config; enabled?: boolean; visible?: boolean };
type CanvasPreset = { id: string; name: string; canvases: Canvas[] };
type CanvasSettings = { enabled: boolean; captureEnabled: boolean; previewEnabled: boolean; activeId: string; presets: CanvasPreset[] };
type CanvasWindow = { id: string; visible: boolean };
const empty: CanvasSettings = { enabled: false, captureEnabled: false, previewEnabled: false, activeId: "", presets: [] };
const canvasUrl = (id: string) => `http://127.0.0.1:17842/canvas/${id}`;
function sceneSettings(value: CanvasSettings): CanvasSettings {
  if (!value.enabled) return value;
  const presets = [...value.presets];
  while (presets.length < 3) presets.push({ id: crypto.randomUUID(), name: `场景${presets.length + 1}`, canvases: [] });
  return { ...value, presets, activeId: presets.some(preset => preset.id === value.activeId) ? value.activeId : presets[0].id };
}

export default function ObsLyricsCanvases({ onStatus, onEnabledChange }: { onStatus: (message: string) => void; onEnabledChange?: (enabled: boolean) => void }) {
  const [settings, setSettings] = useState(empty), [templates, setTemplates] = useState<LyricsTemplate[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openWindows, setOpenWindows] = useState<CanvasWindow[]>([]), [windowsLoaded, setWindowsLoaded] = useState(false);
  const pending = useRef(false);
  const active = settings.presets.find(preset => preset.id === settings.activeId);
  const control = "h-9 min-w-0 rounded-md border border-[var(--line)] bg-[var(--shade)] px-2.5 text-[12px] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";
  const tool = control + " inline-flex w-9 shrink-0 items-center justify-center !px-0";
  function report(message: string) { setStatus(message); onStatus(message); }
  async function refreshTemplates() {
    try { setTemplates(await readLyricsTemplates()); }
    catch (error) { report(`读取歌词模板失败：${String(error)}`); }
  }
  async function load() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const value: CanvasSettings = JSON.parse(await invoke<string>("get_obs_lyrics_canvases"));
      if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.presets)) throw new Error("歌词场景格式无效");
      const next = sceneSettings({ ...value, captureEnabled: value.captureEnabled === true, previewEnabled: value.previewEnabled === true });
      if (next.presets.length !== value.presets.length || next.activeId !== value.activeId || next.previewEnabled !== value.previewEnabled) await invoke("set_obs_lyrics_canvases", { canvases: JSON.stringify(next) });
      setSettings(next); setLoaded(true); setStatus("");
      onEnabledChange?.(value.enabled);
    } catch (error) { report(`读取歌词场景失败：${String(error)}`); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => {
    void load(); void refreshTemplates();
    let disposed = false, unlisten: (() => void) | undefined;
    const refresh = () => { void refreshTemplates(); };
    window.addEventListener("obs-lyrics-templates-changed", refresh);
    void listen("obs-lyrics-templates-changed", refresh).then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(error => { if (!disposed) report(`模板同步暂不可用：${String(error)}`); });
    return () => { disposed = true; unlisten?.(); window.removeEventListener("obs-lyrics-templates-changed", refresh); };
  }, []);
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const remove = await listen<CanvasWindow & { open: boolean; error?: string }>("obs-lyrics-canvas-window", ({ payload }) => {
          if (!disposed && payload.id !== "primary") {
            setOpenWindows(windows => payload.open ? [...windows.filter(window => window.id !== payload.id), { id: payload.id, visible: payload.visible }] : windows.filter(window => window.id !== payload.id));
            if (payload.error) report(`歌词窗口出错：${payload.error}`);
          }
        });
        if (disposed) { remove(); return; }
        unlisten = remove;
        const ids = await invoke<CanvasWindow[]>("get_open_obs_lyrics_canvases");
        if (!disposed) { setOpenWindows(ids.filter(window => window.id !== "primary")); setWindowsLoaded(true); }
      } catch (error) { if (!disposed) report(`读取透明窗口状态失败：${String(error)}`); }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, []);
  async function run(action: () => Promise<void>) {
    if (!loaded || pending.current) return;
    pending.current = true; setBusy(true);
    try { await action(); }
    catch (error) { report(String(error).replace(/^Error: /, "")); }
    finally { pending.current = false; setBusy(false); }
  }
  async function persist(next: CanvasSettings, message: string) {
    await invoke("set_obs_lyrics_canvases", { canvases: JSON.stringify(next) });
    setSettings(next); onEnabledChange?.(next.enabled); report(message);
  }
  async function setMode(enabled: boolean) {
    await persist(sceneSettings({ ...settings, enabled, captureEnabled: enabled || settings.captureEnabled }), enabled ? "场景模式已开启" : "场景模式已关闭");
  }
  async function updateCanvases(canvases: Canvas[], message: string) {
    if (!active) return;
    await persist({ ...settings, presets: settings.presets.map(preset => preset.id === active.id ? { ...preset, canvases } : preset) }, message);
  }
  async function addCanvas() {
    if (!active) return;
    const template = styleById(templateId);
    if (!template) throw new Error("请先选择歌词风格");
    if (active.canvases.length >= 12) throw new Error("每个场景最多添加 12 个画布");
    if (settings.presets.reduce((count, preset) => count + preset.canvases.length, 0) >= 100) throw new Error("画布总数最多 100 个");
    const canvas = { id: crypto.randomUUID(), name: template.name, settings: templateSnapshot(template.settings), enabled: true, visible: true };
    await updateCanvases([...active.canvases, canvas], `已添加画布“${canvas.name}”`);
  }
  async function assignTemplate(canvas: Canvas, id: string) {
    const template = styleById(id);
    if (!template || !active) return;
    await updateCanvases(active.canvases.map(item => item.id === canvas.id ? { ...item, name: template.name, settings: templateSnapshot(template.settings) } : item), `画布已使用“${template.name}”`);
  }
  function matchingTemplate(canvas: Canvas) {
    const snapshot = JSON.stringify(templateSnapshot(canvas.settings));
    const local = templates.find(template => JSON.stringify(templateSnapshot(template.settings)) === snapshot);
    if (local) return `template:${local.id}`;
    const id = canvas.settings.preset === "jizura" ? `jizura:${canvas.settings.jizura?.project?.style ?? "noir"}` : canvas.settings.preset;
    const original = styleById(id);
    return original && JSON.stringify(original.settings) === snapshot ? id : "";
  }
  function styleById(id: string) {
    if (id.startsWith("template:")) return templates.find(template => template.id === id.slice(9));
    const preset = presets.find(([key]) => key === id);
    if (preset) return { name: preset[1], settings: templateSnapshot({ ...initial, ...defaultStyleValues(id), preset: id }) };
    const jizura = JIZURA_STYLES.find(style => `jizura:${style.id}` === id);
    if (jizura) return { name: `JIZURA · ${jizura.label}`, settings: templateSnapshot({ ...initial, preset: "jizura", jizura: createJizuraSettings(jizura.id) }) };
  }
  async function updateCanvas(canvas: Canvas, patch: Partial<Canvas>, message: string) {
    if (active) await updateCanvases(active.canvases.map(item => item.id === canvas.id ? { ...item, ...patch } : item), message);
  }
  const styleOptions = <>
    {templates.length > 0 && <optgroup label="我的歌词风格">{templates.map(template => <option key={template.id} value={`template:${template.id}`}>{template.name}</option>)}</optgroup>}
    <optgroup label="播放器歌词样式">{presets.filter(([key]) => !key.startsWith("folia-")).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</optgroup>
    <optgroup label="Folia 原版效果">{presets.filter(([key]) => key.startsWith("folia-")).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</optgroup>
    <optgroup label="JIZURA 原版效果">{JIZURA_STYLES.map(style => <option key={style.id} value={`jizura:${style.id}`}>JIZURA · {style.label}</option>)}</optgroup>
  </>;
  return <div className="mt-4 min-w-0 border-b border-[var(--line)] pb-4" aria-label="歌词场景设置">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h4 className="text-[12px] font-medium text-[var(--ink-2)]">歌词场景</h4>
      <label className="flex items-center gap-2 text-[12px] text-[var(--ink-2)]"><input type="checkbox" role="switch" aria-label="启用场景模式" className="accent-[var(--accent)]" checked={settings.enabled} disabled={!loaded || busy} onChange={event => { const enabled = event.currentTarget.checked; void run(() => setMode(enabled)); }}/>启用场景模式</label>
    </div>
    {!loaded && <button type="button" className={tool + " mt-2"} title="重新读取歌词场景" aria-label="重新读取歌词场景" disabled={busy} onClick={() => void load()}><RotateCw size={15}/></button>}
    {settings.enabled && <>
    <p className="mt-1 text-[11px] leading-5 text-[var(--ink-3)]">同时开启多个歌词窗口可能导致卡顿。</p>
    <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--ink-2)]"><input type="checkbox" role="switch" aria-label="启用画布预览" className="accent-[var(--accent)]" checked={settings.previewEnabled} disabled={busy} onChange={event => { const previewEnabled = event.currentTarget.checked; void run(() => persist({ ...settings, previewEnabled }, previewEnabled ? "画布预览已启用" : "画布预览已关闭")); }}/><span>启用画布预览</span></label>
    <div role="tablist" aria-label="歌词场景" className="mt-3 flex min-w-0 flex-wrap gap-1 border-b border-[var(--line)] pb-2">
      {settings.presets.map((preset, index) => <button key={preset.id} type="button" role="tab" aria-selected={active?.id === preset.id} aria-controls={`lyrics-scene-${preset.id}`} aria-label={`场景 ${index + 1}`} title={preset.name} className={control + (active?.id === preset.id ? " border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]" : "")} disabled={busy} onClick={() => void run(() => persist({ ...settings, activeId: preset.id, captureEnabled: true }, `已切换到${preset.name}`))}>{preset.name}</button>)}
    </div>
    {active && <div role="tabpanel" id={`lyrics-scene-${active.id}`} aria-label="当前场景画布">
      {settings.previewEnabled && <section className="mt-3 min-w-0 border-t border-[var(--line)] pt-3" aria-label="画布预览">
        <div className="flex items-center justify-between gap-2"><h5 className="text-[12px] font-medium text-[var(--ink-2)]">画布预览</h5><span className="text-[11px] text-[var(--ink-3)]">当前场景 · 网页预览</span></div>
        {active.canvases.length === 0 ? <p className="mt-2 text-[11px] text-[var(--ink-3)]">暂无歌词画布</p> : <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
          {active.canvases.map((canvas, index) => <div key={canvas.id} className="min-w-0 overflow-hidden rounded-md border border-[var(--line)] bg-black/10">
            <p className="truncate px-2 py-1 text-[11px] text-[var(--ink-2)]">{index + 1}. {canvas.name}</p>
            <iframe title={`画布 ${index + 1} 预览`} src={canvasUrl(canvas.id)} loading="lazy" className="block aspect-video w-full border-0 bg-transparent" />
          </div>)}
        </div>}
      </section>}
      <div className="mt-3 flex min-w-0 flex-wrap gap-2">
        <select aria-label="新画布歌词风格" className={control + " flex-1 basis-48"} value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)}><option value="">选择歌词风格</option>{styleOptions}</select>
        <button type="button" className={control + " inline-flex shrink-0 items-center gap-1.5"} disabled={busy || !templateId} onClick={() => void run(addCanvas)}><Plus size={14}/>添加画布</button>
      </div>
      <section className="mt-3 min-w-0 border-t border-[var(--line)] pt-3" aria-label="歌词窗口管理控制台">
        <h5 className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-2)]"><PanelsTopLeft size={14}/>场景画布</h5>
        {active.canvases.length === 0 && <p className="mt-2 text-[11px] text-[var(--ink-3)]">暂无歌词画布</p>}
        <div className="mt-1 divide-y divide-[var(--line)]">
          {active.canvases.map((canvas, index) => {
            const window = openWindows.find(window => window.id === canvas.id);
            return <div key={canvas.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 flex-1 basis-36"><p className="break-words text-[12px] text-[var(--ink)]">{index + 1}. {canvas.name}</p><p aria-label={`画布 ${index + 1} 窗口状态`} className="mt-0.5 text-[11px] text-[var(--ink-3)]">{!windowsLoaded ? "读取窗口状态…" : !window ? "窗口未创建" : window.visible ? "窗口已显示" : "窗口已隐藏"}</p></div>
              <div className="flex shrink-0 items-center gap-3 text-[12px] text-[var(--ink-2)]">
                <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={`启用画布 ${index + 1}`} checked={canvas.enabled !== false} className="accent-[var(--accent)]" disabled={busy} onChange={event => { const enabled = event.currentTarget.checked; void run(() => updateCanvas(canvas, { enabled }, enabled ? "画布已启用" : "画布已停用")); }}/>启用</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={`启用画布 ${index + 1} 窗口`} checked={!!window} className="accent-[var(--accent)]" disabled={busy || !windowsLoaded || (!window && (canvas.enabled === false || canvas.visible === false))} onChange={event => { const enabled = event.currentTarget.checked; void run(async () => { await invoke(enabled ? "open_obs_lyrics_canvas" : "close_obs_lyrics_canvas", { id: canvas.id }); report(enabled ? `已打开画布“${canvas.name}”的窗口` : `已关闭画布“${canvas.name}”的窗口`); }); }}/>独立窗口</label>
                <button type="button" className={tool} title={canvas.visible === false ? "显示画布" : "隐藏画布并回收窗口内存"} aria-label={`${canvas.visible === false ? "显示" : "隐藏"}画布 ${index + 1}`} disabled={busy || canvas.enabled === false} onClick={() => void run(() => updateCanvas(canvas, { visible: canvas.visible === false }, canvas.visible === false ? "画布已显示" : "画布已隐藏并回收窗口内存"))}>{canvas.visible === false ? <Eye size={15}/> : <EyeOff size={15}/>}</button>
              </div>
              <div className="flex min-w-0 basis-full gap-2">
                <select aria-label={`画布 ${index + 1} 歌词风格`} className={control + " flex-1"} value={matchingTemplate(canvas)} disabled={busy} onChange={event => { const id = event.target.value; void run(() => assignTemplate(canvas, id)); }}><option value="">已保存的画布配置</option>{styleOptions}</select>
                <button type="button" className={tool} title="删除歌词画布" aria-label={`删除画布 ${index + 1}`} disabled={busy} onClick={() => void run(() => updateCanvases(active.canvases.filter(item => item.id !== canvas.id), "歌词画布已删除"))}><Trash2 size={15}/></button>
              </div>
              <div className="flex min-w-0 basis-full gap-2">
                <input readOnly aria-label={`画布 ${index + 1} 网页地址`} className={control + " flex-1"} value={canvasUrl(canvas.id)} onFocus={event => event.currentTarget.select()}/>
                <button type="button" className={tool} title="复制画布地址" aria-label={`复制画布 ${index + 1} 地址`} disabled={busy} onClick={() => { void navigator.clipboard.writeText(canvasUrl(canvas.id)).then(() => report("画布地址已复制")).catch(() => report("请选中画布网页地址复制")); }}><Copy size={15}/></button>
              </div>
              <details className="min-w-0 basis-full" aria-label={`画布 ${index + 1} 设置`} onToggle={event => { if (event.currentTarget.open) setExpanded(previous => previous[canvas.id] ? previous : { ...previous, [canvas.id]: true }); }}>
                <summary className="cursor-pointer py-2 text-[12px] text-[var(--ink-2)]">画布设置</summary>
                {expanded[canvas.id] && <CanvasLyricsEditor key={JSON.stringify(canvas.settings)} value={canvas.settings} disabled={busy} onSave={settings => run(() => updateCanvas(canvas, { settings }, "画布设置已保存"))}/>}
              </details>
            </div>;
          })}
        </div>
      </section>
    </div>}
    </>}
    {(busy || status) && <p role="status" className="mt-2 break-words text-[11px] leading-5 text-[var(--ink-3)]">{busy ? "处理中…" : status}</p>}
  </div>;
}
