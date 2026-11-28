import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";

const require=createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json");
const {chromium}=require("playwright");
const html=await readFile("src/obs-lyrics.html","utf8");
const browser=await chromium.launch({headless:true,channel:"msedge"});

try {
  const page=await browser.newPage({viewport:{width:960,height:540}});
  await page.route("http://timeline.test/**",route=>route.fulfill({
    contentType:route.request().url().endsWith("/state")?"application/json":"text/html",
    body:route.request().url().endsWith("/state")?"{}":html,
  }));
  await page.goto("http://timeline.test/lyrics");
  await page.evaluate(()=>{window.fetch=()=>new Promise(()=>{});});

  const readCurrent=(lyricTimeline,positionMs,lyrics,durationMs=9000)=>page.evaluate(({lyricTimeline,positionMs,lyrics,durationMs})=>{
    applySettings({preset:"classic",lyricTimeline,motion:false});
    render({trackKey:"timeline",playing:true,positionMs,durationMs,lyrics});
    return {text:cur.textContent,progress:cur.querySelector(".word")?.style.getPropertyValue("--progress")||""};
  },{lyricTimeline,positionMs,lyrics,durationMs});

  const timed={
    synced:true,
    lines:[
      {timeMs:0,text:"第一句",words:[{text:"第一句",startMs:0,endMs:1000}]},
      {timeMs:1000,text:"第二句",words:[{text:"第二句",startMs:1000,endMs:3000}]},
      {timeMs:5000,text:"第三句",words:[{text:"第三句",startMs:5000,endMs:7000}]},
    ],
  };
  const original=await readCurrent("original",2500,timed);
  assert.match(original.text,/第二句/,"original mode keeps the source line timestamps");
  assert.equal(original.progress,"75%","original mode preserves the source word-level timeline");

  const splitEarly=await readCurrent("split",2500,timed);
  assert.match(splitEarly.text,/第一句/,"split mode redistributes unevenly timed lines evenly over the track duration");
  const splitMiddle=await readCurrent("split",3500,timed);
  assert.match(splitMiddle.text,/第二句/,"split mode advances at the evenly divided line boundary");

  const untimed={synced:false,lines:[{text:"未标时第一句"},{text:"未标时第二句"},{text:"未标时第三句"}]};
  const untimedSplit=await readCurrent("split",4500,untimed);
  assert.match(untimedSplit.text,/未标时第二句/,"split mode evenly distributes untimed lines using the track duration");

  console.log("PASS: original timestamps and word progress are preserved; split mode evenly distributes timed and untimed lines.");
} finally {
  await browser.close();
}
