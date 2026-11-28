import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build,preview} from 'vite';
import {copyFile,mkdir,readFile} from 'node:fs/promises';
const require=createRequire('C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json');
const {chromium}=require('playwright');
const fontBytes=await readFile(`${process.env.WINDIR || 'C:/Windows'}/Fonts/arial.ttf`);
const lyricHtml=await readFile('src/obs-lyrics.html','utf8');
await copyFile('scripts/fixtures/ui.html','_ui-test.html');await copyFile('scripts/fixtures/ui.tsx','_ui-test.tsx');
await mkdir('outputs/web-lyrics-css',{recursive:true});
const outDir='outputs/web-lyrics-css/fixture';
await build({build:{outDir,rollupOptions:{input:'_ui-test.html'}}});
const vite=await preview({build:{outDir},preview:{host:'127.0.0.1',port:1437,strictPort:true}});
const browser=await chromium.launch({headless:true,channel:'msedge'});
try {
 const page=await browser.newPage({viewport:{width:1100,height:720}}); page.on('pageerror', e=>console.error('PAGE ERROR:',String(e)));
 await page.route('http://127.0.0.1:17842/**',route=>{
  const url=route.request().url();
  return route.fulfill(url.includes('/fonts/')?{contentType:'font/ttf',body:fontBytes}:{contentType:url.endsWith('/state')?'application/json':'text/html',body:url.endsWith('/state')?'{}':lyricHtml});
 });
 page.on('requestfailed',request=>console.error('REQUEST FAILED:',request.url(),request.failure()));
 page.on('console',message=>{if(message.type()==='error')console.error('BROWSER:',message.text());});
 const pending=new Set();
 page.on('request',request=>pending.add(request.url()));
 page.on('requestfinished',request=>pending.delete(request.url()));
 page.on('requestfailed',request=>pending.delete(request.url()));
 await page.addInitScript(()=>{
  window.__settings={preset:'nowplaying-liquid',css:'',size:48,color:'#aabbcc'};window.__copied='';window.__fail=false;window.__fontImports=0;
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text;}}});
  window.__TAURI_INTERNALS__={transformCallback:fn=>fn,convertFileSrc:p=>p,invoke:async(cmd,args)=>{
   if(cmd==='get_obs_lyrics_settings')return JSON.stringify(window.__settings);
   if(cmd==='set_obs_lyrics_settings'){if(window.__fail)throw 'fixture failure';window.__settings=JSON.parse(args.settings);return;}
   if(cmd==='import_obs_lyrics_font'){window.__fontImports++;if(!args.data||atob(args.data).length<100)throw 'missing font data';return {fontFile:'a'.repeat(64)+'.ttf',fontName:args.name.replace(/\.[^.]+$/,'')};}
   if(cmd==='get_pitch_shift')return 0;
   if(cmd==='vocal_removal_status')return {installed:false,supportedPlatform:true};
   if(cmd==='plugin:event|listen')return 1;
   return null;
  }};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
 });
 for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:1437/_ui-test.html')).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 await page.goto('http://127.0.0.1:1437/_ui-test.html',{waitUntil:'commit'});
 try { await page.waitForFunction(()=>!!window.__renderLayoutOnly,undefined,{timeout:30000}); }
 catch(error) { console.error('PENDING REQUESTS:',[...pending]); throw error; }
 await page.evaluate(()=>window.__renderLayoutOnly(false,'standard'));
 await page.getByRole('button',{name:'网页歌词',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'网页歌词',exact:true});
 await dialog.getByLabel('选择歌词字体文件').setInputFiles({name:'我的舞台字体.ttf',mimeType:'font/ttf',buffer:fontBytes});
 await dialog.getByText('字体已导入',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__settings.fontFile),'a'.repeat(64)+'.ttf','font selection is saved immediately from the bottom toolbar');
 assert.equal(await page.evaluate(()=>window.__settings.preset),'nowplaying-liquid','font import preserves the preset');
 await dialog.getByLabel('网页歌词样式',{exact:true}).selectOption('aurora');
 await page.waitForFunction(()=>window.__settings.preset==='aurora');
 assert.equal(await page.evaluate(()=>window.__settings.fontName),'我的舞台字体','preset changes preserve imported fonts');
 await dialog.getByLabel('歌词互动挂件',{exact:true}).selectOption('notes');
 await page.waitForFunction(()=>window.__settings.widget==='notes');
 await dialog.getByLabel('启用歌词与挂件动效',{exact:true}).uncheck();
 await page.waitForFunction(()=>window.__settings.motion===false);
 await dialog.getByLabel('启用歌词与挂件动效',{exact:true}).check();
 await page.waitForFunction(()=>window.__settings.motion===true);
 assert.equal(await page.evaluate(()=>window.__settings.fontName),'我的舞台字体','widget and motion changes preserve the imported font');
 await dialog.getByLabel('选择歌词字体文件').setInputFiles({name:'broken.ttf',mimeType:'font/ttf',buffer:Buffer.from('not a valid font')});
 await dialog.getByText('导入失败：无法读取此字体，请选择完整有效的字体文件',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__fontImports),1,'invalid fonts never reach persistent storage');
 await dialog.locator('#web-lyrics-css').fill('#lyrics .current { color: #abcdef; }');
 await dialog.getByRole('button',{name:'应用 CSS',exact:true}).click();
 await dialog.getByText('已应用并保存，网页歌词会自动更新').waitFor();
 let saved=await page.evaluate(()=>window.__settings);assert.equal(saved.color,'#aabbcc');assert.equal(saved.preset,'aurora');assert(saved.css.includes('#abcdef'));assert(saved.fontFile,'CSS changes retain the font');
 await dialog.getByText('用 AI 制作挂件与效果',{exact:true}).click();
 await dialog.getByText('格式和修改位置 · 怎么加挂件',{exact:true}).click();
 for(const name of ['AI 提示词','代码格式','示例 CSS']){
  await dialog.getByRole('button',{name:name === 'AI 提示词' ? '复制 AI 提示词' : `复制${name}`,exact:true}).click();
  const a=await page.evaluate(()=>window.__copied);assert(a.length>100);
  if(name==='AI 提示词') assert(a.includes('飞字')&&a.includes('透明')&&a.includes('导入字体')&&a.includes('音浪跃动'),'Chinese prompt documents imported fonts and new effects');
  await dialog.getByRole('button',{name:`点击复制${name}`,exact:true}).click();assert.equal(await page.evaluate(()=>window.__copied),a);
 }
 await page.evaluate(()=>window.__fail=true);
 await dialog.getByRole('button',{name:'恢复默认字体',exact:true}).click();await dialog.getByText('恢复失败：fixture failure',{exact:true}).waitFor();
 assert(await page.evaluate(()=>!!window.__settings.fontFile),'a failed save does not pretend to reset the font');
 await dialog.getByRole('button',{name:'应用 CSS',exact:true}).click();await dialog.getByText('应用失败：fixture failure',{exact:true}).waitFor();
 await page.evaluate(()=>window.__fail=false);
 await dialog.getByRole('button',{name:'清空编辑框',exact:true}).click();await dialog.getByRole('button',{name:'应用 CSS',exact:true}).click();
 await dialog.getByText('已清除自定义 CSS',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__settings.css),'');
 for(const mode of ['light','dark']) for(const theme of ['standard','liquid','skeuo']) for(const [width,height] of [[800,600],[1000,660],[1280,800],[1920,1080]]) { await page.setViewportSize({width,height}); await page.evaluate(async({theme,mode})=>{window.__renderLayoutOnly(false,theme);window.__applyColorMode(mode);},{theme,mode}); await page.waitForTimeout(100); const rect=await dialog.boundingBox(); assert(rect.y>=0&&rect.x>=0&&rect.y+rect.height<=height, theme+' panel bounds'); const layout=await dialog.evaluate(el=>{ const boxes=[...el.querySelectorAll('textarea,select,button,summary')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.getBoundingClientRect()); return {fits:el.scrollWidth<=el.clientWidth,overlap:boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2))}; }); assert.equal(await dialog.evaluate(el=>el.parentElement===document.body),true,'panel is isolated from the bottom toolbar');const widths=await dialog.getByRole('button',{name:'打开网页歌词',exact:true}).evaluate(el=>el.getBoundingClientRect().width);assert(widths>=150,'action labels retain horizontal space');assert(layout.fits); assert(!layout.overlap,theme+' controls overlap'); }
 await page.setViewportSize({width:1280,height:800}); await page.evaluate(()=>window.__renderLayoutOnly(false,'standard')); await page.waitForTimeout(500); await dialog.evaluate(el=>el.scrollTop=0); await dialog.screenshot({path:'outputs/web-lyrics-css/panel.png'});
 await dialog.getByRole('button',{name:'恢复默认字体',exact:true}).click();await dialog.getByText('已恢复默认字体',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__settings.fontFile),'');
 await page.keyboard.press('Escape');
 await dialog.waitFor({state:'detached'});
 await page.evaluate(()=>window.__renderPlayerBar(false,'standard'));
 const settings=page.locator('section').filter({has:page.getByRole('heading',{name:'OBS 透明歌词',exact:true})});
 await settings.getByLabel('选择歌词字体文件').setInputFiles({name:'预览字体.ttf',mimeType:'font/ttf',buffer:fontBytes});
 await settings.getByText('字体已导入',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__settings.fontFile),'','settings preview does not persist until Save is clicked');
 const preview=page.frameLocator('iframe[title="OBS 歌词预览"]');
 await preview.locator('#lyrics[data-preset="aurora"]').waitFor({state:'attached'});
 await page.waitForFunction(()=>document.querySelector('iframe[title="OBS 歌词预览"]')?.contentWindow);
 const frame=page.frames().find(frame=>frame.url()==='http://127.0.0.1:17842/lyrics-preview');
 await frame.waitForFunction(()=>getComputedStyle(document.querySelector('#lyrics')).fontFamily.includes('RustMusic-'));
 assert.equal(await frame.evaluate(async()=>{const faces=await document.fonts.load(`42px "RustMusic-${'a'.repeat(64)}"`);return faces.length;}),1,'unsaved preview loads the imported file from the local server');
 await settings.getByRole('button',{name:'保存设置',exact:true}).click();
 await settings.getByText('已保存',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__settings.fontName),'预览字体','full settings saves imported font metadata');
 await page.evaluate(()=>window.__remountSettings());
 await page.getByText('当前导入：预览字体 · 不影响其他界面',{exact:true}).waitFor();
 console.log('PASS: valid/invalid font import, save failure, reset, preset/CSS preservation, settings preview and remount; Chinese prompt and six copy actions; controls do not overlap in 3 themes × 2 color modes × 4 viewport sizes');
}finally{await browser.close();await new Promise(resolve=>vite.httpServer.close(resolve));}
