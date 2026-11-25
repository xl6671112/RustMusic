import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import { readContextModelIDs, saveContextModelIDs } from "../aiContextModels";

type Model = { id: string; name: string; architecture: string; description: string; bytes: number };
type RuntimeSettings = { modelId: string; gpuPercent: number; memoryMb: number };

export default function AiRuntimeSettings({ className }: { className?: string }) {
  const { tr } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextIDs, setContextIDs] = useState(readContextModelIDs);
  const loadSettings = async () => {
    setLoading(true);
    setMessage("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        invoke<RuntimeSettings>("get_ai_runtime_settings"),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(tr("读取 AI 设置超时，请点击刷新重试", "AI settings timed out. Click refresh to retry."))), 8000); }),
      ]);
      setSettings({ ...value, gpuPercent: value.gpuPercent < 45 ? 30 : value.gpuPercent < 80 ? 60 : 100 });
    } catch (error) { setMessage(String(error)); }
    finally { clearTimeout(timer); setLoading(false); }
  };
  const loadModels = () => invoke<Model[]>("list_ai_models").then(setModels).catch((error) => setMessage(String(error)));
  useEffect(() => {
    void loadModels();
    void loadSettings();
    const refresh = () => { void loadModels(); };
    window.addEventListener("ai-models-changed", refresh);
    return () => window.removeEventListener("ai-models-changed", refresh);
  }, []);
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setMessage("");
    try {
      await invoke("set_ai_runtime_settings", { settings });
      setMessage(tr("已保存，下次提取时生效", "Saved. Applies to the next extraction."));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const control = "w-full min-w-0 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-[13px] text-[var(--ink)]";
  const selected = settings?.modelId ? models.find((model) => model.id === settings.modelId) : models.find((model) => model.architecture === "mdx-hq3") ?? models[0];
  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold"><Cpu size={17} />{tr("AI 提取", "AI extraction")}</h2>
        <button className="btn-secondary !px-3 !py-2" disabled={loading} onClick={() => { void loadModels(); void loadSettings(); }} title={tr("刷新已安装模型", "Refresh installed models")}><RefreshCw size={14} /></button>
      </div>
      {settings && <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
        <label className="min-w-0 md:col-span-2">
          <span className="mb-2 block text-[12px] text-[var(--ink-2)]">{tr("提取模型", "Extraction model")}</span>
          <select className={control} value={settings.modelId} onChange={(event) => setSettings({ ...settings, modelId: event.target.value })}>
            <option value="">{tr("自动选择（优先 HQ3）", "Automatic (prefer HQ3)")}</option>
            {settings.modelId && !models.some((model) => model.id === settings.modelId) && <option value={settings.modelId}>{tr("之前选择的模型尚未安装", "Previously selected model is unavailable")}</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
          </select>
          {selected && <div className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
            {selected.description && <p className="break-words">{selected.description}</p>}
            <p>{tr("模型文件大小", "Model file size")} · {(selected.bytes / (1024 * 1024)).toFixed(1)} MB</p>
          </div>}
          {!models.length && <span className="mt-2 block text-[11.5px] text-[var(--ink-3)]">{tr("还没有模型，请在下方下载。", "No models installed. Download one below.")}</span>}
        </label>
        <fieldset className="min-w-0 md:col-span-2 rounded-xl border border-[var(--line)] p-3">
          <legend className="px-1 text-[12px] text-[var(--ink-2)]">{tr("右键可使用的模型", "Models shown in the song menu")}</legend>
          <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{tr("勾选后，可在歌曲右键菜单中选择这些模型。立即保存，不影响默认提取模型。", "Checked models can be selected from a song's menu. Saved immediately without changing the default model.")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-h-48 overflow-y-auto">
            {models.map((model) => <label key={model.id} className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--shade)] p-2 text-[12px]">
              <input type="checkbox" className="mt-1 shrink-0" checked={contextIDs === null || contextIDs.includes(model.id)}
                onChange={(e) => {
                  const current = contextIDs ?? models.map((item) => item.id);
                  const next = e.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id);
                  try { saveContextModelIDs(next); setContextIDs(next); }
                  catch (error) { setMessage(String(error)); }
                }} />
              <span className="min-w-0 break-words">{model.name}<span className="block text-[11px] text-[var(--ink-3)]">{model.id}</span></span>
            </label>)}
          </div>
          {!models.length && <p className="text-[11.5px] text-[var(--ink-3)]">{tr("安装模型后即可选择。", "Install a model to choose it here.")}</p>}
          <button className="mt-3 text-[11.5px] text-[var(--accent)]" onClick={() => {
            const ids = models.map((model) => model.id);
            try { saveContextModelIDs(ids); setContextIDs(ids); }
            catch (error) { setMessage(String(error)); }
          }}>{tr("选择全部已安装模型", "Select all installed models")}</button>
        </fieldset>
        <label className="min-w-0">
          <span className="mb-2 block text-[12px] text-[var(--ink-2)]">{tr("显卡效率", "GPU performance")}</span>
          <select aria-label={tr("显卡效率", "GPU performance")} className={control} value={settings.gpuPercent} onChange={(event) => setSettings({ ...settings, gpuPercent: Number(event.target.value) })}>
            <option value={100}>{tr("高 · 速度优先", "High · Faster extraction")}</option>
            <option value={60}>{tr("中 · 均衡（默认）", "Medium · Balanced (default)")}</option>
            <option value={30}>{tr("低 · 减少持续负载", "Low · Reduced sustained load")}</option>
          </select>
          <span className="mt-2 block text-[11.5px] leading-relaxed text-[var(--ink-3)]">{tr("低档会增加计算间隔，提取时间更长。实际显卡占用随模型变化，档位不代表固定占用率。", "Lower settings add pauses and take longer. Actual GPU usage varies by model; levels are not fixed utilization percentages.")}</span>
        </label>
        <label className="min-w-0">
          <span className="mb-2 block text-[12px] text-[var(--ink-2)]">{tr("每次提取的内存上限", "Memory limit per extraction")}</span>
          <select className={control} value={settings.memoryMb} onChange={(event) => setSettings({ ...settings, memoryMb: Number(event.target.value) })}>
            <option value={0}>{tr("不限制", "Unlimited")}</option>
            {[1024, 2048, 4096, 8192, 16384, 32768].map((mb) => <option key={mb} value={mb}>{mb / 1024} GB</option>)}
          </select>
          <span className="mt-2 block text-[11.5px] leading-relaxed text-[var(--ink-3)]">{tr("限制提取任务的系统内存；不足时会停止本次提取。显存由显卡运行环境分配。", "Limits extraction process memory. An insufficient limit stops the task; VRAM allocation is managed by the GPU runtime.")}</span>
        </label>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button className="btn-primary flex items-center gap-2" disabled={busy} onClick={() => { void save(); }}>{busy && <Loader2 size={14} className="animate-spin" />}{tr("保存设置", "Save settings")}</button>
          {message && <span className="min-w-0 break-words text-[12px] text-[var(--ink-2)]">{message}</span>}
        </div>
      </div>}
      {!settings && <p className="mt-3 text-[12px] text-[var(--ink-3)]">{message || tr("正在读取 AI 设置…", "Loading AI settings…")}</p>}
    </section>
  );
}
