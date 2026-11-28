import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire('C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json');
const {chromium}=require('playwright');
const html=await readFile('src/obs-lyrics.html','utf8');
const browser=await chromium.launch({headless:true,channel:'msedge'});
try {
 const page=await browser.newPage({viewport:{width:960,height:540}});
 await page.route('http://lyrics.test/**',route=>route.fulfill({
  contentType:route.request().url().endsWith('/state')?'application/json':'text/html',
  body:route.request().url().endsWith('/state')?'{}':html,
 }));
 await page.goto('http://lyrics.test/lyrics');
 await page.evaluate(()=>{window.fetch=()=>new Promise(()=>{});});
 const plain=await page.evaluate(async()=>{
  const settings={preset:'danmaku',particleDissolve:true,motion:true};
  const lyrics={synced:true,lines:[{timeMs:0,text:'星河流转 让歌声发光',trans:'Stars carry the song'},{timeMs:2000,text:'下一句歌词'},{timeMs:4000,text:'再下一句歌词'}]};
  applySettings(settings);
  render({trackKey:'plain',playing:true,positionMs:1000,lyrics});
  await new Promise(resolve=>setTimeout(resolve,1050));
  const originalRect=cur.getBoundingClientRect().toJSON();
  render({trackKey:'plain',playing:true,positionMs:2100,lyrics});
  await new Promise(resolve=>setTimeout(resolve,150));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const old=root.querySelector('.lyric-exiting'),glyphs=[...old.querySelectorAll('.dissolve-glyph')],canvas=old.querySelector('.dissolve-particles'),rootRect=root.getBoundingClientRect(),firstGlyphRect=glyphs[0].getBoundingClientRect().toJSON(),firstGlyphLocalRect={left:firstGlyphRect.left-rootRect.left,top:firstGlyphRect.top-rootRect.top,right:firstGlyphRect.right-rootRect.left,bottom:firstGlyphRect.bottom-rootRect.top},exitRect=old.getBoundingClientRect().toJSON();
  return {
   preset:root.dataset.preset,
   particleDissolve:root.dataset.particleDissolve,
   glyphCount:glyphs.length,
   visibleGlyphCount:glyphs.filter(glyph=>glyph.textContent.trim()).length,
   expected:typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment('星河流转 让歌声发光')].length:[...'星河流转 让歌声发光'].length,
   originalRect,
   exitRect,
   firstGlyphRect,
   firstGlyphLocalRect,
   particleCanvasCount:old.querySelectorAll('.dissolve-particles').length,
   particles:Number(canvas?.dataset.particleCount),
   particlesPerChar:Number(canvas?.dataset.particlesPerChar),
   particleDirections:JSON.parse(canvas?.dataset.particleDirections||'[]'),
   particleSamples:JSON.parse(canvas?.dataset.particleSamples||'[]'),
   glyphText:glyphs.map(g=>[...g.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('')).join(''),
   translation:old.querySelector('.translation')?.textContent,
   lineAnimation:getComputedStyle(old).animationName,
   canvasWidth:canvas?.width,
   canvasHeight:canvas?.height,
   canvasPixels:[...canvas?.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data||[]].filter((value,index)=>index%4===3&&value>0).length,
   exitLayer:getComputedStyle(old).zIndex,
   currentLayer:getComputedStyle(cur).zIndex,
   nextLayer:getComputedStyle(next).zIndex,
   currentText:cur.textContent,
   nextText:next.textContent,
   currentVisibility:getComputedStyle(cur).visibility,
   nextVisibility:getComputedStyle(next).visibility,
   defaultCount:root.dataset.particleCount,
  };
 });
 assert.equal(plain.preset,'danmaku','particle dissolve decorates the selected lyric preset rather than replacing it');
 assert.equal(plain.particleDissolve,'true','the particle overlay is independently enabled');
 assert.equal(plain.glyphCount,plain.expected,'untimed lyrics still dissolve per grapheme');
 assert.equal(plain.particleCanvasCount,1,'one canvas draws all particles for a lyric transition');
 assert.equal(plain.particles,Math.min(plain.visibleGlyphCount,80)*60,'the default emits 60 particles from each visible grapheme, not whitespace');
 assert.equal(plain.particlesPerChar,60);
 assert(Math.abs(plain.originalRect.x-plain.exitRect.x)<1&&Math.abs(plain.originalRect.y-plain.exitRect.y)<1,`the dissolving lyric stays over its original line instead of duplicating below it: ${JSON.stringify({original:plain.originalRect,exit:plain.exitRect})}`);
 assert.equal(plain.glyphText,'星河流转 让歌声发光','the old lyric remains readable text while particles are emitted');
 assert.equal(plain.translation,'Stars carry the song','translation stays separate from glyph fragmentation');
 assert.equal(plain.particleDirections.length,60,'direction samples cover the first grapheme');
 assert(plain.particleDirections.every(angle=>Number.isFinite(angle)&&angle>=0&&angle<360),'particle directions are normalized to 0-359 degrees');
 const directionQuadrants=new Set(plain.particleDirections.map(angle=>Math.floor(angle/90)));
 assert.equal(directionQuadrants.size,4,'particle directions cover all four quadrants around a glyph');
 assert.equal(plain.particleSamples.length,60,'radial samples cover the first grapheme');
 assert(plain.particleSamples.every(({startX,startY,velocityX,velocityY})=>
  [startX,startY,velocityX,velocityY].every(Number.isFinite)&&(velocityX!==0||velocityY!==0)),
 'each particle starts at a measured text point and receives a non-zero outward vector');
 assert(plain.particleSamples.every(({startX,startY})=>startX>=plain.firstGlyphLocalRect.left&&startX<=plain.firstGlyphLocalRect.right&&startY>=plain.firstGlyphLocalRect.top&&startY<=plain.firstGlyphLocalRect.bottom),
 'particles originate inside their own visible glyph rather than at a shared line point');
 const velocityQuadrants=new Set(plain.particleSamples.map(({velocityX,velocityY})=>(velocityX>=0?1:0)+(velocityY>=0?2:0)));
 assert.equal(velocityQuadrants.size,4,'particle velocities radiate in all four screen-space quadrants');
 assert(plain.canvasWidth>0&&plain.canvasHeight>0&&plain.canvasPixels>0,'the canvas actually draws visible particles during the dissolve');
 assert.equal(plain.defaultCount,'60');
 assert.equal(plain.currentText,'下一句歌词','the new current lyric remains present after the transition starts');
 assert.equal(plain.nextText,'再下一句歌词','the following preview lyric remains present during the dissolve');
 assert.equal(plain.currentVisibility,'visible');
 assert.equal(plain.nextVisibility,'visible');
 assert(Number(plain.exitLayer)<Number(plain.currentLayer),'the dissolving text and its particles stay below the new current lyric');
 assert(Number(plain.exitLayer)<Number(plain.nextLayer),'the dissolving text and its particles stay below the following lyric');
 await page.waitForTimeout(300);
 const transition=await page.evaluate(()=>{
  const old=root.querySelector('.lyric-exiting'),glyph=old?.querySelector('.dissolve-glyph'),canvas=old?.querySelector('.dissolve-particles');
  const data=canvas?.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data||[];
  return {glyphOpacity:Number.parseFloat(getComputedStyle(glyph).opacity),particleCount:Number(canvas?.dataset.particleCount),canvasPixels:[...data].filter((value,index)=>index%4===3&&value>0).length,currentText:cur.textContent,nextText:next.textContent};
 });
 assert(transition.glyphOpacity>0&&transition.glyphOpacity<1,'original glyphs fade gradually instead of being replaced instantly');
 assert(transition.particleCount>0&&transition.canvasPixels>0,'visible particles emerge while the original glyph is still fading');
 assert.equal(transition.currentText,'下一句歌词');
 assert.equal(transition.nextText,'再下一句歌词');
 await page.waitForTimeout(220);
 await page.screenshot({path:'outputs/lyrics-styles/粒子溶解-退场预览.png',omitBackground:true});
 const decoratedPresets=await page.evaluate(()=>{
  const presets=['classic','karaoke','neon','minimal','stage','nowplaying','nowplaying-liquid','nowplaying-skeuo','nowplaying-fly','aurora','hologram','ripple','danmaku'];
  return presets.map((preset,index)=>{
   const lyrics={synced:true,lines:[{timeMs:0,text:'原歌词渐变散开'},{timeMs:1000,text:'下一句保持可见'}]};
   applySettings({preset,particleDissolve:true,motion:true});
   render({trackKey:`decorated-${index}`,playing:true,positionMs:100,lyrics});
   render({trackKey:`decorated-${index}`,playing:true,positionMs:1100,lyrics});
   return {preset:root.dataset.preset,particleCount:Number(root.querySelector('.lyric-exiting .dissolve-particles')?.dataset.particleCount)};
  });
 });
 assert.deepEqual(decoratedPresets.map(item=>item.preset),['classic','karaoke','neon','minimal','stage','nowplaying','nowplaying-liquid','nowplaying-skeuo','nowplaying-fly','aurora','hologram','ripple','danmaku'],'decoration preserves every selected preset');
 assert(decoratedPresets.every(item=>item.particleCount>0),'particle dissolve decorates every lyric preset');
 const timed=await page.evaluate(()=>{
  const lyrics={synced:true,lines:[{timeMs:0,text:'逐字进度保留',words:[{text:'逐字',startMs:0,endMs:1200},{text:'进度保留',startMs:1200,endMs:2400}]},{timeMs:3000,text:'后续歌词'}]};
  applySettings({preset:'nowplaying-fly',particleDissolve:true,motion:true});
  render({trackKey:'timed',playing:true,positionMs:600,lyrics});
  const progress=cur.querySelector('.word').style.getPropertyValue('--progress');
  render({trackKey:'timed',playing:true,positionMs:3100,lyrics});
  return {progress,particles:Number(root.querySelector('.lyric-exiting .dissolve-particles')?.dataset.particleCount),glyphs:root.querySelectorAll('.lyric-exiting .dissolve-glyph').length};
 });
 assert.equal(timed.progress,'50%','dissolve support does not alter timed word progress');
 assert(timed.glyphs>0&&timed.particles>0,'timed lyric text also gets an outgoing particle layer');
 const customized=await page.evaluate(()=>{
  applySettings({preset:'aurora',particleDissolve:true,motion:true,particleSize:.35,particleColor:'#12ab34',particleColorIntensity:4.5,particleGlow:true,particleGlowStrength:84,particleHdr:true,particleCount:7,particleLifetime:1200,particleSpeed:2,particleFragmentation:80,particleEdgeHighlight:true,lyricGlowStrength:2.5});
  render({trackKey:'custom',playing:true,positionMs:100,lyrics:{synced:true,lines:[{timeMs:0,text:'自定义粒子'},{timeMs:1000,text:'下一句'}]}});
  render({trackKey:'custom',playing:true,positionMs:1100,lyrics:{synced:true,lines:[{timeMs:0,text:'自定义粒子'},{timeMs:1000,text:'下一句'}]}});
  const canvas=root.querySelector('.lyric-exiting .dissolve-particles'),style=getComputedStyle(root);
  return {count:Number(canvas?.dataset.particleCount),size:style.getPropertyValue('--user-particle-size').trim(),canvasSize:Number(canvas?.dataset.particleSize),color:style.getPropertyValue('--user-particle-color').trim(),glow:style.getPropertyValue('--user-particle-glow').trim(),glowStrength:Number(canvas?.dataset.particleGlowStrength),glowMultiplier:Number(canvas?.dataset.particleGlowMultiplier),colorIntensity:Number(canvas?.dataset.particleColorIntensity),fragmentation:root.dataset.particleFragmentation,edge:root.dataset.particleEdge,lyricGlow:root.dataset.lyricGlow,lyricGlowRadius:style.getPropertyValue('--lyric-glow-radius').trim(),hdr:canvas?.dataset.particleHdr,lifetime:style.getPropertyValue('--user-particle-lifetime').trim(),duration:style.getPropertyValue('--user-particle-motion-duration').trim()};
 });
 assert.equal(customized.count,5*7,'custom particle count is applied to each grapheme');
 assert.equal(customized.size,'0.35px','the UI and renderer accept subpixel particle sizing');
 assert.equal(customized.canvasSize,.35);
 assert.equal(customized.color,'#12ab34');
 assert.equal(customized.glow,'3px');
 assert.equal(customized.glowStrength,84,'the selected glow intensity reaches the renderer');
 assert.equal(customized.glowMultiplier,8.4,'particle glow applies ten times the normalized slider strength');
 assert.equal(customized.colorIntensity,4.5,'HDR particle color strength supports values above one');
 assert.equal(customized.fragmentation,'80','fragmentation reaches the all-direction particle scatter');
 assert.equal(customized.edge,'true','the bright dissolve edge can be enabled independently');
 assert.equal(customized.lyricGlow,'true');
 assert.equal(customized.lyricGlowRadius,'7.5px');
 assert.equal(customized.hdr,'true','HDR-style additive color is enabled in the renderer');
 assert.equal(customized.lifetime,'1200ms','lifetime is independently applied');
 assert.equal(customized.duration,'600ms','disturbance speed is independently applied');
 const bounce=await page.evaluate(async()=>{
  const lyrics={synced:true,lines:[{timeMs:0,text:'逐字弹跳测试',words:[{text:'逐字',startMs:0,endMs:400},{text:'弹跳测试',startMs:400,endMs:1200}]},{timeMs:1600,text:'尾句'}]};
  applySettings({preset:'danmaku',widget:'bounce',bounceTrailType:'double',bounceTrailDuration:900,bounceTrailLength:240,motion:true});
  render({trackKey:'bounce',playing:true,positionMs:0,durationMs:2000,lyrics});
  const first={left:bounceWidget.style.left,top:bounceWidget.style.top};
  for(let p=40;p<=380;p+=40){render({trackKey:'bounce',playing:true,positionMs:p,durationMs:2000,lyrics});await new Promise(resolve=>setTimeout(resolve,35))}
  const data=trailCanvas.getContext('2d').getImageData(0,0,trailCanvas.width,trailCanvas.height).data;
  return {widget:root.dataset.widget,first,left:bounceWidget.style.left,top:bounceWidget.style.top,current:cur.querySelector('.bounce-current')?.textContent,points:trailPoints.length,pixels:[...data].filter((value,index)=>index%4===3&&value>0).length,track:activeSettings.bounceTrailType};
 });
 assert.equal(bounce.widget,'bounce','the dedicated widget mode is selected');
 assert.notEqual(bounce.left,bounce.first.left,'the widget follows actual per-character positions');
 assert(bounce.current,'the current lyric glyph receives the bounce response');
 assert(bounce.points>1&&bounce.pixels>0,'curved double-line trails render and retain fading history');
 assert.equal(bounce.track,'double');
 await page.screenshot({path:'outputs/lyrics-styles/逐字弹跳挂件-预览.png',omitBackground:true});
 const danmaku=await page.evaluate(()=>{
  applySettings({preset:'danmaku',danmakuShadow:'#123456',danmakuAccent:'#234567',danmakuGlow:'#345678',danmakuStroke:'#456789',danmakuStrokeWidth:1.4,motion:false});
  render({trackKey:'danmaku-color',playing:true,positionMs:0,durationMs:3000,lyrics:{synced:true,lines:[{timeMs:0,text:'弹幕颜色'}]}});
  const style=getComputedStyle(root);return {shadow:style.getPropertyValue('--danmaku-shadow').trim(),accent:style.getPropertyValue('--danmaku-accent').trim(),glow:style.getPropertyValue('--danmaku-glow').trim(),stroke:style.getPropertyValue('--danmaku-stroke').trim(),width:style.getPropertyValue('--danmaku-stroke-width').trim()};
 });
 assert.deepEqual(danmaku,{shadow:'#123456',accent:'#234567',glow:'#345678',stroke:'#456789',width:'1.4px'});
 const typography=await page.evaluate(()=>{
  applySettings({preset:'nowplaying-skeuo',size:62,color:'#12ab34',weight:600,letterSpacing:3,motion:false});
  render({trackKey:'typography',playing:true,positionMs:0,durationMs:3000,lyrics:{synced:true,lines:[{timeMs:0,text:'独立歌词样式'}]}});
  const style=getComputedStyle(cur);
  return {size:style.fontSize,color:style.color,weight:style.fontWeight,letterSpacing:style.letterSpacing};
 });
 assert.deepEqual(typography,{size:'62px',color:'rgb(18, 171, 52)',weight:'600',letterSpacing:'3px'},'per-preset typography values reach the OBS lyric renderer');
 const disabled=await page.evaluate(()=>{
  const lyrics={synced:true,lines:[{timeMs:0,text:'静止歌词'},{timeMs:1000,text:'静止下一句'}]};
  applySettings({preset:'hologram',particleDissolve:true,motion:false});
  render({trackKey:'still',playing:true,positionMs:100,lyrics});
  render({trackKey:'still',playing:true,positionMs:1100,lyrics});
  return {old:!!root.querySelector('.lyric-exiting'),motion:root.dataset.motion};
 });
 assert.equal(disabled.old,false,'disabling lyric motion prevents particle creation');
 assert.equal(disabled.motion,'off');
 const framePage=await browser.newPage();
 let stateRequests=0;
 await framePage.route('http://frame.test/**',route=>route.fulfill({
  contentType:route.request().url().endsWith('/state')?'application/json':'text/html',
  body:route.request().url().endsWith('/state')?(stateRequests++,JSON.stringify({
   playing:true,
   positionMs:stateRequests*33,
   trackKey:'frame-rate',
   lyrics:{synced:true,lines:[{
    timeMs:0,
    text:'逐字帧率测试',
    words:[{text:'逐字',startMs:0,endMs:1000},{text:'帧率测试',startMs:1000,endMs:2000}],
   }]},
  })):html,
 }));
 await framePage.goto('http://frame.test/lyrics');
 await framePage.waitForTimeout(500);
 assert(stateRequests>=10,`web lyrics should poll at about 30 fps; observed ${stateRequests} state updates in 500 ms`);
 await framePage.close();
 console.log('PASS: radial four-quadrant particles, gradual text-to-particle dissolve, visible lyrics above the particle layer, timed progress, parameters, and motion-off.');
} finally {await browser.close();}
