import assert from "node:assert/strict";
import { createServer } from "vite";
const server=await createServer({server:{middlewareMode:true},appType:"custom"});
let settings={},writes=0,fail=false;
let pack={version:"1.1.0",styles:[{id:"neon",name:"霓虹",css:".current { color: cyan; }"}]};
globalThis.window={__TAURI_INTERNALS__:{invoke:async(command,args)=>{
  if(command==="get_obs_lyrics_settings") return JSON.stringify(settings);
  if(command==="fetch_lyrics_styles"){if(fail) throw Error("offline");return structuredClone(pack);}
  if(command==="set_obs_lyrics_settings"){writes++;settings=JSON.parse(args.settings);return;}
  throw Error(command);
}}};
try {
  const {syncWebsiteLyrics,saveLyricsSettings,fetchStyles}=await server.ssrLoadModule("/src/obsLyricsUpdates.ts");
  const original={officialStyleId:"neon",officialStyleVersion:"1.0.0",officialCss:"old",css:".mine {}",preset:"classic",size:42};
  settings={...original};
  await syncWebsiteLyrics();
  assert.equal(settings.officialCss,pack.styles[0].css,"a selected stable style ID receives the website release");
  assert.equal(settings.css,original.css,"website updates preserve user overrides");
  assert.equal(settings.size,42,"website updates preserve typography");
  await saveLyricsSettings({...original,css:".user-edit {}"});
  assert.equal(settings.officialStyleVersion,"1.1.0","saving an open editor cannot roll back a background update");
  assert.equal(settings.css,".user-edit {}");
  writes=0;
  await syncWebsiteLyrics();
  assert.equal(writes,0,"an unchanged release does not write settings");
  pack.version="1.0.0";
  await syncWebsiteLyrics();
  assert.equal(writes,0,"an older network response cannot downgrade a style");
  pack.version="1.2.0";
  settings={...original,autoUpdateStyles:false};
  await syncWebsiteLyrics();
  assert.equal(writes,0,"disabling updates preserves the chosen style");
  settings={css:".mine {}"};
  await syncWebsiteLyrics();
  assert.equal(writes,0,"users who have not selected a website style keep their appearance");
  settings={...original,officialStyleId:"removed"};
  await syncWebsiteLyrics();
  assert.equal(writes,0,"a removed style keeps its saved CSS");
  settings={...original};fail=true;
  await syncWebsiteLyrics();
  assert.equal(writes,0,"automatic network failures preserve the saved appearance");
  await assert.rejects(fetchStyles(),"manual network failures remain visible");
  fail=false;pack.styles[0].css="@import 'external';";
  await assert.rejects(fetchStyles(),"remote resource CSS cannot enter the style layer");
  console.log("PASS: style updates, user CSS, editor preservation, no downgrade, opt out, no selection, removed style, offline and validation.");
} finally {await server.close();}
