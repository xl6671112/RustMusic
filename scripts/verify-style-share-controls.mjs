import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json")("playwright");
const html = "_style-share-test.html", entry = "_style-share-test.tsx", out = "outputs/style-share-controls";
let server, browser;
try {
  await mkdir(out, { recursive: true });
  await writeFile(html, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/_style-share-test.tsx"></script>');
  await writeFile(entry, 'import React from "react";import{createRoot}from"react-dom/client";import"./src/index.css";import ObsLyricsSettings from"./src/components/ObsLyricsSettings";import{initial}from"./src/obsLyricsPresets";window.fixtureInitial=initial;createRoot(document.getElementById("root")).render(<main style={{maxWidth:900,margin:"auto",padding:12}}><ObsLyricsSettings/></main>);');
  server = await createServer({ optimizeDeps: { entries: [html] }, server: { host: "127.0.0.1", port: 1461, strictPort: true, watch: { ignored: ["**/src-tauri/target/**", "**/outputs/**", "**/_release/**"] } } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners=new Map();let nextListener=1;
    window.primaryWindows=[];
    window.primaryEvent=(open,visible=true)=>{
      window.primaryWindows=open?[{id:"primary",visible}]:[];
      for(const {event,handler} of listeners.values())if(event==="obs-lyrics-canvas-window")handler({payload:{id:"primary",open,visible}});
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { if (window.clipboardFails) throw Error("clipboard unavailable"); window.copied = text; } } });
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => callback,
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") {const id=nextListener++;listeners.set(id,args);return id;}
        if (command === "plugin:event|unlisten") {listeners.delete(args.eventId);return null;}
        if (command === "validate_obs_lyrics_template") return null;
        if (command === "get_obs_lyrics_settings") return localStorage.getItem("settings") || '{}';
        if (command === "set_obs_lyrics_settings") { localStorage.setItem("settings", args.settings); return null; }
        if (command === "get_obs_lyrics_templates") return localStorage.getItem("templates") || '[]';
        if (command === "set_obs_lyrics_templates") { localStorage.setItem("templates", args.templates); return null; }
        if (command === "get_obs_lyrics_canvases") return localStorage.getItem("canvases")||'{"enabled":false,"activeId":"","presets":[]}';
        if (command === "set_obs_lyrics_canvases") {localStorage.setItem("canvases",args.canvases);if(JSON.parse(args.canvases).enabled)window.primaryEvent(false);return null;}
        if (command === "get_open_obs_lyrics_canvases") return window.primaryWindows;
        if (command === "open_obs_lyrics_canvas"||command === "close_obs_lyrics_canvas"||command === "set_obs_lyrics_canvas_visibility") {
          if(window.failPrimary)throw Error("native window failed");
          if(args.id!=="primary")throw Error("unexpected canvas");
          if(command==="open_obs_lyrics_canvas")window.primaryEvent(true);
          else if(command==="close_obs_lyrics_canvas")window.primaryEvent(false);
          else if(!window.deferVisibility)window.primaryEvent(true,args.visible);
          return null;
        }
        if (command === "get_obs_lyrics_api") return { enabled: true, url: "http://127.0.0.1:17844", apiKey: "fixture" };
        if (command === "fetch_lyrics_styles") return { version: "1.1.0", styles: [] };
        throw Error(command);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.route("http://127.0.0.1:17842/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }));
  const shareUrl = `https://music.xn--hlr32k.com/lyrics-template/${"c".repeat(64)}`;
  let uploaded;
  await page.route("https://music.xn--hlr32k.com/api/lyrics-templates**", async route => {
    if (route.request().method() === "POST") {
      uploaded = JSON.parse(route.request().postData());
      await route.fulfill({ json: { url: shareUrl } });
    } else {
      const settings = await page.evaluate(() => ({ ...window.fixtureInitial, preset: "folia-hanabi", foliaAppearance: { glowColors: { hanabi: "#ab1234" } } }));
      await route.fulfill({ json: { format: "rustmusic-lyrics-template", version: 1, name: "我的花火", settings, files: {} } });
    }
  });
  await page.goto(`http://127.0.0.1:1461/${html}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const styles = page.getByLabel("歌词风格", { exact: true });
  const name = page.getByLabel("新歌词风格名称", { exact: true });
  const share = page.getByRole("button", { name: "分享歌词风格", exact: true });
  const importButton = page.getByRole("button", { name: "导入歌词风格", exact: true });
  const saveAs = page.getByRole("button", { name: "另存为新风格", exact: true });
  const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("templates") || '[]'));
  await name.waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="新歌词风格名称"]').disabled);
  assert.equal(await page.getByLabel("我的歌词模板", { exact: true }).count(), 0, "the duplicate template management panel must be removed");
  assert.equal(await share.count(), 0, "built-in styles must not show a share action");
  assert.equal(await page.getByLabel("歌词风格分享链接", { exact: true }).count(), 0, "import stays collapsed until requested");
  for (const preset of ["classic", "folia-hanabi", "jizura:noir"]) {
    await styles.selectOption(preset);
    assert.equal(await share.count(), 0);
    await name.fill(preset === "folia-hanabi" ? "我的花火" : `我的${preset}`);
    await saveAs.click();
    await share.waitFor();
    assert.match(await styles.inputValue(), /^template:/, "save-as must immediately select the new editable local style");
    await share.click();
    await page.waitForFunction(() => !!window.copied);
    assert.equal(await page.evaluate(() => window.copied), shareUrl);
    assert.equal(uploaded.settings.preset, preset.startsWith("jizura:") ? "jizura" : preset, "all three renderer families use the same share control");
    await page.evaluate(() => { window.copied = ""; });
  }
  await styles.selectOption("classic");
  await importButton.click();
  await page.getByLabel("歌词风格分享链接", { exact: true }).fill("https://example.com/untrusted");
  await page.getByRole("button", { name: "导入链接", exact: true }).click();
  await page.getByText(/导入失败：.*有效的 RustMusic/).waitFor();
  assert.equal((await db()).length, 3, "invalid links cannot alter saved styles");
  await page.getByLabel("歌词风格分享链接", { exact: true }).fill(shareUrl);
  await page.getByRole("button", { name: "导入链接", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("templates")).length === 4);
  const imported = (await db())[3];
  assert.equal(imported.name, "我的花火 (2)", "imported styles must preserve existing same-name local styles");
  assert.equal(await styles.inputValue(), `template:${imported.id}`);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("已保存", { exact: true }).waitFor();
  assert.equal((await db()).length, 4, "saving an imported local style must edit it rather than create a duplicate");
  await page.evaluate(() => { window.clipboardFails = true; });
  await share.click();
  await page.getByText("分享链接已生成，可选中复制", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("生成的风格分享链接", { exact: true }).inputValue(), shareUrl);
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await importButton.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "controls and share URL must fit narrow settings panels");
    const [selectBox, shareBox, saveBox, importBox] = await Promise.all([styles.boundingBox(), share.boundingBox(), saveAs.boundingBox(), importButton.boundingBox()]);
    assert.equal(selectBox.y, shareBox.y, "share must sit beside the style selector");
    assert.equal(saveBox.y, importBox.y, "import must sit beside save-as even on narrow screens");
    await page.screenshot({ path: `${out}/${width}.png`, fullPage: true });
    await importButton.click();
  }
  const enableWindow=page.getByLabel("启用歌词窗口",{exact:true});
  const sceneMode=page.getByLabel("启用场景模式",{exact:true});
  await enableWindow.check();
  assert.equal(await enableWindow.isChecked(),true,"native ready events must set logical window state");
  await page.evaluate(()=>{window.deferVisibility=true});
  await page.getByRole("button",{name:"隐藏歌词窗口",exact:true}).click();
  assert.equal(await page.getByRole("button",{name:"显示歌词窗口",exact:true}).isDisabled(),true,"a hide request cannot claim memory reclamation before native confirmation");
  await page.evaluate(()=>{window.deferVisibility=false;window.primaryEvent(true,false)});
  assert.equal(await enableWindow.isChecked(),true,"hibernation retains a logical window that can be shown again");
  await page.evaluate(()=>{window.failPrimary=true});
  await page.getByRole("button",{name:"显示歌词窗口",exact:true}).click();
  await page.getByText(/歌词窗口操作失败：.*native window failed/).waitFor();
  assert.equal(await page.getByRole("button",{name:"隐藏歌词窗口",exact:true}).isDisabled(),true,"failed show must preserve the real hidden state");
  await page.evaluate(()=>{window.failPrimary=false});
  await page.getByRole("button",{name:"显示歌词窗口",exact:true}).click();
  await page.evaluate(()=>window.primaryEvent(false));
  assert.equal(await enableWindow.isChecked(),false,"closing the native window externally must clear the checkbox");
  await enableWindow.check();
  await enableWindow.uncheck();
  assert.equal(await page.getByRole("button",{name:"显示歌词窗口",exact:true}).count(),0,"disabling must remove native controls after the close event");
  await enableWindow.check();
  await sceneMode.check();
  await styles.waitFor({state:"hidden"});
  assert.equal(await enableWindow.count(),0,"scene mode must hide all single-lyrics window controls");
  assert.equal(await page.getByRole("button",{name:"复制歌词地址",exact:true}).count(),0);
  assert.equal(await page.locator('iframe[title*="歌词预览"]').count(),0,"hidden single mode must unmount the renderer preview");
  assert.equal(await page.getByRole("button",{name:"保存设置",exact:true}).count(),0);
  assert.equal(await page.getByText("本机 AI 控制",{exact:true}).count(),1,"AI controls remain available in scene mode");
  await page.reload();
  await sceneMode.waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="启用场景模式"]').checked);
  assert.equal(await styles.count(),0,"persisted scene mode must not reveal the old single editor on reopening");
  await sceneMode.uncheck();
  await styles.waitFor();
  assert.equal(await enableWindow.isChecked(),false,"returning from a scene cannot restore a closed primary window implicitly");
  assert.deepEqual(errors, []);
  console.log("PASS: local-only sharing/import and desktop/narrow placement; scene-mode separation/persistence, shared AI controls, primary native events, hibernation, failures and external close.");
} finally {
  await browser?.close(); await server?.close();
  await unlink(html).catch(() => {}); await unlink(entry).catch(() => {});
}
