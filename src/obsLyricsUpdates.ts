import { invoke } from "@tauri-apps/api/core";
import type { Config } from "./obsLyricsPresets";

export type StylePack = { version:string; styles:{id:string;name:string;css:string}[] };
let pending:Promise<unknown> = Promise.resolve();
function newer(version:string,current=""):boolean {
  const a=version.split(".").map(Number),b=current.split(".").map(Number);
  for(let i=0;i<3;i++){if(a[i]!== (b[i]||0)) return a[i]>(b[i]||0)}
  return false;
}
function serialize<T>(action:()=>Promise<T>):Promise<T> {
  const result=pending.then(action,action);
  pending=result.catch(()=>{});
  return result;
}
export async function fetchStyles():Promise<StylePack> {
  const pack=await invoke<StylePack>("fetch_lyrics_styles");
  if(!pack || !/^\d+\.\d+\.\d+$/.test(pack.version) || !Array.isArray(pack.styles) || pack.styles.length>30)
    throw new Error("官网歌词风格格式无效");
  const ids=new Set<string>();
  for(const style of pack.styles){
    if(!style || typeof style.id!=="string" || !/^[a-z0-9-]{1,48}$/.test(style.id) || ids.has(style.id) ||
      typeof style.name!=="string" || !style.name || typeof style.css!=="string" || style.css.length>6000 ||
      /[\\<>]|url|@import|expression|image-set/i.test(style.css)) throw new Error("官网歌词风格格式无效");
    ids.add(style.id);
  }
  return pack;
}
async function readSettings():Promise<Partial<Config>> {
  const raw=await invoke<string>("get_obs_lyrics_settings");
  return raw?JSON.parse(raw):{};
}
export async function syncWebsiteLyrics():Promise<void> {
  try {
    const settings=await readSettings();
    if(settings.autoUpdateStyles===false) return;
    const pack=await fetchStyles();
    await serialize(async()=>{
      const latest=await readSettings();
      if(latest.autoUpdateStyles===false || !latest.officialStyleId || !newer(pack.version,latest.officialStyleVersion)) return;
      const style=pack.styles.find(x=>x.id===latest.officialStyleId);
      if(!style) return;
      await invoke("set_obs_lyrics_settings",{settings:JSON.stringify({...latest,officialCss:style.css,officialStyleVersion:pack.version})});
    });
  } catch { /* 自动更新失败保留当前风格，下次重试。 */ }
}
export function saveLyricsSettings(draft:Config):Promise<Config> {
  return serialize(async()=>{
    const latest=await readSettings();
    // 编辑期间官方层可能已更新，保存用户调整时保留最新官方层。
    const settings=latest.officialStyleId && latest.officialStyleId===draft.officialStyleId && latest.officialStyleVersion && newer(latest.officialStyleVersion,draft.officialStyleVersion)
      ? {...draft,officialCss:latest.officialCss,officialStyleVersion:latest.officialStyleVersion}
      : draft;
    await invoke("set_obs_lyrics_settings",{settings:JSON.stringify(settings)});
    return settings;
  });
}
