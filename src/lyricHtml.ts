export type LyricHtmlSetting = {
  id: string;
  label: string;
  type: "color" | "number";
  defaultValue: string;
  min: number;
  max: number;
  step: number;
};

const safeKey = /^[a-z][a-z0-9-]{0,31}$/;
const safeAttribute = (value: string | number) => typeof value === "number"
  ? Number.isFinite(value)
  : /^#[\da-f]{6}$/i.test(value);

export function validateLyricHtml(html: string): string | null {
  if (html.length > 12_000) return "歌词 HTML 最多 12000 个字符";
  if (!html.trim()) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  if (document.querySelector("iframe,object,embed,base,form")) return "歌词 HTML 不能嵌套页面、插件、表单或修改基础地址";
  if (!document.querySelector('[data-rustmusic-slot="current"]')) {
    return '模板必须包含 data-rustmusic-slot="current"';
  }
  const ids = new Set<string>();
  for (const marker of document.querySelectorAll("[data-rustmusic-setting]")) {
    const id = marker.getAttribute("data-rustmusic-setting") || "";
    const type = marker.getAttribute("data-rustmusic-type") || "";
    const label = marker.getAttribute("data-rustmusic-label") || "";
    const defaultValue = marker.getAttribute("data-rustmusic-default") || "";
    if (!safeKey.test(id) || ids.has(id) || !label || label.length > 32 || !["color", "number"].includes(type)) {
      return "可调整项标记无效：检查名称、类型、说明及重复项";
    }
    ids.add(id);
    if (type === "color" && !/^#[\da-f]{6}$/i.test(defaultValue)) return `${label}的默认颜色需使用 #RRGGBB`;
    if (type === "number") {
      const min = Number(marker.getAttribute("data-rustmusic-min"));
      const max = Number(marker.getAttribute("data-rustmusic-max"));
      const step = Number(marker.getAttribute("data-rustmusic-step") || 1);
      const value = Number(defaultValue);
      if (![min, max, step, value].every(Number.isFinite) || min > value || value > max || step <= 0 || max - min > 100_000) {
        return `${label}的数值范围或默认值无效`;
      }
    }
  }
  return null;
}

export function readLyricHtmlSettings(html: string): LyricHtmlSetting[] {
  if (!html.trim()) return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll("[data-rustmusic-setting]")].map(marker => ({
    id: marker.getAttribute("data-rustmusic-setting") || "",
    label: marker.getAttribute("data-rustmusic-label") || "",
    type: marker.getAttribute("data-rustmusic-type") as LyricHtmlSetting["type"],
    defaultValue: marker.getAttribute("data-rustmusic-default") || "",
    min: Number(marker.getAttribute("data-rustmusic-min") || 0),
    max: Number(marker.getAttribute("data-rustmusic-max") || 100),
    step: Number(marker.getAttribute("data-rustmusic-step") || 1),
  }));
}

export function lyricHtmlRuntime(settings: Record<string, string | number>): string {
  const values = Object.entries(settings).filter(([id, value]) =>
    safeKey.test(id) && safeAttribute(value),
  );
  const json = JSON.stringify(values);
  return `(()=>{const controls=${json};const valid=value=>typeof value==="number"&&Number.isFinite(value)||typeof value==="string"&&/^#[\\da-f]{6}$/i.test(value);const applySettings=values=>{for(const [id,fallback] of controls){const value=values?.[id]??fallback;if(valid(value))document.documentElement.style.setProperty("--rustmusic-"+id,String(value))}};applySettings({});document.querySelectorAll("[data-rustmusic-setting]").forEach(el=>el.hidden=true);const text=(slot,value)=>{const target=document.querySelector('[data-rustmusic-slot="'+slot+'"]');if(target)target.textContent=value||""};const chars=(slot,line)=>{const target=document.querySelector('[data-rustmusic-slot="'+slot+'"]');if(!target)return;target.replaceChildren();if(!line)return;const words=Array.isArray(line.words)?line.words:null;if(words){for(const word of words){const span=document.createElement("span");span.className="word";span.style.setProperty("--progress",String(word.progress||0)+"%");span.textContent=word.text||"";target.append(span)}}else target.textContent=line.text||""};addEventListener("message",event=>{if(event.source!==parent||event.data?.type!=="rustmusic-lyrics-state")return;const value=event.data.state||{};applySettings(value.settings);chars("current",value.current);text("translation",value.translation);text("next",value.next);text("title",value.title);text("artist",value.artist);document.documentElement.dataset.playing=value.playing?"true":"false";document.documentElement.dataset.progress=String(value.progress||0);document.documentElement.dataset.preset=value.preset||"custom";document.documentElement.dataset.motion=value.motion===false?"off":"on";document.documentElement.dataset.mode=value.mode||"current-next"})})();`;
}

export function buildLyricHtmlDocument(html: string, settings: Record<string, string | number>): string {
  const declared = Object.fromEntries(readLyricHtmlSettings(html).map(setting => [setting.id, settings[setting.id] ?? (setting.type === "number" ? Number(setting.defaultValue) : setting.defaultValue)]));
  const runtime = lyricHtmlRuntime(declared).replace(/<\/script/gi, "<\\/script");
  const script = `<script>${runtime}</script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${script}</body>`);
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, `${script}</html>`);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}${script}</body></html>`;
}
