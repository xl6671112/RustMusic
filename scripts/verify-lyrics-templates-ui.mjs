import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";

const require = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json");
const { chromium } = require("playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const html = new URL("../_lyrics-templates-ui.html", import.meta.url);
const entry = new URL("../_lyrics-templates-ui.tsx", import.meta.url);
const out = new URL("../outputs/lyrics-templates-ui/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(html, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/_lyrics-templates-ui.tsx"></script>');
await writeFile(entry, `import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import "./src/index.css";
import ObsLyricsCanvases from "./src/components/ObsLyricsCanvases";
import {initial} from "./src/obsLyricsPresets";
if(!localStorage.getItem("lyrics-ui-db"))localStorage.setItem("lyrics-ui-db",JSON.stringify({templates:[
  {id:"folia",name:"Folia 风格",settings:{...initial,preset:"folia-hanabi",foliaAppearance:{glowColors:{hanabi:"#ab1234"}},foliaTunings:{hanabi:{speed:1.7}}}},
  {id:"jizura",name:"JIZURA 风格",settings:{...initial,preset:"jizura",jizura:{transparent:true,project:{style:"noir",seed:42,fx:{motion:.7},enabled:{enter:{pop:false}},colors:{accent:"#32ff88"}}}}},
  {id:"html",name:"HTML 参数风格",settings:{...initial,customHtmlEnabled:true,customHtml:'<span data-rustmusic-slot="current"></span><i data-rustmusic-setting="speed" data-rustmusic-type="number" data-rustmusic-label="画布动态速度" data-rustmusic-default="2" data-rustmusic-min="0" data-rustmusic-max="10"></i><i data-rustmusic-setting="tint" data-rustmusic-type="color" data-rustmusic-label="画布动态颜色" data-rustmusic-default="#112233"></i>',customHtmlValues:{speed:2,tint:"#112233"}}}
],canvases:{enabled:false,captureEnabled:false,previewEnabled:false,activeId:"",presets:[]}}));
function Fixture(){const[revision,setRevision]=useState(0);
window.__remount=()=>setRevision(v=>v+1);
return <main style={{maxWidth:900,margin:"0 auto",padding:20,color:"var(--ink)",background:"var(--bg)"}}>
<ObsLyricsCanvases key={revision} onStatus={message=>{window.__lastStatus=message}} onEnabledChange={enabled=>{window.__sceneMode=enabled;window.__modeChanges??=[];window.__modeChanges.push(enabled)}}/>
</main>}
createRoot(document.getElementById("root")).render(<Fixture/>);`);
const vite = await createServer({ root, server: { host: "127.0.0.1", port: 1457, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/outputs/**", "**/_release/**"] } } });
await vite.listen();
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.route("http://127.0.0.1:17842/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><script>window.__assetReplies=[];addEventListener("message",event=>{if(event.data?.type==="folia-asset-result")window.__assetReplies.push(event.data)})</script>' }));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__openedCanvases = [];
    window.__assetCalls = [];
    window.__liveCanvasWindows = [{ id: "primary", visible: true }];
    const listeners = new Map();
    let nextListener = 1;
    const canvasEvent = (id, open, visible = true, error) => {
      window.__liveCanvasWindows = window.__liveCanvasWindows.filter(value => value.id !== id);
      if (open) window.__liveCanvasWindows.push({ id, visible });
      for (const { event, handler } of listeners.values()) if (event === "obs-lyrics-canvas-window") handler({ payload: { id, open, visible, error } });
    };
    window.__closeCanvasWindow = id => canvasEvent(id, false);
    window.__finishCanvasHide = () => { window.__pendingCanvasHide?.(); window.__pendingCanvasHide = undefined; };
    window.__canvasWindowError = (id, error) => canvasEvent(id, false, false, error);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => {
      if (window.__clipboardFails) throw Error("clipboard unavailable"); window.__copied = value;
    } } });
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => callback,
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") { const id = nextListener++; listeners.set(id, args); return id; }
        if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
        const db = JSON.parse(localStorage.getItem("lyrics-ui-db"));
        if (command === "get_obs_lyrics_templates") return JSON.stringify(db.templates);
        if (command === "import_folia_image" || command === "import_obs_lyrics_font") {
          window.__assetCalls.push({ command, args });
          if (window.__failAssets) throw Error("test asset import failed");
          return command === "import_folia_image" ? "test-image.png" : { fontFile: "test-font.woff2" };
        }
        if (command === "get_obs_lyrics_canvases") { if (window.__failCanvasRead) throw Error("offline canvas storage"); return JSON.stringify(db.canvases); }
        if (command === "get_open_obs_lyrics_canvases") return [...window.__liveCanvasWindows];
        if (command === "set_obs_lyrics_canvases") {
          if (window.__failWrite) throw Error("canvas write failed");
          const next = JSON.parse(args.canvases);
          const active = next.presets.find(preset => preset.id === next.activeId);
          for (const { id, visible } of [...window.__liveCanvasWindows]) {
            const canvas = active?.canvases.find(canvas => canvas.id === id);
            if (id === "primary") { if (next.enabled) canvasEvent(id, false); continue; }
            if (!next.enabled || !canvas || canvas.enabled === false) { canvasEvent(id, false); continue; }
            if ((canvas.visible !== false) !== visible) {
              if (window.__failVisibility) throw Error("window visibility failed");
              if (canvas.visible === false && window.__deferHide) await new Promise(resolve => { window.__pendingCanvasHide = resolve; });
              canvasEvent(id, true, canvas.visible !== false);
            }
          }
          db.canvases = next; localStorage.setItem("lyrics-ui-db", JSON.stringify(db)); return null;
        }
        if (command === "open_obs_lyrics_canvas") {
          if (window.__failOpen) throw Error("window open failed");
          const canvas = db.canvases.presets.find(preset => preset.id === db.canvases.activeId)?.canvases.find(canvas => canvas.id === args.id);
          if (!db.canvases.enabled || !canvas || canvas.enabled === false || canvas.visible === false) throw Error("canvas capture disabled");
          window.__openedCanvases.push(args.id); canvasEvent(args.id, true); return null;
        }
        if (command === "close_obs_lyrics_canvas") { if (window.__failClose) throw Error("window close failed"); canvasEvent(args.id, false); return null; }
        throw Error(`Unexpected command: ${command}`);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  const url = "http://127.0.0.1:1457/_lyrics-templates-ui.html";
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(url)).ok; } catch {} if (ready) break; await delay(250); }
  assert(ready);
  await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  const scenes = page.getByLabel("歌词场景设置", { exact: true });
  const mode = scenes.getByRole("switch", { name: "启用场景模式", exact: true });
  const preview = scenes.getByRole("switch", { name: "启用画布预览", exact: true });
  const windowToggle = index => scenes.getByLabel(`启用画布 ${index} 窗口`, { exact: true });
  const layerToggle = index => scenes.getByLabel(`启用画布 ${index}`, { exact: true });
  const windowStatus = index => scenes.getByLabel(`画布 ${index} 窗口状态`, { exact: true });
  const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("lyrics-ui-db")));
  const addCanvas = async id => { await scenes.getByLabel("新画布歌词风格").selectOption(id); await scenes.getByRole("button", { name: "添加画布", exact: true }).click(); };
  await scenes.waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="启用场景模式"]').disabled);
  assert.equal(await page.evaluate(() => window.__sceneMode), false, "the parent receives the loaded mode before choosing its settings panel");
  assert.equal(await scenes.getByRole("tablist").count(), 0);
  await mode.check();
  assert.equal(await page.evaluate(() => window.__sceneMode), true);
  assert.equal((await db()).canvases.presets.length, 3, "the first enable creates three independent scenes");
  assert.equal(await scenes.getByRole("tab").count(), 3);
  assert.equal(await scenes.getByRole("tab", { name: "场景 1", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await scenes.getByLabel("启用窗口捕捉", { exact: true }).count(), 0);
  assert.equal(await preview.isChecked(), false, "canvas preview is opt-in to avoid extra WebView work");
  assert.equal(await scenes.getByLabel("画布预览", { exact: true }).count(), 0);
  await preview.check();
  assert.equal((await db()).canvases.previewEnabled, true, "preview preference is persisted with scene settings");
  assert.equal(await scenes.getByLabel("画布预览", { exact: true }).count(), 1);
  assert.equal(await scenes.getByTitle(/画布 1 预览/).count(), 0, "preview is empty until a canvas is added");
  await addCanvas("template:folia"); await addCanvas("template:jizura");
  assert.equal(await scenes.getByTitle("画布 1 预览", { exact: true }).count(), 1);
  assert.equal(await scenes.getByTitle("画布 2 预览", { exact: true }).count(), 1);
  const saved = (await db()).canvases.presets[0].canvases;
  assert.equal(await scenes.getByTitle("画布 1 预览", { exact: true }).getAttribute("src"), `http://127.0.0.1:17842/canvas/${saved[0].id}`, "preview reuses the original canvas URL");
  await preview.uncheck();
  assert.equal(await scenes.locator('iframe[title$="预览"]').count(), 0, "turning preview off unmounts its webpages to stop background rendering");
  assert.deepEqual((await db()).canvases.presets[0].canvases, saved, "preview controls must not change canvas content or visibility");
  await preview.check();
  await page.evaluate(() => window.__remount());
  await page.waitForFunction(() => document.querySelector('[aria-label="启用画布预览"]')?.checked === true);
  assert.equal(await scenes.getByTitle("画布 2 预览", { exact: true }).count(), 1, "saved preview preference survives remount");
  assert.equal(saved[0].settings.foliaAppearance.glowColors.hanabi, "#ab1234");
  assert.equal(saved[1].settings.jizura.project.enabled.enter.pop, false, "each layer keeps a complete independent style snapshot");
  assert.deepEqual(await page.evaluate(() => window.__openedCanvases), [], "adding a layer creates a web source without starting a renderer process");
  await addCanvas("classic");
  const editor = scenes.getByLabel("画布 3 设置", { exact: true });
  assert.equal(await editor.getAttribute("open"), null, "per-layer settings start collapsed");
  await editor.locator("summary").click();
  await editor.getByLabel("字号", { exact: true }).fill("64");
  await editor.locator("summary").click();
  await editor.locator("summary").click();
  assert.equal(await editor.getByLabel("字号", { exact: true }).inputValue(), "64", "folding settings must preserve an unsaved draft");
  assert.equal((await db()).canvases.presets[0].canvases[2].settings.size, 42, "draft edits must not update saved capture settings");
  await page.evaluate(() => { window.__failWrite = true; });
  await editor.getByRole("button", { name: "保存画布设置", exact: true }).click();
  await scenes.getByText("canvas write failed", { exact: true }).waitFor();
  assert.equal((await db()).canvases.presets[0].canvases[2].settings.size, 42, "failed saving preserves the previous layer settings");
  await page.evaluate(() => { window.__failWrite = false; });
  await editor.getByRole("button", { name: "保存画布设置", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("lyrics-ui-db")).canvases.presets[0].canvases[2].settings.size === 64);
  assert.deepEqual((await db()).canvases.presets[0].canvases.slice(0, 2), saved, "editing one canvas cannot overwrite another canvas or template");
  await scenes.getByRole("tab", { name: "场景 2", exact: true }).click();
  await scenes.getByRole("tab", { name: "场景 1", exact: true }).click();
  assert.equal((await db()).canvases.presets[0].canvases[2].settings.size, 64, "saved layer settings survive switching scenes");
  await scenes.getByRole("button", { name: "删除画布 3", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__openedCanvases), [], "expanding, saving and collapsing settings never opens a window");
  const templateBaseline = (await db()).templates;
  await addCanvas("template:html");
  const htmlEditor = scenes.getByLabel("画布 3 设置", { exact: true });
  await htmlEditor.locator("summary").click();
  await htmlEditor.getByLabel("画布动态速度", { exact: true }).fill("7");
  await htmlEditor.getByLabel("画布动态颜色", { exact: true }).fill("#aabbcc");
  assert.deepEqual((await db()).canvases.presets[0].canvases[2].settings.customHtmlValues, { speed: 2, tint: "#112233" }, "dynamic parameters remain draft values until saved");
  await htmlEditor.getByRole("button", { name: "保存画布设置", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("lyrics-ui-db")).canvases.presets[0].canvases[2].settings.customHtmlValues.speed === 7);
  assert.deepEqual((await db()).canvases.presets[0].canvases[2].settings.customHtmlValues, { speed: 7, tint: "#aabbcc" });
  assert.deepEqual((await db()).canvases.presets[0].canvases.slice(0, 2), saved, "dynamic parameters apply only to the edited canvas");
  assert.deepEqual((await db()).templates, templateBaseline, "editing a canvas never updates its source template");
  await scenes.getByRole("button", { name: "删除画布 3", exact: true }).click();
  const foliaEditor = scenes.getByLabel("画布 1 设置", { exact: true });
  await foliaEditor.locator("summary").click();
  const foliaFrame = page.frameLocator('iframe[title="画布 Folia 歌词样式设置"]');
  await foliaFrame.locator("body").waitFor({ state: "attached" });
  const assetMessage = async (id, kind, origin = "http://127.0.0.1:17842", wrongSource = false, empty = false) => page.evaluate(({ id, kind, origin, wrongSource, empty }) => {
    const frame = document.querySelector('iframe[title="画布 Folia 歌词样式设置"]');
    dispatchEvent(new MessageEvent("message", { origin, source: wrongSource ? window : frame.contentWindow, data: { type: "folia-asset-import", id, kind, name: kind === "font" ? "test.woff2" : "test.png", blob: new Blob(empty ? [] : ["test-asset"]) } }));
  }, { id, kind, origin, wrongSource, empty });
  await assetMessage("bad-origin", "image", "http://untrusted.example");
  await assetMessage("bad-source", "font", "http://127.0.0.1:17842", true);
  await assetMessage("image-ok", "image");
  await assetMessage("font-ok", "font");
  const frame = page.frames().find(frame => frame.url().startsWith("http://127.0.0.1:17842/folia"));
  await frame.waitForFunction(() => window.__assetReplies.length === 2);
  assert.deepEqual(await frame.evaluate(() => window.__assetReplies.map(reply => [reply.id, reply.file]).sort()), [["font-ok", "test-font.woff2"], ["image-ok", "test-image.png"]], "valid messages receive successful replies in the originating iframe");
  assert.deepEqual(await page.evaluate(() => window.__assetCalls.map(call => call.command)), ["import_folia_image", "import_obs_lyrics_font"], "invalid origin/source cannot trigger an asset import");
  assert.equal(await page.evaluate(() => atob(window.__assetCalls[0].args.data)), "test-asset", "asset bytes reach the mock without corruption");
  await page.evaluate(() => { window.__failAssets = true; });
  await assetMessage("image-fail", "image"); await assetMessage("font-fail", "font");
  await frame.waitForFunction(() => window.__assetReplies.length === 4);
  assert.equal(await frame.evaluate(() => window.__assetReplies.filter(reply => reply.error?.includes("test asset import failed")).length), 2, "both image and font failures reply instead of leaving the iframe waiting");
  await assetMessage("empty-file", "image", "http://127.0.0.1:17842", false, true);
  await frame.waitForFunction(() => window.__assetReplies.length === 5);
  assert.equal(await page.evaluate(() => window.__assetCalls.length), 4, "invalid empty files are rejected before native import");
  await page.evaluate(() => { window.__failAssets = false; });
  await foliaEditor.locator("summary").click();
  assert.deepEqual((await db()).canvases.presets[0].canvases, saved, "asset replies and folded editors do not mutate persisted canvas settings");
  await scenes.getByRole("button", { name: "复制画布 1 地址", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copied), `http://127.0.0.1:17842/canvas/${saved[0].id}`);
  await windowToggle(1).check(); await windowToggle(2).check();
  assert.equal(await windowStatus(1).innerText(), "窗口已显示");
  await page.evaluate(() => { window.__deferHide = true; });
  await scenes.getByRole("button", { name: "隐藏画布 1", exact: true }).click();
  await page.waitForFunction(() => typeof window.__pendingCanvasHide === "function");
  assert.equal(await windowStatus(1).innerText(), "窗口已显示", "memory reclamation is reported only after helper exit confirmation");
  await page.evaluate(() => { window.__deferHide = false; window.__finishCanvasHide(); });
  await scenes.getByRole("button", { name: "显示画布 1", exact: true }).waitFor();
  assert.equal((await db()).canvases.presets[0].canvases[0].visible, false, "hiding applies to the webpage as well as the native window");
  assert.equal(await windowToggle(1).isChecked(), true, "hibernation retains the logical window for restoration");
  assert.equal(await windowStatus(1).innerText(), "窗口已隐藏");
  assert.equal(await windowStatus(2).innerText(), "窗口已显示");
  await page.evaluate(() => { window.__failVisibility = true; });
  await scenes.getByRole("button", { name: "显示画布 1", exact: true }).click();
  await scenes.getByText("window visibility failed", { exact: true }).waitFor();
  assert.equal(await windowStatus(1).innerText(), "窗口已隐藏");
  await page.evaluate(() => { window.__failVisibility = false; window.__remount(); });
  await scenes.getByRole("button", { name: "显示画布 1", exact: true }).click();
  assert.equal(await windowStatus(1).innerText(), "窗口已显示");
  await page.evaluate(() => { window.__failClose = true; });
  await windowToggle(1).click();
  await scenes.getByText("window close failed", { exact: true }).waitFor();
  assert.equal(await windowToggle(1).isChecked(), true, "a failed close must not claim capture stopped");
  await page.evaluate(() => { window.__failClose = false; });
  await windowToggle(1).uncheck();
  assert.deepEqual((await db()).canvases.presets[0].canvases, saved, "closing a window preserves the layer, URL and web visibility");
  await page.evaluate(id => window.__closeCanvasWindow(id), saved[1].id);
  assert.equal(await windowToggle(2).isChecked(), false);
  await page.evaluate(() => { window.__failOpen = true; });
  await windowToggle(1).click();
  await scenes.getByText("window open failed", { exact: true }).waitFor();
  assert.equal(await windowToggle(1).isChecked(), false);
  await page.evaluate(() => { window.__failOpen = false; });
  await windowToggle(1).check(); await page.evaluate(() => window.__remount());
  await page.waitForFunction(() => document.querySelector('[aria-label="启用画布 1 窗口"]')?.checked === true);
  assert.equal(await windowToggle(2).isChecked(), false, "remount reads real windows instead of assuming every layer is open");
  await page.evaluate(id => window.__canvasWindowError(id, "renderer disconnected"), saved[0].id);
  await scenes.getByText("歌词窗口出错：renderer disconnected", { exact: true }).waitFor();
  assert.equal(await windowToggle(1).isChecked(), false);
  await windowToggle(1).check(); await layerToggle(1).uncheck();
  assert.equal(await windowToggle(1).isChecked(), false, "disabling a layer closes its renderer");
  assert.equal(await windowToggle(1).isDisabled(), true);
  await scenes.getByRole("button", { name: "复制画布 1 地址", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copied), `http://127.0.0.1:17842/canvas/${saved[0].id}`);
  await layerToggle(1).check();
  await scenes.getByRole("button", { name: "隐藏画布 2", exact: true }).click();
  assert.equal(await windowToggle(2).isDisabled(), true, "a hidden web-only layer cannot accidentally start a renderer");
  await scenes.getByRole("button", { name: "显示画布 2", exact: true }).click();
  assert.equal(await windowToggle(2).isChecked(), false, "showing a webpage never creates a native window implicitly");
  await windowToggle(1).check();
  await scenes.getByRole("tab", { name: "场景 2", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__liveCanvasWindows), []);
  await addCanvas("classic");
  assert.equal((await db()).canvases.presets[1].canvases[0].settings.preset, "classic", "new scenes can use a built-in style directly");
  await scenes.getByRole("tab", { name: "场景 3", exact: true }).click();
  await scenes.getByLabel("歌词窗口管理控制台", { exact: true }).getByText("暂无歌词画布", { exact: true }).waitFor();
  await scenes.getByRole("tab", { name: "场景 1", exact: true }).click();
  assert.deepEqual((await db()).canvases.presets[0].canvases, saved, "scene switching preserves every scene's layers");
  await windowToggle(1).check(); await mode.uncheck();
  assert.equal(await page.evaluate(() => window.__sceneMode), false);
  assert.deepEqual(await page.evaluate(() => window.__liveCanvasWindows), []);
  assert.equal(await scenes.getByRole("tablist").count(), 0);
  await mode.check();
  assert.equal((await db()).canvases.presets.length, 3);
  assert.equal(await windowToggle(1).isChecked(), false);
  await page.screenshot({ path: fileURLToPath(new URL("desktop.png", out)), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: fileURLToPath(new URL("narrow.png", out)), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await scenes.getByRole("tab", { name: "场景 2", exact: true }).click();
  await scenes.getByLabel("画布 1 设置", { exact: true }).locator("summary").click();
  await scenes.getByLabel("画布 1 设置", { exact: true }).getByLabel("字号", { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("narrow-editor.png", out)), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "expanded canvas settings must fit a 390px viewport");
  await scenes.getByRole("tab", { name: "场景 1", exact: true }).click();
  await page.evaluate(saved => {
    const data = JSON.parse(localStorage.getItem("lyrics-ui-db"));
    data.canvases = { enabled: true, activeId: "already-enabled", presets: [{ id: "already-enabled", name: "现有场景", canvases: saved }] };
    localStorage.setItem("lyrics-ui-db", JSON.stringify(data)); window.__remount();
  }, saved);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("lyrics-ui-db")).canvases.presets.length === 3);
  assert.equal(await scenes.getByRole("tab").count(), 3, "already enabled legacy configurations migrate without requiring an off/on cycle");
  assert.equal(await preview.isChecked(), false, "legacy scene settings keep preview disabled by default");
  assert.deepEqual((await db()).canvases.presets[0].canvases, saved);
  await page.evaluate(saved => {
    const data = JSON.parse(localStorage.getItem("lyrics-ui-db"));
    const { enabled, visible, ...legacyCanvas } = saved[0];
    data.templates = [];
    data.canvases = { enabled: false, captureEnabled: false, activeId: "legacy-one", presets: [
      { id: "legacy-one", name: "旧双字幕", canvases: [legacyCanvas] },
      { id: "legacy-two", name: "旧备用", canvases: [saved[1]] },
      { id: "legacy-three", name: "旧第三", canvases: [] },
      { id: "legacy-four", name: "旧第四", canvases: [] },
    ] };
    localStorage.setItem("lyrics-ui-db", JSON.stringify(data)); window.__remount();
  }, saved);
  await page.waitForFunction(() => document.querySelector('[aria-label="启用场景模式"]')?.checked === false);
  await mode.check();
  assert.equal(await scenes.getByRole("tab").count(), 4, "migration preserves legacy scenes beyond the first three");
  assert.equal(await scenes.getByRole("tab", { name: "场景 1", exact: true }).innerText(), "旧双字幕");
  assert.equal(await layerToggle(1).isChecked(), true, "legacy layers without flags remain enabled and visible");
  assert.equal(await scenes.getByRole("button", { name: "隐藏画布 1", exact: true }).count(), 1);
  await addCanvas("folia-hanabi"); await addCanvas("jizura:noir");
  assert.equal((await db()).canvases.presets[0].canvases[1].settings.preset, "folia-hanabi");
  assert.equal((await db()).canvases.presets[0].canvases[2].settings.jizura.project.style, "noir", "fresh users can create Folia and JIZURA without a saved local style");
  await scenes.getByLabel("画布 2 歌词风格", { exact: true }).selectOption("neon");
  assert.equal((await db()).canvases.presets[0].canvases[1].settings.preset, "neon");
  const before = await db();
  await page.evaluate(() => { window.__failCanvasRead = true; window.__remount(); });
  await scenes.getByText(/读取歌词场景失败/).waitFor();
  assert.equal(await mode.isDisabled(), true); assert.deepEqual(await db(), before);
  await page.evaluate(() => { window.__failCanvasRead = false; });
  await scenes.getByRole("button", { name: "重新读取歌词场景", exact: true }).click();
  await page.evaluate(() => { window.__failWrite = true; });
  await mode.click(); await scenes.getByText("canvas write failed", { exact: true }).waitFor();
  assert.equal(await mode.isChecked(), true);
  assert.equal(await page.evaluate(() => window.__sceneMode), true, "failed writes must not tell the parent a mode change succeeded");
  assert.deepEqual(await db(), before); assert.deepEqual(errors, []);
  console.log("PASS: opt-in canvas previews with saved preference, original URLs and unmount on disable; scene tabs and legacy migration, parent callbacks, built-in/local/Folia/JIZURA styles, per-layer enable/visibility/window controls, confirmed hibernation, helper errors, scene isolation, preserved URLs, remount, primary filtering, narrow layout and read/write failures.");
} catch (error) {
  console.error(errors);
  await page?.screenshot({ path: fileURLToPath(new URL("failure.png", out)), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await vite.close();
  await unlink(html).catch(() => {}); await unlink(entry).catch(() => {});
}
