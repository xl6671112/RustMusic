import { useState } from "react";

export const lyricHtmlExample = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; background: transparent; color: white; font: 700 42px sans-serif; text-align: center; }
    .line { text-shadow: 0 0 16px var(--rustmusic-sung-color, #8df7ff); }
    .translation { color: var(--rustmusic-translation-color, #dcb9ff); font-size: 23px; }
  </style>
</head>
<body>
  <main>
    <div class="line" data-rustmusic-slot="current"></div>
    <div class="translation" data-rustmusic-slot="translation"></div>
    <div data-rustmusic-slot="next"></div>
    <span hidden data-rustmusic-setting="sung-color" data-rustmusic-label="已唱歌词颜色" data-rustmusic-type="color" data-rustmusic-default="#8df7ff"></span>
    <span hidden data-rustmusic-setting="translation-color" data-rustmusic-label="译文颜色" data-rustmusic-type="color" data-rustmusic-default="#dcb9ff"></span>
  </main>
</body>
</html>`;

export const lyricHtmlPrompt = `请为 RustMusic 制作一份可直接粘贴的完整歌词 HTML 页面，而不是 CSS 片段。可包含 HTML、CSS 和 JavaScript，也可以按需要加载外部图片、字体、样式、脚本或数据；外部资源请使用完整的 HTTPS 地址，页面会在隔离的歌词画布内运行，不要尝试读取播放器页面或系统数据。

【我的效果要求】
在这里描述整体布局、字体、颜色、背景透明度、出场与退场动画、持续动效、挂件、歌词逐字效果等。

【必须遵守的播放器识别字段】
当前歌词位置必须有一个元素写成 data-rustmusic-slot="current"。可选位置：data-rustmusic-slot="translation" 显示译文/音译，data-rustmusic-slot="next" 显示下一句，data-rustmusic-slot="title" 显示歌名，data-rustmusic-slot="artist" 显示歌手。
要让用户在播放器设置里调整某项，请声明一个字段，例如：
<span hidden data-rustmusic-setting="sung-color" data-rustmusic-label="已唱歌词颜色" data-rustmusic-type="color" data-rustmusic-default="#8df7ff"></span>
<span hidden data-rustmusic-setting="lyric-size" data-rustmusic-label="歌词大小" data-rustmusic-type="number" data-rustmusic-default="42" data-rustmusic-min="12" data-rustmusic-max="120" data-rustmusic-step="1"></span>
设置字段的 id 只能用小写英文字母、数字和短横线，且以字母开头；label 是设置里显示的中文名称。颜色字段用 #RRGGBB。数字字段需给出 default、min、max，可选 step。
CSS 中通过 var(--rustmusic-sung-color) 或 var(--rustmusic-lyric-size) 使用字段值。可以按需加入多个 data-rustmusic-setting，播放器会自动生成对应控制项；没有声明的项目不会出现在设置里。

【输出要求】
只输出完整 HTML 源码，不要 Markdown 围栏或说明文字。保留透明背景，不放大块遮挡歌词的底板；逐字进度和歌曲切换由播放器驱动，不要自行模拟时间轴。`;

export default function LyricHtmlGuide() {
  const [guide, setGuide] = useState(0);
  const [status, setStatus] = useState("");
  const guides = [[lyricHtmlPrompt, "HTML 提示词"], [lyricHtmlExample, "完整 HTML 示例"]];
  const button = "min-w-0 min-h-10 rounded-lg border border-[var(--line)] bg-[var(--shade)] px-3 py-2 text-[12px] leading-5 text-[var(--ink)]";

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setStatus(`${label}已复制`); }
    catch (error) { setStatus(`复制失败：${String(error)}`); }
  }

  return <details className="mt-4 rounded-xl border border-[var(--line)] p-3 text-[12px] text-[var(--ink-2)]">
      <summary className="cursor-pointer py-1 font-medium">制作歌词页面</summary>
      <p className="mt-3 leading-6 text-[var(--ink-3)]">复制提示词交给 AI，描述想要的歌词风格；点击「新建歌词样式」后，将返回的完整 HTML 粘贴到编辑框。识别字段会自动生成对应的设置项。</p>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[640px]:grid-cols-2">
        {guides.map(([text, name], index) => <button key={name} type="button" aria-pressed={guide === index} className={button+(guide === index ? " !border-[var(--accent)] !text-[var(--accent)]" : "")} onClick={() => { setGuide(index); void copy(text, name); }}>复制{name}</button>)}
      </div>
      <button type="button" aria-label={`点击复制${guides[guide][1]}`} onClick={() => void copy(guides[guide][0], guides[guide][1])} className="mt-3 block w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--shade)] p-3 text-left">
        <span className="text-[11px] text-[var(--accent)]">{guides[guide][1]} · 点击复制</span>
        <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-6">{guides[guide][0]}</pre>
      </button>
      {status && <p role="status" className="mt-2 break-words text-[11px]">{status}</p>}
    </details>;
}
