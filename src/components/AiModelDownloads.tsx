import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, CloudDownload, Loader2, RefreshCw, X } from "lucide-react";
import { listenEvent } from "../api";
import { useI18n } from "../i18n";

type Model = {
  id: string; name: string; description: string; version: string;
  size: number; installedSize?: number; modelSha256: string; weight?: number;
};
type Installed = { model_sha256: string; package_id?: string; version?: string };
type Progress = { id: string; phase: string; received: number; total: number; percent: number; line: number };

const size = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export default function AiModelDownloads() {
  const { tr } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState("");
  const [architecture, setArchitecture] = useState("mdx-hq3");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState("");
  const refreshInstalled = async () => setInstalled(await invoke<Installed[]>("list_ai_models"));
  const refresh = async () => {
    setLoading(true); setMessage("");
    try {
      const [catalog, local] = await Promise.all([
        invoke<Model[]>("fetch_ai_model_catalog"), invoke<Installed[]>("list_ai_models"),
      ]);
      setModels(catalog); setInstalled(local);
    } catch (error) { setMessage(String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    void refresh();
    let disposed = false;
    let unbind: (() => void) | undefined;
    void listenEvent<Progress>("ai-model://progress", (value) => {
      setProgress(value);
      setActive(value.phase === "installed" ? "" : value.id);
    }).then((off) => { if (disposed) off(); else unbind = off; });
    return () => { disposed = true; unbind?.(); };
  }, []);
  const download = async (model: Model) => {
    setActive(model.id); setProgress(null); setMessage("");
    try {
      await invoke("download_ai_model", { id: model.id });
      await refreshInstalled();
      window.dispatchEvent(new Event("ai-models-changed"));
      setMessage(tr(`${model.name} 已安装，可在上方选择`, `${model.name} is installed and ready to select above.`));
    } catch (error) { setMessage(String(error)); }
    finally { setActive(""); setProgress(null); }
  };
  const importModel = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const source = await open({ multiple: false, filters: [{ name: "模型 ZIP / ONNX", extensions: ["zip", "onnx"] }] });
      if (!source || typeof source !== "string") return;
      setActive("local"); setMessage("");
      await invoke("import_ai_model", { source, architecture });
      await refreshInstalled();
      window.dispatchEvent(new Event("ai-models-changed"));
      setMessage(tr("模型已导入，可在上方选择后保存。", "Model imported. Select it above and save."));
    } catch (error) { setMessage(String(error)); }
    finally { setActive(""); }
  };
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold"><CloudDownload size={17} />{tr("模型下载", "Download models")}</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-3)]">{tr("选择模型即可下载并自动安装。多种模型共用运行环境，下载完成后可在上方切换。", "Download and install a model with one click. Models share the runtime and can be selected above.")}</p>
        </div>
        <button className="btn-secondary shrink-0 !px-3 !py-2" disabled={loading} onClick={() => { void refresh(); }} title={tr("刷新模型列表", "Refresh models")}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-[var(--line)] p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-[12px]">
              {tr("导入 ONNX 时的模型类型", "Model type for ONNX import")}
              <select className="mt-2 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2" value={architecture} onChange={event => setArchitecture(event.target.value)}>
                <option value="mdx-hq3">HQ3 / MDX</option>
                <option value="mdx-karaoke">UVR-MDX-NET Karaoke</option>
                <option value="bs-roformer-resurrection">BS-RoFormer Resurrection</option>
              </select>
            </label>
            <button className="btn-secondary shrink-0 !px-3 !py-2" disabled={!!active} onClick={() => { void importModel(); }}>{active === "local" ? tr("导入中…", "Importing…") : tr("导入本地模型", "Import local model")}</button>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{tr("支持兼容上述架构的 ONNX，或根目录含 model.json 和模型文件的 ZIP。UVR_MDXNET_KARA.onnx 是单模型方案，直接处理整首混音并以提取的人声残差生成伴奏；实际和声保留效果因歌曲而异。ZIP 自动读取模型类型，导入不会覆盖已有模型。", "Supports ONNX compatible with these architectures, or a ZIP with model.json and weights at its root. UVR_MDXNET_KARA.onnx is a single-model workflow that processes the full mix once and derives accompaniment from the vocal residual; harmony retention varies by song. ZIP type is read automatically; existing models are preserved.")}</p>
        </div>
        {models.map((model) => {
          const ready = installed.some((local) => local.model_sha256.toLowerCase() === model.modelSha256.toLowerCase());
          const busy = active === model.id;
          const current = busy && progress?.id === model.id ? progress : null;
          return <article key={model.id} className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 basis-48">
                <div className="break-words text-[13px] font-medium">{model.name}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ink-3)]">
                  <span>v{model.version}</span>
                  <span>{tr("下载大小", "Download size")} {size(model.size)}</span>
                  {!!model.installedSize && <span>{tr("安装后", "Installed size")} {size(model.installedSize)}</span>}
                </div>
                {model.description && <p className="mt-2 break-words text-[12px] leading-relaxed text-[var(--ink-2)]">{model.description}</p>}
              </div>
              <button className={`${ready ? "btn-secondary" : "btn-primary"} shrink-0 !px-3 !py-2`} disabled={ready || !!active} onClick={() => { void download(model); }}>
                {ready ? <Check size={14} /> : busy ? <Loader2 size={14} className="animate-spin" /> : <CloudDownload size={14} />}
                {ready ? tr("已安装", "Installed") : busy ? tr("处理中", "Working") : tr("下载模型", "Download")}
              </button>
            </div>
            {busy && <div className="mt-4" role="status">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--ink-2)]">
                <span>{current?.phase === "extract" ? tr("正在解压", "Extracting") : current ? tr(`正在下载 · 线路 ${current.line}`, `Downloading · source ${current.line}`) : tr("正在连接", "Connecting")}</span>
                <span className="tabular-nums">{current && current.total > 0 ? `${Math.min(current.percent, 100)}% · ${size(current.received)} / ${size(current.total)}` : ""}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--shade-strong)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={current?.percent}>
                <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150 motion-safe:animate-pulse" style={{ width: current ? `${Math.min(current.percent, 100)}%` : "0%" }} />
              </div>
              <button className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]" onClick={() => { void invoke("cancel_ai_model_download"); }}><X size={12} />{tr("取消下载", "Cancel download")}</button>
            </div>}
          </article>;
        })}
        {!loading && !models.length && !message && <p className="rounded-xl bg-[var(--shade)] p-4 text-[12px] text-[var(--ink-3)]">{tr("暂时没有可下载的模型，稍后刷新试试。", "No models are available yet. Try refreshing later.")}</p>}
      </div>
      {message && <p className="mt-3 break-words text-[12px] leading-relaxed text-[var(--ink-2)]" role="status">{message}</p>}
    </section>
  );
}
