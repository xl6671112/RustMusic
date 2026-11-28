import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
const require=createRequire('C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json');
const {chromium}=require('playwright');
const html=await readFile('src/obs-lyrics.html','utf8');
const fontBytes=await readFile(`${process.env.WINDIR || 'C:/Windows'}/Fonts/arial.ttf`);
const fontFile='a'.repeat(64)+'.ttf';
const browser=await chromium.launch({headless:true,channel:'msedge'});
await mkdir('outputs/nowplaying-lyrics',{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:960,height:540}});
 await page.route('http://lyrics.test/**',route=>{
  const url=route.request().url();
  return route.fulfill(url.includes('/fonts/')?{contentType:'font/ttf',body:fontBytes}:{contentType:url.endsWith('/state')?'application/json':'text/html',body:url.endsWith('/state')?JSON.stringify({}):html});
 });
 await page.goto('http://lyrics.test/lyrics');
 // Freeze polling so deliberate seek/pause positions remain deterministic.
 await page.evaluate(()=>{window.fetch=()=>new Promise(()=>{});});
 await page.waitForTimeout(200);
 const foliaPresets=['folia-cadenza','folia-cappella','folia-claddagh','folia-classic','folia-diorama','folia-fume','folia-hanabi','folia-lumiere','folia-machi','folia-metaphor','folia-monet','folia-nebbia','folia-partita','folia-pendolo','folia-prompt','folia-sonnet','folia-still','folia-tempera','folia-tilt'];
 for(const preset of ['classic','karaoke','neon','minimal','stage','nowplaying','nowplaying-liquid','nowplaying-skeuo','nowplaying-fly','aurora','hologram','ripple','danmaku',...foliaPresets]){
  for(const width of [320,960]){
   await page.setViewportSize({width,height:540});
   const result=await page.evaluate(preset=>{
    applySettings({preset,motion:false,size:36,width:900,mode:'current-next'});
    render({trackKey:'demo',playing:false,positionMs:1500,lyrics:{synced:true,lines:[{timeMs:1000,text:'自然逐字歌词',trans:'Translated lyrics',words:[{text:'自然',startMs:1000,endMs:2000},{text:'逐字歌词',startMs:2000,endMs:3000}]},{timeMs:4000,text:'下一句歌词'}]}});
    const box=root.getBoundingClientRect();
    return {background:getComputedStyle(document.body).backgroundColor,lyricsBackground:getComputedStyle(root).backgroundImage,lyricsColor:getComputedStyle(root).backgroundColor,preset:root.dataset.preset,progress:cur.querySelector('.word').style.getPropertyValue('--progress'),translation:cur.querySelector('.translation').textContent,next:next.textContent,animation:getComputedStyle(cur).animationName,fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight};
   },preset);
   assert.equal(result.background,'rgba(0, 0, 0, 0)','OBS canvas stays transparent');
   assert.equal(result.lyricsBackground,'none','lyrics presets do not add a background plate');
   assert.equal(result.lyricsColor,'rgba(0, 0, 0, 0)','lyrics container stays transparent');
   assert.equal(result.preset,preset);assert.equal(result.progress,'50%','word timing remains unchanged by appearance');
   assert.equal(result.translation,'Translated lyrics');assert.equal(result.next,'下一句歌词');
   assert.equal(result.animation,'none','motion-off is honored by new appearances');assert(result.fits,'lyrics fit narrow browser sources');
   if(width===960&&preset.startsWith('nowplaying')) await page.screenshot({path:`outputs/nowplaying-lyrics/${preset}.png`,omitBackground:true});
  }
 }
 for(const preset of ['aurora','hologram','ripple','danmaku',...foliaPresets.filter(preset=>preset!=='folia-still')]){
  await page.setViewportSize({width:960,height:540});
  const effect=await page.evaluate(preset=>{
   applySettings({preset,motion:true,size:48,width:900,mode:'current-next'});
   const lyrics={synced:true,lines:[{timeMs:0,text:'星河流转 让歌声发光',trans:'Let the music shine'},{timeMs:3000,text:'每一个字都有自己的节奏'}]};
   render({trackKey:'effect-demo',playing:true,positionMs:1000,lyrics});
   const count=cur.querySelectorAll('.effect-char').length;
   const char=cur.querySelector('.effect-char');
   const animation=getComputedStyle(char).animationName;
   const entry=getComputedStyle(cur).animationName;
   const text=cur.textContent;
   render({trackKey:'effect-demo',playing:false,positionMs:1100,lyrics});
   const paused=getComputedStyle(char).animationPlayState;
   applySettings({preset,motion:false,mode:'current-next'});
   const stopped=getComputedStyle(char).animationName;
   return {count,animation,entry,text,paused,stopped};
  },preset);
  assert(effect.count>8,'plain lyrics become effect characters without requiring a song change');
  assert.notEqual(effect.animation,'none',preset+' has a visible character effect');
  assert.notEqual(effect.entry,'none',preset+' retains its entry transition');
  assert(effect.text.includes('星河流转 让歌声发光'),'effects keep spaces and text intact');
  assert.equal(effect.paused,'paused');
  assert.equal(effect.stopped,'none');
  await page.evaluate(preset=>{applySettings({preset,motion:true,size:48,width:900,mode:'current-next'});render({trackKey:'effect-demo',playing:true,positionMs:1000,lyrics:{synced:true,lines:[{timeMs:0,text:'星河流转 让歌声发光',trans:'Let the music shine'},{timeMs:3000,text:'每一个字都有自己的节奏'}]}})},preset);
  await page.waitForTimeout(1100);
  await page.screenshot({path:`outputs/nowplaying-lyrics/${preset}.png`,omitBackground:true});
 }
 const font=await page.evaluate(async fontFile=>{
  applySettings({preset:'aurora',fontFile,font:'Arial, sans-serif',motion:false});
  const family='RustMusic-'+fontFile.split('.')[0];
  const faces=await document.fonts.load(`42px "${family}"`);
  const imported=getComputedStyle(root).fontFamily;
  applySettings({preset:'classic',fontFile:'',font:'Arial, sans-serif',motion:false});
  return {loaded:faces.length,imported,reset:getComputedStyle(root).fontFamily,rules:fontStyle.textContent};
 },fontFile);
 assert.equal(font.loaded,1,'copied font bytes are decodable through the browser source URL');
 assert(font.imported.includes('RustMusic-'),'the imported font is first in the lyric font stack');
 assert(!font.reset.includes('RustMusic-'),'reset removes the imported font');
 assert.equal(font.rules,'','reset does not retain an old font source');
 const widgetResults=await page.evaluate(()=>{
  const lyrics={synced:true,lines:[{timeMs:0,text:'一起唱到星光里',words:[{text:'一起',startMs:0,endMs:1000},{text:'唱到',startMs:1000,endMs:2000},{text:'星光里',startMs:2000,endMs:3000}]},{timeMs:3000,text:'下一句'}]};
  const results=[];
  for(const widget of ['stars','notes','bars']){
   applySettings({preset:'danmaku',widget,motion:true,size:42});
   render({trackKey:'widget-test',playing:true,positionMs:400,lyrics});
   const p1=root.style.getPropertyValue('--widget-progress'),bar1=root.style.getPropertyValue('--bar-0');
   const beat1=widgetBeat;
   render({trackKey:'widget-test',playing:true,positionMs:1500,lyrics});
   const beat2=widgetBeat;
   const progress=root.style.getPropertyValue('--widget-progress'),bar2=root.style.getPropertyValue('--bar-0');
   const css=getComputedStyle(root.querySelector('.widget-orbit'),'::before');
   const animated=widget==='bars'?getComputedStyle(root.querySelector('.widget-bars')).display==='flex':css.animationName==='lyric-widget-hit';
   const rootRect=root.getBoundingClientRect(),textRect=cur.getBoundingClientRect();
   const leftRect=root.querySelector(widget==='bars'?'.widget-bars':'.widget-orbit').getBoundingClientRect();
   const rightRect=root.querySelector(widget==='bars'?'.widget-bars-right':'.widget-spark').getBoundingClientRect();
   render({trackKey:'widget-test',playing:false,positionMs:1500,lyrics});
   const paused=getComputedStyle(root.querySelector('.widget-orbit'),'::before').animationPlayState;
   applySettings({preset:'danmaku',widget,motion:false});
   results.push({widget,animated,p1,progress,bar1,bar2,beat1,beat2,paused,hidden:getComputedStyle(root.querySelector('.widgets')).display==='none',fits:leftRect.left>=rootRect.left&&rightRect.right<=rootRect.right,clear:leftRect.right<=textRect.left+1&&rightRect.left>=textRect.right-1,rects:{root:rootRect.toJSON(),text:textRect.toJSON(),left:leftRect.toJSON(),right:rightRect.toJSON()}});
  }
  applySettings({preset:'danmaku',widget:'none',motion:true});
  const noneHidden=getComputedStyle(root.querySelector('.widgets')).display==='none';
  applySettings({preset:'hologram',widget:'preset',motion:true});
  const presetWidget=root.dataset.widget;
  return {results,noneHidden,presetWidget};
 });
 for(const result of widgetResults.results){
  assert(result.animated,result.widget+' has the intended widget animation');
  assert.notEqual(result.p1,result.progress,'widget progress follows lyric time');
  assert.notEqual(result.beat1,result.beat2,'entering the next timed word restarts the widget hit');
  assert.notEqual(result.bar1,result.bar2,'bar heights respond to lyric position');
  assert.equal(result.paused,'paused','pausing freezes the widget');
  assert(result.hidden,'motion-off hides widgets');
  assert(result.fits&&result.clear,'widgets stay in dedicated margins outside the lyric text: '+JSON.stringify(result));
 }
 assert(widgetResults.noneHidden,'widgets can be disabled independently');
 assert.equal(widgetResults.presetWidget,'bars','preset widget choices remain available');
 const fly=await page.evaluate(()=>{
  applySettings({preset:'nowplaying-fly',motion:true,size:36,width:900,mode:'current-next'});
  const lyrics={synced:true,lines:[{timeMs:0,text:'第一句飞字'},{timeMs:2000,text:'第二句'}]};
  render({trackKey:'fly',playing:true,positionMs:1000,lyrics});
  const entering=cur.querySelectorAll('.fly-char').length;
  const name=getComputedStyle(cur.querySelector('.fly-char')).animationName;
  render({trackKey:'fly',playing:true,positionMs:2100,lyrics});
  return {entering,name,exiting:root.querySelectorAll('.lyric-exiting .fly-char').length,progress:(()=>{const words={synced:true,lines:[{timeMs:0,text:'逐字歌词',words:[{text:'逐字',startMs:0,endMs:2000},{text:'歌词',startMs:2000,endMs:3000}]}]};render({trackKey:'fly-words',playing:true,positionMs:1000,lyrics:words});return cur.querySelector('.word').style.getPropertyValue('--progress')})()};
 });
 assert.equal(fly.entering,5,'fly preset wraps normal lyric characters');
 assert.equal(fly.name,'lyric-fly-in','fly preset animates entering characters');
 assert(fly.exiting>0,'previous fly line retains outgoing characters during its exit');
 assert.equal(fly.progress,'50%','fly preset preserves timed word progress');
 const transition=await page.evaluate(async()=>{
  const settings={preset:'nowplaying',motion:true,css:'#lyrics { --lyric-sung:#00ff00; --lyric-unsung:#808080; --lyric-enter:test-in .2s linear; --lyric-exit:test-out .2s linear; } @keyframes test-in {from{opacity:0}to{opacity:1}} @keyframes test-out {from{opacity:1}to{opacity:0}}'};
  applySettings(settings);
  const lyrics={synced:true,lines:[{timeMs:0,text:'第一句',words:[{text:'第一句',startMs:0,endMs:2000}]},{timeMs:2000,text:'第二句'}]};
  render({trackKey:'transition',playing:true,positionMs:1000,lyrics});
  const gradient=getComputedStyle(cur.querySelector('.word-glyph')).backgroundImage;
  render({trackKey:'transition',playing:true,positionMs:2100,lyrics});
  const entering=cur.classList.contains('lyric-entering'),exit=root.querySelector('.lyric-exiting');
  const outgoing=exit?.textContent,exitCount=root.querySelectorAll('.lyric-exiting').length;
  render({trackKey:'transition',playing:false,positionMs:2200,lyrics});
  const paused=getComputedStyle(cur).animationPlayState;
  render({trackKey:'transition',playing:true,positionMs:2300,lyrics});
  await new Promise(resolve=>setTimeout(resolve,450));
  const cleaned=!root.querySelector('.lyric-exiting');
  applySettings({...settings,css:'#lyrics { --lyric-exit: none; }'});
  render({trackKey:'transition',playing:true,positionMs:1000,lyrics});
  const noneCleaned=!root.querySelector('.lyric-exiting'); applySettings(settings); render({trackKey:'transition',playing:true,positionMs:2100,lyrics}); applySettings({...settings,motion:false}); return {gradient,entering,outgoing,exitCount,paused,cleaned,noneCleaned,motionOffCleaned:!root.querySelector('.lyric-exiting')};
 });
 assert(transition.gradient.includes('0, 255, 0')&&transition.gradient.includes('128, 128, 128'),'custom sung/unsung colors reach the timed gradient');
 assert(transition.entering);assert.equal(transition.outgoing,'第一句');assert.equal(transition.exitCount,1);
 assert.equal(transition.paused,'paused');assert(transition.cleaned,'outgoing line is removed after animation');assert(transition.noneCleaned,'disabled exit leaves no ghost line');assert(transition.motionOffCleaned,'turning off motion clears an in-flight outgoing line');
 console.log(`PASS: ${13+foliaPresets.length} styles × 2 widths; imported font decode/reset; 3 timed widget modes, preset/none, spacing, word triggers and pause; transparent effects/danmaku/Folia, translation, timed progress, bounds, custom colors, entry/exit and cleanup`);
}finally{await browser.close();}
