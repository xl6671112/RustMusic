import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, RotateCcw, Search, Shuffle, Unlock, Upload } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import J from "../../jizura-overlay/dist/native-engine.mjs";
import { initialJizuraSettings, type JizuraSettings as Settings } from "../jizuraSettings";

type Item={id:string;label:string;desc?:string;set?:string;extra?:boolean;wa?:boolean;special?:boolean};
type Group={id:string;label:string;items:Item[]};
type Font={key:string;label:string;family:string;weight:number};
type LineOverride={cuts?:number;layout?:string;seed?:number;lock?:boolean;lockedSeed?:number;lockedCuts?:unknown;cutTech?:Record<string,Record<string,string>>;cutQuiet?:Record<string,Record<string,boolean>>;cutLayouts?:Record<string,string>;[key:string]:unknown};
type Project=Record<string,unknown>&{
  style:string;mood:string|null;seed:number;fx:Record<string,string|number|boolean>;
  enabled:Record<string,Record<string,boolean>>;locks:{tech:Record<string,boolean>;params:Record<string,boolean>};
  colors:Record<string,string|boolean>;fonts:Record<string,string>;userFonts?:Font[];overrides:Record<string,LineOverride>;
};
type Catalog={defaults:Project;groups:Group[];styles:(Item&{schemes:Record<string,string>[]})[];fonts:Item[];moods:(Item&{fx:Record<string,[number,number]>})[];sets:(Item&{on:boolean})[];themes:Item[]};
type State={trackKey:string;title?:string;artist?:string;positionMs:number;durationMs?:number;lyricOffsetMs?:number;lyrics?:{synced?:boolean;lines:{timeMs:number|null;text:string}[]}};
const origin="http://127.0.0.1:17842";
const control="h-9 min-w-0 w-full rounded-md border border-[var(--line)] bg-[var(--shade)] px-2 text-[12px] text-[var(--ink)]";
const tool="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--shade)] px-2 text-[11px] text-[var(--ink)] disabled:opacity-40";
const fxFields=[["motion","动态强度"],["glitch","故障强度"],["chroma","色彩错位"],["decor","装饰数量"],["density","切镜密度"],["texture","纹理强度"],["bgSwitch","背景切换"]] as const;
const tabs=[["animation","歌词动画"],["techniques","效果组合"],["colors","配色"],["fonts","字体"],["global","全局"],["lines","逐行组合"]] as const;
const asRecord=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
function mergeProject(defaults:Project,saved?:Record<string,unknown>):Project {
  const result={...defaults,...saved,lyrics:""} as Project;
  for(const key of ["fx","enabled","colors","fonts","overrides"] as const)result[key]={...asRecord(defaults[key]),...asRecord(saved?.[key])} as never;
  result.enabled={...result.enabled,...Object.fromEntries(Object.entries(defaults.enabled).map(([group,items])=>[group,{...items,...result.enabled[group]}]))};
  const locks=asRecord(saved?.locks);
  result.locks={tech:{...asRecord(locks.tech)} as Record<string,boolean>,params:{...asRecord(locks.params)} as Record<string,boolean>};
  return result;
}
function Field({label,children}:{label:string;children:React.ReactNode}){
  return <label className="flex min-w-0 flex-col gap-1.5 text-[11px] text-[var(--ink-2)]"><span>{label}</span>{children}</label>;
}
function Toggle({label,value,onChange}:{label:string;value:boolean;onChange:(value:boolean)=>void}){
  return <label className="inline-flex items-center gap-2 text-[12px] text-[var(--ink)]"><input type="checkbox" aria-label={label} checked={value} onChange={event=>onChange(event.currentTarget.checked)} className="accent-[var(--accent)]"/>{label}</label>;
}
function LockButton({label,locked,onClick}:{label:string;locked:boolean;onClick:()=>void}){
  return <button type="button" title={label} aria-label={label} aria-pressed={locked} className={tool+" w-8 !px-0 "+(locked?"text-[var(--accent)]":"")} onClick={onClick}>{locked?<Lock size={14}/>:<Unlock size={14}/>}</button>;
}

export default function JizuraSettings({value,onChange}:{value?:Settings;onChange:(value:Settings)=>void}){
  const [catalog,setCatalog]=useState<Catalog|null>(null),[state,setState]=useState<State|null>(null);
  const [tab,setTab]=useState("animation"),[groupId,setGroupId]=useState("layout"),[query,setQuery]=useState("");
  const [selectedLine,setSelectedLine]=useState("current"),[selectedCut,setSelectedCut]=useState(0),[localFont,setLocalFont]=useState("");
  const [error,setError]=useState(""),[fontBusy,setFontBusy]=useState(false);
  const [fontVersion,setFontVersion]=useState(0);
  const fontInput=useRef<HTMLInputElement>(null);
  const settings=value??initialJizuraSettings;
  const latest=useRef(settings),registeredFonts=useRef("");
  const loadedFonts=useRef(new Set<string>());
  latest.current=settings;
  const project=useMemo(()=>catalog?mergeProject(catalog.defaults,settings.project):null,[catalog,settings.project]);
  useEffect(()=>{
    const abort=new AbortController();
    fetch(origin+"/jizura-assets/catalog.json",{signal:abort.signal,cache:"no-store"}).then(response=>{if(!response.ok)throw new Error("JIZURA 设置加载失败");return response.json()}).then(setCatalog).catch(reason=>{if(!abort.signal.aborted)setError(String(reason))});
    return()=>abort.abort();
  },[]);
  useEffect(()=>{
    let cancelled=false;
    for(const font of project?.userFonts||[]){
      const file=settings.fontFiles?.[font.key];
      if(!file||!/^[a-f0-9]{64}\.(ttf|otf|woff|woff2)$/i.test(file)||loadedFonts.current.has(file))continue;
      const face=new FontFace(J.safeFamily(font.family),`url("${origin}/fonts/${file}")`);
      face.load().then(loaded=>{if(!cancelled){loadedFonts.current.add(file);document.fonts.add(loaded);J.glyphs.clear();J.metrics.clear();setFontVersion(version=>version+1)}})
        .catch(reason=>{loadedFonts.current.delete(file);if(!cancelled)setError("字体加载失败："+String(reason))});
    }
    return()=>{cancelled=true};
  },[project?.userFonts,settings.fontFiles]);
  useEffect(()=>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{const response=await fetch(origin+"/state",{signal:abort.signal,cache:"no-store"});if(response.ok)setState(await response.json())}
      catch(reason){if(!abort.signal.aborted)setError("读取当前歌词失败："+String(reason))}
      if(!abort.signal.aborted)timer=setTimeout(refresh,700);
    };
    void refresh();return()=>{abort.abort();clearTimeout(timer)};
  },[]);
  const planned=useMemo(()=>{
    if(tab!=="lines"||!project||!state?.lyrics?.lines?.length)return {plan:null,error:""};
    try{
      const source={...project,overrides:settings.lineEffectsTrackKey===state.trackKey?project.overrides:{}};
      const signature=JSON.stringify(project.userFonts||[]);
      if(signature!==registeredFonts.current){
        for(const font of project.userFonts||[])J.addUserFont(font.key,font.label,font.family,font.weight,"custom");
        registeredFonts.current=signature;
      }
      const native=J.RustMusic.projectForState(source,state);
      return {plan:J.plan(native,{duration:(state.durationMs||0)/1000}),error:""};
    }catch(reason){return {plan:null,error:"当前歌词镜头生成失败："+String(reason)}}
  },[tab,project,state?.trackKey,state?.lyrics,state?.durationMs,settings.lineEffectsTrackKey,fontVersion]);
  const plan=planned.plan;
  if(!catalog||!project)return <div className="mt-4 text-[12px] text-[var(--ink-2)]" role="status">{error||"正在加载 JIZURA 设置…"}</div>;
  const update=(patch:Partial<Project>,outer:Partial<Settings>={})=>onChange({...settings,...outer,project:{...project,...patch}});
  const fx=(key:string,next:string|number|boolean)=>update({fx:{...project.fx,[key]:next},mood:null});
  const group=catalog.groups.find(item=>item.id===groupId)||catalog.groups[0];
  const visible=group.items.filter(item=>!query||[item.label,item.id,item.desc].join(" ").toLowerCase().includes(query.toLowerCase()));
  const selected=project.enabled[group.id]||{};
  const setItems=(ids:string[],mode:"on"|"off"|"invert")=>update({enabled:{...project.enabled,[group.id]:{...selected,...Object.fromEntries(ids.map(id=>[id,mode==="invert"?selected[id]===false:mode==="on"]))}}});
  const paramLock=(key:string)=>update({locks:{...project.locks,params:{...project.locks.params,[key]:!project.locks.params[key]}}});
  const select=(label:string,key:string,options:(string|[string,string])[],numeric=false)=><Field label={label}><select className={control} aria-label={label} value={String(project[key]??"")} onChange={event=>update({[key]:numeric?Number(event.currentTarget.value):event.currentTarget.value})}>{options.map(option=>{const [id,name]=Array.isArray(option)?option:[option,option];return <option key={id} value={id}>{name}</option>})}</select></Field>;
  const keepLocks=(next:Partial<Project>)=>{
    if(next.enabled)for(const key of Object.keys(project.locks.tech))if(project.locks.tech[key])next.enabled[key]=project.enabled[key];
    if(next.fx)for(const key of Object.keys(project.locks.params))if(project.locks.params[key]){
      next.fx[key]=key==="koma"?(project.fx.koma??(project.fx.onTwos===false?0:12)):key==="flash"?!!project.fx.flash:project.fx[key];
      if(key==="koma")next.fx.onTwos=Number(next.fx.koma)>0;
    }
    return next;
  };
  const randomize=()=>update(keepLocks(J.omakase(project,Math.random,typeof project.themeId==="string"?project.themeId:null) as Partial<Project>));
  const applyMood=(id:string)=>{
    const mood=catalog.moods.find(item=>item.id===id);
    const nextFx={...project.fx};
    if(mood)for(const [key,[min,max]] of Object.entries(mood.fx))if(!project.locks.params[key])nextFx[key]=Math.round((min+Math.random()*(max-min))*100)/100;
    update({mood:id||null,fx:nextFx});
  };
  const lines:{text:string;start:number}[]=plan?.lines||[];
  const lyricPosition=Math.max(0,(state?.positionMs||0)+(state?.lyricOffsetMs||0));
  let currentLine=0;
  for(let index=0;index<lines.length;index++)if(lines[index].start*1000<=lyricPosition)currentLine=index;
  const lineIndex=selectedLine==="current"?currentLine:Math.min(Number(selectedLine),Math.max(0,lines.length-1));
  const lineScope=settings.lineEffectsTrackKey===state?.trackKey;
  const override=(lineScope?project.overrides[lineIndex]:undefined)||{};
  const lineUpdate=(patch:Partial<LineOverride>)=>{
    if(!state?.trackKey)return;
    const next={...override,...patch};
    for(const key of Object.keys(next))if(next[key]===undefined||next[key]===false||next[key]==="")delete next[key];
    update({overrides:{...(lineScope?project.overrides:{}),[lineIndex]:next}},{lineEffectsTrackKey:state.trackKey});
  };
  const cuts=(plan?.cuts||[]).filter((cut:{line:number;utext?:string})=>cut.line===lineIndex&&cut.utext!=null);
  const cutIndex=Math.min(selectedCut,Math.max(0,(Number(override.cuts)||cuts.length||1)-1));
  const cutTech=override.cutTech?.[cutIndex]||{};
  const cutQuiet=override.cutQuiet?.[cutIndex]||{};
  const toggleCutLock=(id:string)=>{
    if(cutTech[id]){updateCut(id,"");return}
    const active=cuts[cutIndex];
    const key=id==="decor"?(active?.decor?.[0]?.id||"none"):active?.[id]||(["trans","bg","treat"].includes(id)?"none":"");
    if(key)updateCut(id,key);
  };
  const updateCut=(id:string,next:string)=>{
    const cutSlots={...override.cutTech,[cutIndex]:{...cutTech,[id]:next}};
    const quietSlots={...override.cutQuiet,[cutIndex]:{...cutQuiet,[id]:false}};
    const patch:Partial<LineOverride>={cutTech:cutSlots,cutQuiet:quietSlots,lock:false,lockedCuts:undefined,lockedSeed:undefined};
    if(id==="layout")patch.cutLayouts={...override.cutLayouts,[cutIndex]:next};
    lineUpdate(patch);
  };
  const toggleLineLock=()=>{
    if(override.lock){lineUpdate({lock:false,lockedSeed:undefined,lockedCuts:undefined});return}
    if(!plan?.lines?.[lineIndex]){setError("当前歌词尚未生成镜头，请稍后重试");return}
    lineUpdate({lock:true,lockedSeed:plan.lines[lineIndex].seed,lockedCuts:J.lineSnapshot(plan,lineIndex)});
  };
  const importFont=async(file:File)=>{
    setFontBusy(true);setError("");
    try{
      if(!file.size||file.size>20*1024*1024)throw new Error("字体文件最大 20 MB");
      const bytes=new Uint8Array(await file.arrayBuffer()),parts:string[]=[];
      for(let index=0;index<bytes.length;index+=32768)parts.push(String.fromCharCode(...bytes.subarray(index,index+32768)));
      const imported=await invoke<{fontFile:string}>("import_obs_lyrics_font",{name:file.name,data:btoa(parts.join(""))});
      const label=file.name.replace(/\.[^.]+$/,""),family="UF_"+label.replace(/[^\w]/g,"_").slice(0,60),key="user_"+family;
      const entry={key,label:label.slice(0,80),family,weight:400};
      const face=new FontFace(family,bytes.buffer);document.fonts.add(await face.load());
      const active=latest.current,activeProject=mergeProject(catalog.defaults,active.project);
      onChange({...active,fontFiles:{...active.fontFiles,[key]:imported.fontFile},project:{...activeProject,fonts:{...activeProject.fonts,display:key},userFonts:[...(activeProject.userFonts||[]).filter(item=>item.key!==key),entry]}});
    }catch(reason){setError("字体导入失败："+String(reason))}
    finally{setFontBusy(false);if(fontInput.current)fontInput.current.value=""}
  };
  const addLocalFont=()=>{
    const family=localFont.trim();if(!family)return;
    const key="user_local_"+Array.from(new TextEncoder().encode(family)).map(byte=>byte.toString(16)).join("").slice(0,60);
    const entry={key,label:family,family,weight:/bold|太|black|heavy|w[6-9]|[6-9]00/i.test(family)?700:400};
    update({fonts:{...project.fonts,display:key},userFonts:[...(project.userFonts||[]).filter(item=>item.key!==key),entry]});
    setLocalFont("");
  };
  const swatch=catalog.styles.find(item=>item.id===project.style)?.schemes?.[0]||{};
  return <div className="mt-4 min-w-0 border-t border-[var(--line)] pt-4" data-jizura-settings>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h4 className="text-[12px] font-semibold text-[var(--ink)]">JIZURA 歌词设置</h4>
      <Toggle label="JIZURA 透明背景" value={settings.transparent} onChange={transparent=>onChange({...settings,transparent})}/>
    </div>
    {(error||planned.error)&&<p role="alert" className="mt-2 text-[12px] text-red-500">{error||planned.error}</p>}
    <div role="tablist" aria-label="JIZURA 设置分类" className="my-4 flex flex-wrap gap-1 border-b border-[var(--line)] pb-2">{tabs.map(([id,label])=><button type="button" key={id} role="tab" aria-selected={tab===id} aria-controls={"jizura-"+id} onClick={()=>setTab(id)} className={"rounded-md px-3 py-2 text-[12px] "+(tab===id?"bg-[var(--shade)] text-[var(--accent)]":"text-[var(--ink-2)]")}>{label}</button>)}</div>
    <div role="tabpanel" id={"jizura-"+tab} className="min-w-0">
      {tab==="animation"&&<div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{fxFields.map(([key,label])=><div key={key} className="flex min-w-0 items-center gap-2"><label className="min-w-0 flex-1 text-[11px] text-[var(--ink-2)]"><span className="flex justify-between"><span>{label}</span><output>{Math.round(Number(project.fx[key])*100)}%</output></span><input className="mt-2 w-full accent-[var(--accent)]" type="range" min={0} max={1} step={.01} aria-label={"JIZURA "+label} data-jizura-fx={key} value={Number(project.fx[key])} onChange={event=>fx(key,Number(event.currentTarget.value))}/></label><LockButton label={"锁定"+label} locked={!!project.locks.params[key]} onClick={()=>paramLock(key)}/></div>)}</div>
        <div className="flex flex-wrap items-center gap-4"><Toggle label="闪光效果" value={!!project.fx.flash} onChange={next=>fx("flash",next)}/><LockButton label="锁定闪光效果" locked={!!project.locks.params.flash} onClick={()=>paramLock("flash")}/><Toggle label="隐藏装饰编号" value={!!project.fx.hideNo} onChange={next=>fx("hideNo",next)}/><Toggle label="隐藏装饰时间" value={!!project.fx.hideTime} onChange={next=>fx("hideTime",next)}/></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label="动画步进"><div className="flex gap-2"><select className={control} aria-label="动画步进" value={String(project.fx.koma??12)} onChange={event=>update({fx:{...project.fx,koma:Number(event.currentTarget.value),onTwos:Number(event.currentTarget.value)>0}})}><option value="0">每输出帧</option><option value="12">每秒 12 张</option><option value="8">每秒 8 张</option></select><LockButton label="锁定动画步进" locked={!!project.locks.params.koma} onClick={()=>paramLock("koma")}/></div></Field><Field label="HUD"><select className={control} aria-label="JIZURA HUD" value={String(project.fx.hud||"auto")} onChange={event=>fx("hud",event.currentTarget.value)}><option value="auto">跟随风格</option><option value="on">显示</option><option value="off">隐藏</option></select></Field><Field label="氛围"><select className={control} aria-label="JIZURA 氛围" value={project.mood||""} onChange={event=>applyMood(event.currentTarget.value)}><option value="">自定义</option>{catalog.moods.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Field></div>
      </div>}
      {tab==="techniques"&&<div className="space-y-4">
        <div className="flex flex-wrap gap-x-5 gap-y-3">{[{id:"extra",label:"新增特效"},{id:"wa",label:"和风"},...catalog.sets].map(item=><Toggle key={item.id} label={item.label} value={!!project[item.id]} onChange={next=>update({[item.id]:next})}/>)}</div>
        <div className="flex flex-wrap items-center gap-2"><select className={control+" !w-auto max-w-full"} aria-label="JIZURA 效果分组" value={group.id} onChange={event=>setGroupId(event.currentTarget.value)}>{catalog.groups.map(item=><option key={item.id} value={item.id}>{item.label} · {item.items.length}</option>)}</select><div className="flex min-w-32 flex-1 items-center gap-2"><Search size={15} className="text-[var(--ink-2)]"/><input className={control} type="search" aria-label="搜索 JIZURA 效果" placeholder="搜索效果" value={query} onChange={event=>setQuery(event.currentTarget.value)}/></div><LockButton label={"锁定"+group.label+"候选"} locked={!!project.locks.tech[group.id]} onClick={()=>update({locks:{...project.locks,tech:{...project.locks.tech,[group.id]:!project.locks.tech[group.id]}}})}/></div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ink-2)]"><span className="mr-auto">{group.items.filter(item=>selected[item.id]!==false).length} / {group.items.length} 已启用</span><button type="button" className={tool} onClick={()=>setItems(visible.map(item=>item.id),"on")}>全选</button><button type="button" className={tool} onClick={()=>setItems(visible.map(item=>item.id),"off")}>全部禁用</button><button type="button" className={tool} onClick={()=>setItems(visible.map(item=>item.id),"invert")}>反选</button></div>
        <div className="grid max-h-[360px] grid-cols-1 gap-x-4 overflow-y-auto border-y border-[var(--line)] sm:grid-cols-2 lg:grid-cols-3" data-jizura-group={group.id}>{visible.map(item=><label key={item.id} title={item.desc||item.id} className="flex min-w-0 items-center gap-2 border-b border-[var(--line)] py-2 text-[11px] text-[var(--ink)]"><input type="checkbox" className="shrink-0 accent-[var(--accent)]" aria-label={group.label+"："+item.label} data-jizura-tech={item.id} checked={selected[item.id]!==false} onChange={event=>setItems([item.id],event.currentTarget.checked?"on":"off")}/><span className="min-w-0 break-words">{item.label}</span>{item.set&&<span className="ml-auto shrink-0 text-[10px] text-[var(--ink-3)]">{catalog.sets.find(set=>set.id===item.set)?.label||item.set}</span>}</label>)}</div>
        {!visible.length&&<p className="text-[12px] text-[var(--ink-2)]">没有匹配的效果</p>}
      </div>}
      {tab==="colors"&&<div className="space-y-4"><div className="flex flex-wrap gap-5"><Toggle label="自定义背景与文字色" value={!!project.colors.enabled} onChange={next=>update({colors:{...project.colors,enabled:next}})}/><Toggle label="自定义强调与错位色" value={!!project.colors.accentOn} onChange={next=>update({colors:{...project.colors,accentOn:next}})}/><button type="button" className={tool} onClick={()=>update({colors:{...project.colors,...J.randomPalette(String(project.colors.bg||swatch.bg||"#000000")),accentOn:true}})}><Shuffle size={14}/>随机配色</button></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[["bg","背景"],["fg","文字"],["sub","辅助文字"],["accent","强调色"],["ghostA","错位色 A"],["ghostB","错位色 B"]].map(([key,label])=><Field key={key} label={label}><input type="color" aria-label={"JIZURA "+label} className={control+" !p-1"} value={String(project.colors[key]||swatch[key]||"#ffffff")} onChange={event=>update({colors:{...project.colors,[key]:event.currentTarget.value,[["bg","fg","sub"].includes(key)?"enabled":"accentOn"]:true}})}/></Field>)}</div>{select("背景模式","keyBg",[["off","原版背景"],["green","绿幕"],["black","黑幕"]])}</div>}
      {tab==="fonts"&&<div className="space-y-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{[["display","主歌词字体"],["serif","衬线字体"],["body","辅助字体"],["mono","等宽字体"]].map(([key,label])=><Field key={key} label={label}><select className={control} aria-label={label} value={project.fonts[key]||""} onChange={event=>update({fonts:{...project.fonts,[key]:event.currentTarget.value}})}><option value="">跟随风格</option>{[...catalog.fonts,...(project.userFonts||[]).map(font=>({id:font.key,label:font.label}))].map(font=><option key={font.id} value={font.id}>{font.label}</option>)}</select></Field>)}</div>{select("歌词语言","lang",[["auto","自动"],["zh-Hans","简体中文"],["zh-Hant","繁体中文"],["ja","日语"],["ko","韩语"]])}<div className="flex flex-wrap gap-2"><input type="text" className={control+" !w-auto min-w-32 flex-1"} aria-label="本机字体名称" placeholder="本机字体名称" value={localFont} onChange={event=>setLocalFont(event.currentTarget.value)}/><button type="button" className={tool} disabled={!localFont.trim()} onClick={addLocalFont}>添加字体</button><button type="button" className={tool} disabled={fontBusy} onClick={()=>fontInput.current?.click()}><Upload size={14}/>{fontBusy?"正在导入…":"导入字体"}</button><input ref={fontInput} type="file" accept=".ttf,.otf,.woff,.woff2" aria-label="导入 JIZURA 字体文件" className="hidden" onChange={event=>{const file=event.currentTarget.files?.[0];if(file)void importFont(file)}}/></div></div>}
      {tab==="global"&&<div className="space-y-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{select("画面比例","aspect",["16:9","9:16","4:3","3:4","1:1","4:5","21:9"])}{select("分辨率","res",[["720","720p"],["1080","1080p"],["1440","1440p"],["2160","4K"]],true)}{select("帧率","fps",["24","30","60"],true)}<Field label="随机种子"><div className="flex gap-2"><input className={control} type="number" step={1} aria-label="JIZURA 随机种子" value={project.seed} onChange={event=>update({seed:Number(event.currentTarget.value)})}/><button type="button" className={tool+" w-9 !px-0"} title="生成新随机种子" aria-label="生成新随机种子" onClick={()=>update({seed:Math.floor(Math.random()*1e9)})}><Shuffle size={14}/></button></div></Field>{select("随机主题","themeId",[["","不指定主题"],...catalog.themes.map(item=>[item.id,item.label] as [string,string])])}{select("中央留白方向","centerDir",[["tb","上下"],["lr","左右"]])}</div><div className="flex flex-wrap gap-5">{[["unify","统一构图"],["typeset","文字排版"],["centerFree","中央留白"]].map(([key,label])=><Toggle key={key} label={label} value={!!project[key]} onChange={next=>update({[key]:next})}/>)}</div><div className="flex flex-wrap gap-2"><button type="button" className={tool} onClick={randomize}><Shuffle size={14}/>随机组合</button><button type="button" className={tool} onClick={()=>update({fx:{...catalog.defaults.fx},enabled:{...catalog.defaults.enabled},locks:{tech:{},params:{}},overrides:{}},{lineEffectsTrackKey:undefined})}><RotateCcw size={14}/>重置动画与组合</button></div></div>}
      {tab==="lines"&&<div className="space-y-4">{lines.length?<>
        <p className="text-[12px] text-[var(--ink)]">{state?.title}{state?.artist?" · "+state.artist:""}</p>
        <Field label="歌曲歌词"><select className={control} aria-label="JIZURA 歌词行" value={selectedLine} onChange={event=>{setSelectedLine(event.currentTarget.value);setSelectedCut(0)}}><option value="current">当前行：{lines[currentLine]?.text}</option>{lines.map((line,index)=><option key={index} value={index}>{index+1}. {line.text}</option>)}</select></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="每行镜头数"><select className={control} aria-label="JIZURA 每行镜头数" value={String(override.cuts||"")} onChange={event=>{setSelectedCut(0);lineUpdate({cuts:Number(event.currentTarget.value)||undefined,lock:false,lockedCuts:undefined,lockedSeed:undefined})}}><option value="">自动</option>{Array.from({length:12},(_,index)=><option key={index+1} value={index+1}>{index+1}</option>)}</select></Field>
          <Field label="行布局"><select className={control} aria-label="JIZURA 行布局" value={override.layout||""} onChange={event=>lineUpdate({layout:event.currentTarget.value,lock:false,lockedCuts:undefined,lockedSeed:undefined})}><option value="">自动</option>{catalog.groups.find(item=>item.id==="layout")?.items.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
          <Field label="编辑镜头"><select className={control} aria-label="JIZURA 编辑镜头" value={cutIndex} onChange={event=>setSelectedCut(Number(event.currentTarget.value))}>{Array.from({length:Number(override.cuts)||cuts.length||1},(_,index)=><option key={index} value={index}>镜头 {index+1}</option>)}</select></Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LockButton label="锁定当前歌词行" locked={!!override.lock} onClick={toggleLineLock}/>
          <button type="button" className={tool} onClick={()=>lineUpdate({seed:(override.seed||0)+1,lock:false,lockedCuts:undefined,lockedSeed:undefined})}><Shuffle size={14}/>重排当前行</button>
          <button type="button" className={tool} onClick={()=>{const next={...(lineScope?project.overrides:{})};delete next[lineIndex];update({overrides:next},{lineEffectsTrackKey:state?.trackKey})}}><RotateCcw size={14}/>重置当前行</button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{catalog.groups.filter(item=>item.id!=="fx").map(item=><Field key={item.id} label={item.label}><div className="flex gap-1">
          <select className={control} aria-label={"JIZURA 镜头"+item.label} value={cutTech[item.id]||(item.id==="layout"?override.cutLayouts?.[cutIndex]:"")||""} onChange={event=>updateCut(item.id,event.currentTarget.value)}>
            <option value="">自动</option>{["decor","trans"].includes(item.id)&&<option value="none">无</option>}{item.items.map(tech=><option key={tech.id} value={tech.id}>{tech.label}</option>)}
          </select>
          <LockButton label={"固定镜头"+item.label} locked={!!cutTech[item.id]} onClick={()=>toggleCutLock(item.id)}/>
        </div></Field>)}</div>
      </>:<p className="text-[12px] text-[var(--ink-2)]">当前歌曲暂无歌词</p>}</div>}
    </div>
  </div>;
}
