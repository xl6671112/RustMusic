import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { defaultStyleValues, initial, loadLyricsSettings, presets, styleFields, styleKey, widgets, type Config, type StyleField } from "../obsLyricsPresets";
import { fetchStyles, saveLyricsSettings, type StylePack } from "../obsLyricsUpdates";
import { buildLyricHtmlDocument, readLyricHtmlSettings, validateLyricHtml } from "../lyricHtml";
import LyricHtmlGuide, { lyricHtmlExample } from "./WebLyricsCssEditor";
import LyricsFontPicker from "./LyricsFontPicker";
import { useStore } from "../store";
import { exportFoliaPackage, importFoliaPackage } from "../foliaPackage";
export default function ObsLyricsSettings({onReady}:{onReady?:(ready:boolean)=>void}){
  const lyricsAltMode=useStore(s=>s.lyricsAltMode),setLyricsAltMode=useStore(s=>s.setLyricsAltMode);
  const [pack,setPack]=useState<StylePack>({version:"",styles:[]});
  async function checkStyles(){try{const next=await fetchStyles();setPack(next);setStatus(`官网风格 ${next.version} 已获取，可在歌词风格中选择`)}catch{setStatus("暂时无法获取官网风格，已保存的风格仍可使用")}}
  const [draft,setDraft]=useState(initial),[loaded,setLoaded]=useState(false),[status,setStatus]=useState(""),[saving,setSaving]=useState(false),[foliaDefaults,setFoliaDefaults]=useState<Record<string,Record<string,unknown>>>({});const frame=useRef<HTMLIFrameElement>(null),customPreview=useRef<HTMLIFrameElement>(null),foliaImport=useRef<HTMLInputElement>(null);
  const [foliaExpanded,setFoliaExpanded]=useState(false);
  const [foliaHeight,setFoliaHeight]=useState(160);
  const [foliaPackageBusy,setFoliaPackageBusy]=useState(false);
  const foliaPanel=useRef<HTMLIFrameElement>(null);
  const currentFoliaSettings={preset:draft.preset,foliaTunings:draft.foliaTunings,foliaTuningEnabled:draft.foliaTuningEnabled,foliaAppearance:draft.foliaAppearance,foliaAssets:draft.foliaAssets};
  const foliaMessage=useRef<object>({});
  foliaMessage.current={type:"folia-settings-init",settings:currentFoliaSettings,altMode:lyricsAltMode,daylight:document.documentElement.dataset.theme==="light"};
  const syncFoliaPanel=()=>foliaPanel.current?.contentWindow?.postMessage(foliaMessage.current,"http://127.0.0.1:17842");
  useEffect(()=>{syncFoliaPanel()},[draft.preset,draft.foliaTunings,draft.foliaTuningEnabled,draft.foliaAppearance,draft.foliaAssets,lyricsAltMode,foliaExpanded]);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!=="http://127.0.0.1:17842"||event.source!==foliaPanel.current?.contentWindow)return;
      const message=event.data;
      if(message?.type==="folia-settings-ready")syncFoliaPanel();
      if(message?.type==="folia-settings-height"&&Number.isFinite(message.height))setFoliaHeight(Math.max(90,Math.min(6000,message.height)));
      if(message?.type==="folia-settings-change"&&message.values){
        const keys=["foliaAppearance","foliaTunings","foliaAssets"] as const;
        const patch=Object.fromEntries(keys.flatMap(key=>{
          const value=message.values[key];
          return value&&typeof value==="object"&&!Array.isArray(value)?[[key,value]]:[];
        }));
        setDraft(previous=>({...previous,...patch}));
        setStatus("有未保存的修改");
      }
      if(message?.type==="folia-asset-import"&&message.blob instanceof Blob&&typeof message.id==="string"&&typeof message.name==="string"&&(message.kind==="image"||message.kind==="font")){
        const source=event.source as Window;
        const reply=(value:{file?:string;error?:string})=>source.postMessage({type:"folia-asset-result",id:message.id,...value},event.origin);
        void (async()=>{
          const isFont=message.kind==="font";
          const limit=isFont?20:8;
          if(!message.blob.size||message.blob.size>limit*1024*1024)throw new Error(`文件最大 ${limit} MB`);
          const bytes=new Uint8Array(await message.blob.arrayBuffer()),parts:string[]=[];
          for(let index=0;index<bytes.length;index+=32768)parts.push(String.fromCharCode(...bytes.subarray(index,index+32768)));
          const data=btoa(parts.join(""));
          const file=isFont?(await invoke<{fontFile:string}>("import_obs_lyrics_font",{name:message.name,data})).fontFile
            :await invoke<string>("import_folia_image",{data});
          reply({file});
        })().catch(error=>reply({error:String(error)}));
      }
    };
    window.addEventListener("message",receive);
    return()=>window.removeEventListener("message",receive);
  },[]);
  useEffect(()=>{invoke<string>("get_obs_lyrics_settings").then(raw=>{if(raw)try{setDraft(loadLyricsSettings(JSON.parse(raw)))}catch{}}).catch(e=>setStatus(`加载失败：${String(e)}`)).finally(()=>setLoaded(true))},[]);
  useEffect(()=>{if(loaded)onReady?.(true)},[loaded,onReady]);
  useEffect(()=>{void checkStyles()},[]);
  useEffect(()=>{frame.current?.contentWindow?.postMessage({type:"obs-preview-settings",settings:draft},"http://127.0.0.1:17842")},[draft,loaded]);
  useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.origin!=="http://127.0.0.1:17842"||event.source!==frame.current?.contentWindow||event.data?.type!=="folia-tuning-defaults"||!event.data.defaults||typeof event.data.defaults!=="object")return;setFoliaDefaults(event.data.defaults)};window.addEventListener("message",receive);return()=>window.removeEventListener("message",receive)},[]);
  const foliaSelected=draft.preset.startsWith("folia-");
  const foliaMode=draft.preset.replace(/^folia-/,"");
  const foliaTuning=draft.foliaTunings?.[foliaMode]??foliaDefaults[foliaMode]??{};
  const foliaEnabled=draft.foliaTuningEnabled?.[foliaMode]!==false;
  async function save(){setSaving(true);try{setDraft(await saveLyricsSettings(draft));setStatus("已保存")}catch(e){setStatus(String(e))}finally{setSaving(false)}}
  function field<K extends keyof Config>(key:K,value:Config[K]){setDraft(v=>{const next={...v,[key]:value};if((styleFields as readonly string[]).includes(key)){const active=styleKey(v),saved={...(v.styleSettings||{})};saved[active]={...(saved[active]||{}),[key]:value};next.styleSettings=saved}return next});setStatus("有未保存的修改")}
  function selectStyle(value:string){
    setDraft(v=>{
      const saved={...(v.styleSettings||{})},previous=styleKey(v);
      saved[previous]=Object.fromEntries(styleFields.map(key=>[key,v[key]])) as NonNullable<Config["styleSettings"]>[string];
      const style=value.startsWith("official:")?pack.styles.find(x=>`official:${x.id}`===value):undefined;
      const target=style?{...v,preset:"classic",customHtmlEnabled:false,officialStyleId:style.id,officialStyleVersion:pack.version,officialCss:style.css}:value.startsWith("official:")?v:{...v,preset:value,customHtmlEnabled:value==="custom-html",officialStyleId:"",officialStyleVersion:"",officialCss:""};
      const key=styleKey(target),restore=saved[key]||{...Object.fromEntries(styleFields.map(field=>[field,initial[field]])),...defaultStyleValues(style?"official":value)};
      return {...target,...restore,styleSettings:saved};
    });
    setStatus("有未保存的修改");
  }
  if(!loaded)return <section className="glass rounded-2xl p-5 text-[12px] text-[var(--ink-3)]" role="status">正在加载歌词设置…</section>;
  const ctl="min-w-0 h-9 rounded-lg border border-[var(--line)] bg-[var(--shade)] px-2.5 text-[12px] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";
  async function importFoliaPreset(file?:File){
    if(!file)return;
    setFoliaPackageBusy(true);
    try {
      const {mode,tuning,appearance,assets,enabled}=await importFoliaPackage(file,foliaMode);
      setDraft(v=>({...v,preset:`folia-${mode}`,foliaAppearance:appearance??v.foliaAppearance,foliaAssets:assets??v.foliaAssets,foliaTunings:{...v.foliaTunings,[mode]:tuning},foliaTuningEnabled:{...v.foliaTuningEnabled,[mode]:enabled}}));
      setStatus("Folia 歌词包已导入，保存后生效");
    } catch(error) {setStatus(`导入失败：${String(error)}`)}
    finally {if(foliaImport.current)foliaImport.current.value="";setFoliaPackageBusy(false)}
  }
  async function exportFoliaPreset(){
    setFoliaPackageBusy(true);
    try {
      const url=URL.createObjectURL(await exportFoliaPackage(draft,foliaMode,foliaTuning,foliaEnabled));
      const link=document.createElement("a");
      link.href=url;link.download=`folia-${foliaMode}.folia`;link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),10000);
      setStatus("Folia 歌词包已导出");
    } catch(error) {setStatus(`导出失败：${String(error)}`)}
    finally {setFoliaPackageBusy(false)}
  }
  const lyricsUrl="http://127.0.0.1:17842/lyrics";
  const previewUrl=`http://127.0.0.1:17842/${foliaSelected?"folia":"lyrics-preview"}`;
  const customHtmlError=validateLyricHtml(draft.customHtml);
  const customFields=draft.customHtmlEnabled&&!customHtmlError?readLyricHtmlSettings(draft.customHtml):[];
  const customPreviewSrc=customHtmlError||!draft.customHtml.trim()?"":buildLyricHtmlDocument(draft.customHtml,draft.customHtmlValues);
  const postCustomPreview=()=>customPreview.current?.contentWindow?.postMessage({type:"rustmusic-lyrics-state",state:{settings:draft.customHtmlValues,current:{text:"让每句歌词都有自己的光",words:[{text:"让每句",progress:100},{text:"歌词",progress:55},{text:"都有自己的光",progress:0}]},translation:"A little light in every line",next:"跟着旋律继续向前",title:"喜欢的旋律",artist:"RustMusic",playing:true,progress:0.55,preset:"custom",motion:true,mode:"current-next"}},"*");
  return <section className="anim-row glass rounded-2xl p-5" style={{["--row-idx" as string]:9}}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-[14px] font-semibold text-[var(--ink)]">OBS 透明歌词</h3><p className="mt-1 text-[11px] leading-relaxed text-[var(--ink-3)]">{foliaSelected?"Folia 使用独立原版渲染链路；OBS 地址保持不变。":"将下方统一地址添加到 OBS 浏览器来源，普通样式和自定义 HTML 在此编辑。"}</p></div>
      <button type="button" className={ctl+" shrink-0"} onClick={()=>{void navigator.clipboard.writeText(lyricsUrl).then(()=>setStatus("地址已复制")).catch(e=>setStatus(String(e)))}}>复制歌词地址</button>
    </div>
    <code className="mt-3 block break-all rounded-lg border border-[var(--line)] bg-[var(--shade)] px-3 py-2.5 text-[11px] text-[var(--ink-2)]">{lyricsUrl}</code>
    {!foliaSelected&&<><div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" className={ctl} onClick={()=>void checkStyles()}>获取官网歌词风格</button>
    </div>
    <label className="mt-3 flex items-start gap-2 text-[12px] text-[var(--ink-2)]"><input className="mt-0.5 accent-[var(--accent)]" type="checkbox" checked={draft.autoUpdateStyles!==false} onChange={e=>field("autoUpdateStyles",e.target.checked)}/><span>自动更新已选官网风格<span className="mt-1 block text-[11px] text-[var(--ink-3)]">启动及使用期间自动检查；自定义歌词 HTML 保持不变。更改后点击保存。</span></span></label></>}
    <div className="mt-5 grid grid-cols-2 gap-3 text-[12px] text-[var(--ink-2)]">
      <div className="min-w-0 space-y-1.5">
        <label className="block">歌词风格<select aria-label="歌词风格" className={ctl+" mt-1.5 block w-full"} value={draft.officialStyleId?`official:${draft.officialStyleId}`:draft.preset} onChange={e=>selectStyle(e.target.value)}>
          <optgroup label="播放器歌词样式">{presets.filter(([key])=>!key.startsWith("folia-")).map(([k,n])=><option key={k} value={k}>{n}</option>)}</optgroup>
          <optgroup label="Folia 原版效果">{presets.filter(([key])=>key.startsWith("folia-")).map(([k,n])=><option key={k} value={k}>{n}</option>)}</optgroup>
          <optgroup label="自定义 HTML"><option value="custom-html">自定义 HTML</option></optgroup>
          {draft.officialStyleId&&!pack.styles.some(x=>x.id===draft.officialStyleId)&&<optgroup label="官网歌词样式"><option value={`official:${draft.officialStyleId}`}>已保存的官网风格</option></optgroup>}
          {pack.styles.length>0&&<optgroup label="官网歌词样式">{pack.styles.map(x=><option key={`official:${x.id}`} value={`official:${x.id}`}>{x.name} · 官网</option>)}</optgroup>}
        </select></label>
        {!foliaSelected&&<button type="button" className={`${ctl} w-full`} onClick={()=>{setDraft(v=>({...v,preset:"custom-html",customHtmlEnabled:true,officialStyleId:"",officialStyleVersion:"",officialCss:"",customHtml:v.customHtml.trim()?v.customHtml:lyricHtmlExample}));setStatus("自定义歌词样式已新建，检查预览后保存设置")}}>新建歌词样式</button>}
      </div>
      {!foliaSelected&&<>
      <label className="min-w-0 space-y-1.5">显示方式<select className={ctl+" block w-full"} value={draft.mode} onChange={e=>field("mode",e.target.value)}><option value="current">当前句</option><option value="current-next">当前句＋下一句</option><option value="multi">滚动多行</option></select></label>
      </>}
      <label className="min-w-0 space-y-1.5">歌词副行<select aria-label="网页歌词副行" className={ctl+" block w-full"} value={lyricsAltMode} onChange={e=>setLyricsAltMode(e.target.value==="romanization"?"romanization":"translation")}><option value="translation">翻译歌词</option><option value="romanization">音译歌词</option></select></label>
      {!foliaSelected&&<>
      <label className="min-w-0 space-y-1.5">歌词时间轴<select aria-label="歌词时间轴" className={ctl+" block w-full"} value={draft.lyricTimeline} onChange={e=>field("lyricTimeline",e.target.value as Config["lyricTimeline"])}><option value="original">原歌词时间轴</option><option value="split">切分时间轴</option></select></label>
      <label className="col-span-2 min-w-0 space-y-1.5">歌词互动挂件<select aria-label="歌词互动挂件" className={ctl+" block w-full"} value={draft.widget} onChange={e=>field("widget",e.target.value)}>{widgets.map(([k,n])=><option key={k} value={k}>{n}</option>)}</select></label>
      </>}
    </div>
    {foliaSelected?<div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h4 className="text-[12px] font-semibold text-[var(--ink)]">Folia 歌词样式设置</h4><p className="mt-1 text-[10px] text-[var(--ink-3)]">关闭自定义动画时，当前样式使用原版动画参数。</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`${ctl} inline-flex items-center gap-2`}><input type="checkbox" role="switch" className="accent-[var(--accent)]" checked={foliaEnabled} onChange={e=>field("foliaTuningEnabled",{...draft.foliaTuningEnabled,[foliaMode]:e.currentTarget.checked})}/>自定义动画</label>
          <button type="button" className={ctl} aria-expanded={foliaExpanded} aria-controls="folia-tuning-panel" onClick={()=>setFoliaExpanded(value=>!value)}>{foliaExpanded?"收起设置":"展开设置"}</button>
        </div>
      </div>
      {foliaExpanded&&<div id="folia-tuning-panel" className="mt-3 border-t border-[var(--line)] pt-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={ctl} disabled={foliaPackageBusy} onClick={()=>foliaImport.current?.click()}>导入歌词包</button>
          <button type="button" className={ctl} disabled={foliaPackageBusy} onClick={exportFoliaPreset}>导出歌词包</button>
          <input ref={foliaImport} type="file" accept=".folia,.json,application/json" className="hidden" aria-label="导入 Folia 歌词包" onChange={e=>void importFoliaPreset(e.currentTarget.files?.[0])}/>
        </div>
        <iframe ref={foliaPanel} title="Folia 歌词样式设置" src="http://127.0.0.1:17842/folia#settings"
          onLoad={syncFoliaPanel} className="mt-2 block w-full border-0" style={{height:foliaHeight}} />
      </div>}
    </div>:<>
    {draft.customHtmlEnabled&&<div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <label htmlFor="settings-custom-lyric-html" className="block text-[12px] font-medium text-[var(--ink-2)]">歌词 HTML</label>
      <textarea id="settings-custom-lyric-html" aria-label="自定义歌词 HTML" disabled={saving} value={draft.customHtml} maxLength={12000} spellCheck={false} onChange={e=>field("customHtml",e.target.value)} placeholder={lyricHtmlExample} className="mt-2 block h-56 min-h-36 max-h-96 w-full min-w-0 resize-y rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3 font-mono text-[11px] leading-5 text-[var(--ink)] disabled:opacity-50" />
      <p role="status" className={`mt-2 min-h-5 break-words text-[11px] leading-5 ${customHtmlError?"text-red-500":"text-[var(--ink-3)]"}`}>{customHtmlError||"支持完整 HTML、CSS、JavaScript 和 HTTPS 外部资源；歌词插槽使用 data-rustmusic-slot 字段。修改会即时预览，保存设置后应用到 OBS 歌词。"}</p>
      {customFields.length>0&&<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {customFields.map(setting=><label key={setting.id} className="min-w-0 text-[11px] text-[var(--ink-2)]">{setting.label}
          {setting.type==="color"
            ? <input aria-label={setting.label} type="color" className={ctl+" mt-1.5 block w-full !p-1"} value={String(draft.customHtmlValues[setting.id]??setting.defaultValue)} onChange={e=>field("customHtmlValues",{...draft.customHtmlValues,[setting.id]:e.target.value})}/>
            : <><span className="float-right text-[var(--ink-3)]">{draft.customHtmlValues[setting.id]??setting.defaultValue}</span><input aria-label={setting.label} type="range" className="mt-2 w-full accent-[var(--accent)]" min={setting.min} max={setting.max} step={setting.step} value={Number(draft.customHtmlValues[setting.id]??setting.defaultValue)} onChange={e=>field("customHtmlValues",{...draft.customHtmlValues,[setting.id]:+e.target.value})}/></>}
        </label>)}
      </div>}
      <div className="mt-3 overflow-hidden rounded-lg border border-[var(--line)]" style={{backgroundColor:"#202127",backgroundImage:"conic-gradient(#2b2c33 25%,transparent 0 50%,#2b2c33 0 75%,transparent 0)",backgroundSize:"20px 20px"}}>
        <iframe ref={customPreview} title="自定义歌词样式预览" sandbox="allow-scripts" srcDoc={customPreviewSrc} onLoad={postCustomPreview} className="block h-56 w-full border-0" />
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-[var(--ink-3)]">预览使用示例歌词；实际网页歌词会自动同步当前歌曲、逐字进度、译文或音译。</p>
    </div>}
    <LyricHtmlGuide />
    {draft.widget==="bounce"&&<div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <div className="grid grid-cols-2 gap-3 text-[11px] text-[var(--ink-2)] sm:grid-cols-3">
        <label className="min-w-0 space-y-1.5">弹跳拖尾<select aria-label="弹跳拖尾类型" className={ctl+" block w-full"} value={draft.bounceTrailType} onChange={e=>field("bounceTrailType",e.target.value as Config["bounceTrailType"])}><option value="none">关闭拖尾</option><option value="double">双线交替</option><option value="single">单线</option><option value="particles">粒子</option></select></label>
        <label className="min-w-0">拖尾时间 · {draft.bounceTrailDuration} ms<input aria-label="拖尾时间" className="mt-2 w-full accent-[var(--accent)]" type="range" min="100" max="3000" step="50" value={draft.bounceTrailDuration} onChange={e=>field("bounceTrailDuration",+e.target.value)}/></label>
        <label className="min-w-0">拖尾长度 · {draft.bounceTrailLength} px<input aria-label="拖尾长度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="500" step="5" value={draft.bounceTrailLength} disabled={draft.bounceTrailType==="none"} onChange={e=>field("bounceTrailLength",+e.target.value)}/></label>
      </div>
    </div>}
    <label className="mt-3 flex w-fit items-center gap-2 text-[12px] text-[var(--ink-2)]"><input className="accent-[var(--accent)]" type="checkbox" checked={draft.motion} onChange={e=>field("motion",e.target.checked)}/> 装饰动效</label>
    <label className="mt-3 flex w-fit items-center gap-2 text-[12px] text-[var(--ink-2)]"><input aria-label="粒子溶解装饰" className="accent-[var(--accent)]" type="checkbox" checked={draft.particleDissolve} onChange={e=>field("particleDissolve",e.target.checked)}/> 粒子溶解装饰（叠加到当前歌词风格）</label>
    {draft.particleDissolve&&<div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <div className="text-[12px] font-semibold text-[var(--ink)]">粒子溶解装饰</div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 text-[11px] text-[var(--ink-2)] sm:grid-cols-3 [&_input]:mt-1.5">
        <label>粒子大小（px）<input aria-label="粒子大小" className={ctl+" w-full"} type="number" min="0.2" max="20" step="0.1" value={draft.particleSize} onChange={e=>field("particleSize",+e.target.value)}/></label>
        <label>粒子颜色<input aria-label="粒子颜色" className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.particleColor} onChange={e=>field("particleColor",e.target.value)}/></label>
        <label className="flex items-center gap-2 self-end pb-2"><input aria-label="粒子发光" className="accent-[var(--accent)]" type="checkbox" checked={draft.particleGlow} onChange={e=>field("particleGlow",e.target.checked)}/> 粒子发光</label>
        <label className="col-span-2 sm:col-span-3">辉光强度 · {draft.particleGlowStrength}%（效果 ×10）<input aria-label="粒子辉光强度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="100" step="1" value={draft.particleGlowStrength} disabled={!draft.particleGlow} onChange={e=>field("particleGlowStrength",+e.target.value)}/></label>
        <label className="col-span-2 sm:col-span-3">粒子颜色强度 · {draft.particleColorIntensity.toFixed(1)}×<input aria-label="粒子颜色强度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="10" step="0.1" value={draft.particleColorIntensity} onChange={e=>field("particleColorIntensity",+e.target.value)}/></label>
        <label className="col-span-2 sm:col-span-3">溶解碎度 · {draft.particleFragmentation}%（低：整齐，高：碎裂）<input aria-label="溶解碎度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="100" step="1" value={draft.particleFragmentation} onChange={e=>field("particleFragmentation",+e.target.value)}/></label>
        <label className="col-span-2 flex items-center gap-2 sm:col-span-3"><input aria-label="溶解边缘高亮" className="accent-[var(--accent)]" type="checkbox" checked={draft.particleEdgeHighlight} onChange={e=>field("particleEdgeHighlight",e.target.checked)}/> 溶解边缘高亮</label>
        <label className="col-span-2 flex items-center gap-2 sm:col-span-3"><input aria-label="HDR 风格高亮" className="accent-[var(--accent)]" type="checkbox" checked={draft.particleHdr} onChange={e=>field("particleHdr",e.target.checked)}/> HDR 风格高亮色</label>
        <label>每字粒子数<input aria-label="每字粒子数" className={ctl+" w-full"} type="number" min="1" max="100" step="1" value={draft.particleCount} onChange={e=>field("particleCount",+e.target.value)}/></label>
        <label>粒子寿命（ms）<input aria-label="粒子寿命" className={ctl+" w-full"} type="number" min="200" max="3000" step="50" value={draft.particleLifetime} onChange={e=>field("particleLifetime",+e.target.value)}/></label>
        <label>扰动速度（×）<input aria-label="扰动速度" className={ctl+" w-full"} type="number" min="0.5" max="2.5" step="0.1" value={draft.particleSpeed} onChange={e=>field("particleSpeed",+e.target.value)}/></label>
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-[var(--ink-3)]">HDR 风格通过叠加发光增强亮部；实际亮度受 OBS 与显示设备影响。</p>
    </div>}
    <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <label className="block text-[11px] text-[var(--ink-2)]">歌词文字 HDR 辉光 · {draft.lyricGlowStrength.toFixed(1)}×<input aria-label="歌词辉光强度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="10" step="0.1" value={draft.lyricGlowStrength} onChange={e=>field("lyricGlowStrength",+e.target.value)}/></label>
    </div>
    <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--shade)] p-3">
      <label className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[var(--ink)]"><input aria-label="启用原始效果自定义" className="accent-[var(--accent)]" type="checkbox" checked={draft.rawEffectsEnabled} onChange={e=>field("rawEffectsEnabled",e.target.checked)}/> 原始效果自定义</label>
      <div className="grid grid-cols-2 gap-3 text-[11px] text-[var(--ink-2)] sm:grid-cols-3">
        <label>投影色<input aria-label="原始投影色" className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.rawShadow} onChange={e=>field("rawShadow",e.target.value)}/></label>
        <label>高光色<input aria-label="原始高光色" className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.rawAccent} onChange={e=>field("rawAccent",e.target.value)}/></label>
        <label>辉光色<input aria-label="原始辉光色" className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.rawGlow} onChange={e=>field("rawGlow",e.target.value)}/></label>
        <label>描边色<input aria-label="原始描边色" className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.rawStroke} onChange={e=>field("rawStroke",e.target.value)}/></label>
        <label>描边宽度 · {draft.rawStrokeWidth.toFixed(1)} px<input aria-label="原始描边宽度" className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="8" step="0.1" value={draft.rawStrokeWidth} onChange={e=>field("rawStrokeWidth",+e.target.value)}/></label>
      </div>
      <p className="mt-2 text-[10px] text-[var(--ink-3)]">设置独立保存到当前歌词风格；关闭时保留该风格的原始外观。</p>
    </div>
    <div className="mt-5 border-t border-[var(--line)] pt-4 text-[12px] font-semibold text-[var(--ink)]">文字与排版 <span className="font-normal text-[var(--ink-3)]">· 独立设置当前歌词风格</span></div>
    <div className="mt-3"><LyricsFontPicker value={draft} disabled={saving} onChange={font=>{setDraft(v=>{const key=styleKey(v),styleSettings={...(v.styleSettings||{})};styleSettings[key]={...(styleSettings[key]||{}),...font};return {...v,...font,styleSettings}});setStatus("字体已更新，点击保存设置后用于网页与 OBS")}} /></div>
    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 text-[11px] text-[var(--ink-2)] xl:grid-cols-4 [&_label]:min-w-0 [&_input]:mt-1.5 [&_select]:mt-1.5">
      <label>字号 <input className={ctl+" w-full"} type="number" min="12" max="120" value={draft.size} onChange={e=>field("size",+e.target.value)}/></label><label>宽度 <input className={ctl+" w-full"} type="number" min="240" max="3000" value={draft.width} onChange={e=>field("width",+e.target.value)}/></label><label>字重 <select className={ctl+" w-full"} value={draft.weight} onChange={e=>field("weight",+e.target.value)}>{[400,600,700,800].map(x=><option key={x}>{x}</option>)}</select></label><label>对齐 <select className={ctl+" w-full"} value={draft.align} onChange={e=>field("align",e.target.value)}>{[["left","左对齐"],["center","居中"],["right","右对齐"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>系统／回退字体 <input className={ctl+" w-full"} value={draft.font} onChange={e=>field("font",e.target.value)}/></label><label>文字色 <input className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.color} onChange={e=>field("color",e.target.value)}/></label><label>描边色 <input className={ctl+" mt-1.5 w-full !p-1"} type="color" value={draft.stroke} onChange={e=>field("stroke",e.target.value)}/></label><label>描边宽度 <input className={ctl+" w-full"} type="number" min="0" max="8" step="0.5" value={draft.strokeWidth} onChange={e=>field("strokeWidth",+e.target.value)}/></label>
      <label>行距 <input className={ctl+" w-full"} type="number" min="1" max="3" step=".05" value={draft.lineHeight} onChange={e=>field("lineHeight",+e.target.value)}/></label><label>字距 <input className={ctl+" w-full"} type="number" min="-2" max="20" step=".5" value={draft.letterSpacing} onChange={e=>field("letterSpacing",+e.target.value)}/></label><label>翻译字号 <input className={ctl+" w-full"} type="number" min="10" max="80" value={draft.translationSize} onChange={e=>field("translationSize",+e.target.value)}/></label><label>显示行数 <input className={ctl+" w-full"} type="number" min="1" max="8" value={draft.rows} onChange={e=>field("rows",+e.target.value)}/></label>
      <label>阴影 <input className={ctl+" w-full"} value={draft.shadow} onChange={e=>field("shadow",e.target.value)}/></label><label>垂直偏移 <input className={ctl+" w-full"} type="number" min="-500" max="500" value={draft.offsetY} onChange={e=>field("offsetY",+e.target.value)}/></label>
    </div>
    </>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[11px] leading-5 text-[var(--ink-3)]"><span className="font-semibold text-[var(--ink-2)]">{foliaSelected?"Folia 原版预览":"实时预览"}</span><span>跟随当前歌曲 · 当前歌词风格立即预览</span></div>
    <div className="mt-2 overflow-hidden rounded-xl border border-[var(--line)]" style={{backgroundColor:"#202127",backgroundImage:"conic-gradient(#2b2c33 25%,transparent 0 50%,#2b2c33 0 75%,transparent 0)",backgroundSize:"20px 20px"}}>
      <iframe key={foliaSelected?"folia":"lyrics"} ref={frame} title={foliaSelected?"Folia 原版歌词预览":"OBS 歌词预览"} src={previewUrl} onLoad={()=>frame.current?.contentWindow?.postMessage({type:"obs-preview-settings",settings:draft},"http://127.0.0.1:17842")} className="block h-72 w-full border-0" />
    </div>
    <p className="mt-2 text-[10px] leading-relaxed text-[var(--ink-3)]">透明网格仅用于预览；没有播放歌曲或当前没有歌词时，此处保持空白。</p>
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
      <button type="button" disabled={saving} className={ctl+" !border-transparent !bg-[var(--accent)] !text-[var(--accent-on)] font-medium"} onClick={save}>{saving?"保存中…":"保存设置"}</button>
      <button type="button" className={ctl} onClick={()=>{if(window.confirm("确定重置歌词样式和自定义歌词 HTML？此操作会覆盖当前设置。")){setDraft({...initial});setStatus("重置待保存")}}}>重置…</button>
      <span role="status" className="min-w-0 break-words text-[11px] text-[var(--ink-3)]">{status}</span>
    </div>
  </section>;
}
