import type { JizuraSettings } from "./jizuraSettings";

export type Config = { localStyleId?:string; htmlTuningEnabled?:boolean; jizura?:JizuraSettings; officialCss?:string; officialStyleId?:string; officialStyleVersion?:string; autoUpdateStyles?:boolean; styleSettings?:Record<string,Partial<StyleValues>>; foliaTunings?:Record<string,Record<string,unknown>>; foliaTuningEnabled?:Record<string,boolean>; foliaAppearance?:Record<string,unknown>; foliaAssets?:Record<string,unknown>; preset:string; mode:string; lyricTimeline:"original"|"split"; motion:boolean; widget:string; css:string; customHtml:string; customHtmlEnabled:boolean; customHtmlValues:Record<string,string|number>; size:number; width:number; color:string; weight:number; align:string; font:string; fontFile:string; fontName:string; stroke:string; strokeWidth:number; shadow:string; lineHeight:number; letterSpacing:number; translationSize:number; rows:number; offsetY:number; particleDissolve:boolean; particleSize:number; particleColor:string; particleColorIntensity:number; particleGlow:boolean; particleGlowStrength:number; particleHdr:boolean; particleCount:number; particleLifetime:number; particleSpeed:number; particleFragmentation:number; particleEdgeHighlight:boolean; lyricGlowStrength:number; rawEffectsEnabled:boolean; rawShadow:string; rawAccent:string; rawGlow:string; rawStroke:string; rawStrokeWidth:number; danmakuShadow?:string; danmakuAccent?:string; danmakuGlow?:string; danmakuStroke?:string; danmakuStrokeWidth?:number; bounceTrailType:"none"|"single"|"double"|"particles"; bounceTrailDuration:number; bounceTrailLength:number };
export const initial:Config={autoUpdateStyles:true,preset:"classic",mode:"current-next",lyricTimeline:"original",motion:true,widget:"preset",css:"",customHtml:"",customHtmlEnabled:false,customHtmlValues:{},size:42,width:900,color:"#ffffff",weight:700,align:"center",font:"Arial, sans-serif",fontFile:"",fontName:"",stroke:"#111111",strokeWidth:1,shadow:"0 2px 3px #000",lineHeight:1.25,letterSpacing:0,translationSize:23,rows:3,offsetY:0,particleDissolve:false,particleSize:5,particleColor:"#ffe5a6",particleColorIntensity:1,particleGlow:true,particleGlowStrength:60,particleHdr:true,particleCount:60,particleLifetime:900,particleSpeed:1,particleFragmentation:55,particleEdgeHighlight:true,lyricGlowStrength:0,rawEffectsEnabled:false,rawShadow:"#67348d",rawAccent:"#dd7aff",rawGlow:"#ffbe69",rawStroke:"#683e8c",rawStrokeWidth:0.6,bounceTrailType:"double",bounceTrailDuration:500,bounceTrailLength:160};
export const presets=[["classic","经典直播白字"],["karaoke","金色卡拉 OK"],["neon","青紫霓虹"],["minimal","极简字幕"],["stage","双语舞台"],["nowplaying","NowPlaying · 经典"],["nowplaying-liquid","NowPlaying · 流光字效"],["nowplaying-skeuo","NowPlaying · 复古字效"],["nowplaying-fly","NowPlaying · 飞字"],["aurora","极光流彩"],["hologram","赛博全息"],["ripple","音浪跃动"],["danmaku","弹幕应援 · 超级字幕"],["folia-cadenza","Folia · Mindscape"],["folia-cappella","Folia · Cappella"],["folia-claddagh","Folia · Claddagh"],["folia-classic","Folia · Luminous"],["folia-diorama","Folia · 镜台"],["folia-fume","Folia · Fume"],["folia-hanabi","Folia · 花火"],["folia-lumiere","Folia · 绘光"],["folia-machi","Folia · 町景"],["folia-metaphor","Folia · 隐喻"],["folia-monet","Folia · Monet"],["folia-nebbia","Folia · 雾笺"],["folia-partita","Folia · 云阶"],["folia-pendolo","Folia · Pendolo"],["folia-prompt","Folia · 提示词"],["folia-sonnet","Folia · 商籁"],["folia-still","Folia · Still"],["folia-tempera","Folia · Tempera"],["folia-tilt","Folia · Tilt"]];
export const widgets=[["preset","跟随歌词预设"],["none","关闭挂件"],["stars","星轨应援"],["notes","跳动音符"],["bars","歌词节拍条"],["bounce","逐字弹跳挂件"]];

export const styleFields=["htmlTuningEnabled","size","width","color","weight","align","font","fontFile","fontName","stroke","strokeWidth","shadow","lineHeight","letterSpacing","translationSize","rows","offsetY","rawEffectsEnabled","rawShadow","rawAccent","rawGlow","rawStroke","rawStrokeWidth"] as const;
export type StyleField=typeof styleFields[number];
export type StyleValues=Pick<Config,StyleField>;
export function defaultStyleValues(preset:string):Partial<StyleValues> {
  return preset==="danmaku"
    ? {rawEffectsEnabled:true,rawShadow:"#67348d",rawAccent:"#dd7aff",rawGlow:"#ffbe69",rawStroke:"#683e8c",rawStrokeWidth:0.6}
    : {rawEffectsEnabled:false,rawShadow:"#67348d",rawAccent:"#dd7aff",rawGlow:"#ffbe69",rawStroke:"#683e8c",rawStrokeWidth:0.6};
}
export function styleKey(settings:Pick<Config,"preset"|"officialStyleId"|"localStyleId">):string {
  if(settings.localStyleId)return `local:${settings.localStyleId}`;
  return settings.officialStyleId?`official:${settings.officialStyleId}`:settings.preset==="particle-dissolve"?"classic":settings.preset;
}
export function loadLyricsSettings(raw:Partial<Config>):Config {
  const migrated={...initial,...raw};
  migrated.customHtmlEnabled=raw.customHtmlEnabled??!!raw.customHtml;
  if(migrated.preset==="custom-html")migrated.customHtmlEnabled=true;
  if(raw.preset==="particle-dissolve"){migrated.preset="classic";migrated.particleDissolve=true}
  const styleSettings={...(migrated.styleSettings||{})} as Record<string,Partial<StyleValues>>;
  const activeKey=styleKey(migrated);
  const legacyDanmakuValues={
    rawEffectsEnabled:true,
    rawShadow:raw.rawShadow??raw.danmakuShadow??initial.rawShadow,
    rawAccent:raw.rawAccent??raw.danmakuAccent??initial.rawAccent,
    rawGlow:raw.rawGlow??raw.danmakuGlow??initial.rawGlow,
    rawStroke:raw.rawStroke??raw.danmakuStroke??initial.rawStroke,
    rawStrokeWidth:raw.rawStrokeWidth??raw.danmakuStrokeWidth??initial.rawStrokeWidth,
  };
  const hasLegacyDanmaku=raw.danmakuShadow!==undefined||raw.danmakuAccent!==undefined||raw.danmakuGlow!==undefined||raw.danmakuStroke!==undefined||raw.danmakuStrokeWidth!==undefined;
  const keys=new Set([...Object.keys(styleSettings),activeKey]);
  for(const key of keys){
    const existing=styleSettings[key]||{};
    const defaults=defaultStyleValues(key.startsWith("official:")?"official":key);
    const activeValues=key===activeKey?Object.fromEntries(styleFields.map(field=>[field,raw[field]??migrated[field]])):{};
    const legacy=(key==="danmaku"||key===activeKey&&migrated.preset==="danmaku")&&raw.rawEffectsEnabled===undefined&&hasLegacyDanmaku?legacyDanmakuValues:{};
    styleSettings[key]={...defaults,...activeValues,...legacy,...existing};
  }
  return {...migrated,...styleSettings[activeKey],styleSettings} as Config;
}
