import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { build, preview } from "vite";

const require = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json");
const { chromium } = require("playwright");
const html = "_custom-lyric-style-test.html";
const entry = "_custom-lyric-style-test.tsx";
const out = "outputs/custom-lyric-style-test";
await mkdir(out, { recursive: true });
await writeFile(html, '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/_custom-lyric-style-test.tsx"></script>');
await writeFile(entry, `import React from "react";
import {createRoot} from "react-dom/client";
import "./src/index.css";
import App from "./src/App";
import {useStore} from "./src/store";
import {setLanguagePref} from "./src/i18n";
import {applyUiTheme} from "./src/theme";
setLanguagePref("zh");
applyUiTheme("standard");
useStore.setState({view: "liked", uiTheme: "standard", ready: true, init: async () => {}, refreshCacheBytes: async () => {}});
createRoot(document.getElementById("root")).render(<App/>);`);
let server, browser;
try {
  await build({ build: { outDir: `${out}/build`, rollupOptions: { input: html } } });
  server = await preview({ build: { outDir: `${out}/build` }, preview: { host: "127.0.0.1", port: 1458, strictPort: true } });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", error => console.error(error.message));
  await page.addInitScript(() => {
    window.__savedLyrics = [];
    window.__clipboard = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.__clipboard = text; },
    } });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: fn => fn,
      convertFileSrc: path => path,
      invoke: async (cmd, args) => {
        if (cmd === "get_obs_lyrics_settings") return JSON.stringify({ preset: "classic", customHtml: "", customHtmlValues: {} });
        if (cmd === "fetch_lyrics_styles") return { version: "1.0.0", styles: [] };
        if (cmd === "set_obs_lyrics_settings") { window.__savedLyrics.push(JSON.parse(args.settings)); return null; }
        if (cmd === "list_output_devices") return { devices: [], current: "", preference: null };
        if (cmd === "taskbar_lyrics_list_displays") return [];
        if (cmd === "fetch_ai_model_catalog" || cmd === "list_ai_models") return [];
        if (cmd === "get_ai_runtime_settings") return { modelId: "", gpuPercent: 60, memoryMb: 0 };
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.goto(`http://127.0.0.1:1458/${html}`);
  const openWebLyrics = page.locator('[data-player-popover="webLyrics"] > button');
  const webLyricsPanel = page.getByRole("dialog", { name: "网页歌词", exact: true });
  await openWebLyrics.click();
  assert.deepEqual(await webLyricsPanel.getByRole("button").allTextContents(), ["复制 OBS 浏览器地址", "跳转到设置"]);
  await webLyricsPanel.getByRole("button", { name: "复制 OBS 浏览器地址", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__clipboard), "http://127.0.0.1:17842/lyrics");
  await webLyricsPanel.getByRole("button", { name: "跳转到设置", exact: true }).click();
  await webLyricsPanel.waitFor({ state: "detached" });
  async function verifyObsSectionIsTop() {
    const geometry = () => {
      const section = document.getElementById("settings-web-lyrics");
      const scroll = section?.parentElement?.parentElement;
      if (!section || !scroll) return null;
      return { offset: section.getBoundingClientRect().top - scroll.getBoundingClientRect().top, top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight };
    };
    await page.waitForFunction(() => !document.querySelector(".anim-view")?.getAnimations().some(animation => animation.playState === "running"));
    const bounds = await page.evaluate(geometry);
    assert(bounds && bounds.offset >= -2 && bounds.offset <= 20, `OBS heading is positioned at the top of the settings scroller: ${JSON.stringify(bounds)}`);
  }
  const create = page.getByRole("button", { name: "新建歌词样式", exact: true });
  await create.waitFor();
  const obsSection = page.locator("#settings-web-lyrics");
  await verifyObsSectionIsTop();
  await obsSection.evaluate(section => section.parentElement.parentElement.scrollTop = 0);
  await openWebLyrics.click();
  await webLyricsPanel.getByRole("button", { name: "跳转到设置", exact: true }).click();
  await verifyObsSectionIsTop();
  await obsSection.getByText("制作歌词页面", { exact: true }).click();
  await obsSection.getByRole("button", { name: "复制HTML 提示词", exact: true }).click();
  assert.match(await page.evaluate(() => window.__clipboard), /播放器识别字段/);
  await obsSection.getByRole("button", { name: "复制完整 HTML 示例", exact: true }).click();
  assert.match(await page.evaluate(() => window.__clipboard), /^<!doctype html>/);
  const secondary = obsSection.getByLabel("网页歌词副行", { exact: true });
  await secondary.selectOption("romanization");
  assert.equal(await page.evaluate(() => localStorage.getItem("rustmusic.lyricsAltMode")), "romanization");
  await create.click();
  const editor = page.getByRole("textbox", { name: "自定义歌词 HTML", exact: true });
  await page.waitForFunction(() => document.querySelector("#settings-custom-lyric-html")?.value.includes('data-rustmusic-slot="current"'));
  const frame = page.frameLocator('iframe[title="自定义歌词样式预览"]');
  await frame.getByText("让每句歌词都有自己的光").waitFor();
  await page.getByLabel("歌词风格").selectOption("classic");
  assert.equal(await editor.count(), 0, "Selecting a regular preset hides the custom HTML editor");
  await page.getByLabel("歌词风格").selectOption("custom-html");
  assert((await editor.inputValue()).includes('data-rustmusic-slot="current"'), "Switching styles preserves the custom HTML source");
  await frame.getByText("让每句歌词都有自己的光").waitFor();
  await obsSection.getByLabel("已唱歌词颜色", { exact: true }).fill("#78abc0");
  await obsSection.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(() => window.__savedLyrics.length > 0);
  const saved = await page.evaluate(() => window.__savedLyrics.at(-1));
  assert.equal(saved.preset, "custom-html");
  assert.equal(saved.customHtmlEnabled, true);
  assert(saved.customHtml.includes('data-rustmusic-slot="current"'));
  assert.equal(saved.customHtmlValues["sung-color"], "#78abc0", "HTML-declared controls stay usable from the OBS settings");
  await page.getByLabel("歌词风格").selectOption("folia-hanabi");
  assert.equal(await editor.count(), 0, "Folia uses its own renderer and cannot expose the editable HTML field");
  assert.match(await obsSection.locator("code").innerText(), /127\.0\.0\.1:17842\/lyrics$/, "OBS always keeps one public URL suffix");
  assert.equal(await page.locator('iframe[title="Folia 原版歌词预览"]').getAttribute("src"), "http://127.0.0.1:17842/folia", "Folia preview stays on its independent renderer route");
  await page.getByLabel("歌词风格").selectOption("custom-html");
  assert.equal(await editor.count(), 1, "The regular HTML editor remains available after leaving Folia");
  assert.match(await obsSection.locator("code").innerText(), /127\.0\.0\.1:17842\/lyrics$/, "Returning to HTML does not change the copied OBS URL");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Settings layout does not overflow at 1100px");
  await writeFile(`${out}/verification.json`, JSON.stringify({
    passed: true,
    checks: ["popover has only the OBS copy and settings shortcuts", "settings deep link works both from another view and within settings", "HTML guide copies prompt and sample", "secondary lyric preference is preserved", "create button opens custom style", "sample HTML preview renders", "regular preset hides editor without losing source", "save persists custom HTML and its declared fields", "settings width has no horizontal overflow"],
  }, null, 2));
  console.log("PASS: OBS popover, settings deep link, prompt and example copy, secondary lyrics, and custom HTML preview and save");
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve());
  await unlink(html).catch(() => {});
  await unlink(entry).catch(() => {});
}
