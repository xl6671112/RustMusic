import { useMemo, useState } from "react";
import notices from "../openSourceNotices.json";
import { api } from "../api";
import { useI18n } from "../i18n";

export default function OpenSourceAbout({ className }: { className: string }) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [linkError, setLinkError] = useState("");
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return notices.filter((item) => `${item.name} ${item.authors.join(" ")} ${item.license} ${item.group}`.toLocaleLowerCase().includes(search));
  }, [query]);
  return <section className={className} aria-label={tr("关于与开源致谢", "About & Open Source")}>
    <h2 className="mb-2 text-[14.5px] font-semibold">{tr("关于 · 开源致谢", "About · Open Source")}</h2>
    <p className="text-[12px] leading-6 text-[var(--ink-3)]">{tr("感谢以下开源项目与作者，让播放、歌词、音频处理和在线服务成为可能。", "Thanks to the projects and contributors behind playback, lyrics, audio processing, and online services.")}</p>
    <details className="mt-3">
      <summary className="cursor-pointer py-2 text-[12.5px] text-[var(--ink-2)]">{tr(`查看 ${notices.length} 项项目与作者`, `View ${notices.length} projects and authors`)}</summary>
      <input aria-label={tr("搜索开源项目或作者", "Search open source projects or authors")} value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={tr("搜索项目、作者或许可证", "Search projects, authors, or licenses")}
        className="my-3 h-10 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--shade)] px-3 text-[12px] text-[var(--ink)]" />
      <div className="max-h-[420px] space-y-3 overflow-y-auto overscroll-contain pr-2">
        {filtered.map((item) => <article key={`${item.group}:${item.name}:${item.version}`} className="rounded-lg border border-[var(--line)] p-3 text-[12px] leading-6">
          <div className="flex flex-wrap items-baseline gap-x-2"><span className="break-all font-semibold">{item.name}</span><span className="text-[var(--ink-3)]">{item.version}</span></div>
          <p className="break-words text-[var(--ink-2)]">{tr("作者：", "Authors: ")}{item.authors.join("；")}</p>
          <p className="break-words text-[var(--ink-3)]">{item.license} · {item.group}</p>
          {item.url && <button type="button" className="text-[var(--accent-strong)] hover:underline" onClick={() => { setLinkError(""); void api.openUrl(item.url).catch(() => setLinkError(tr("暂时无法打开项目页面，请稍后重试。", "Unable to open the project page. Please try again."))); }}>{tr("项目主页", "Project website")}</button>}
        </article>)}
        {!filtered.length && <p className="py-4 text-[12px] text-[var(--ink-3)]">{tr("没有找到匹配的项目。", "No matching projects.")}</p>}
      </div>
      {linkError && <p role="status" className="mt-2 text-[12px] text-rose-400">{linkError}</p>}
      <p className="mt-3 text-[11.5px] leading-6 text-[var(--ink-3)]">{tr("完整署名与已随附的许可正文保存在播放器目录 docs/Open-Source-LICENSE.txt。未单列个人作者的项目按项目贡献者署名，冻结组件未保留版本时显示“随附版本”。", "Full acknowledgements and available license texts are in docs/Open-Source-LICENSE.txt. Projects without named authors credit their contributors; frozen components without version metadata show the bundled version.")}</p>
    </details>
  </section>;
}
