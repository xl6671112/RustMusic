import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json")("playwright");
const html = "_named-lyrics-test.html", entry = "_named-lyrics-test.tsx", out = "outputs/named-lyrics-styles";
let server, browser;
try {
  await mkdir(out, { recursive: true });
  await writeFile(html, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/_named-lyrics-test.tsx"></script>');
  await writeFile(entry, 'import React from "react";import{createRoot}from"react-dom/client";import"./src/index.css";import ObsLyricsSettings from"./src/components/ObsLyricsSettings";createRoot(document.getElementById("root")).render(<main style={{maxWidth:900,margin:"auto",padding:12}}><ObsLyricsSettings/></main>);');
  server = await createServer({ optimizeDeps: { entries: [html] }, server: { host: "127.0.0.1", port: 1460, strictPort: true, watch: { ignored: ["**/src-tauri/target/**", "**/outputs/**", "**/_release/**"] } } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return null;
        if (command === "validate_obs_lyrics_template") return null;
        if (command === "get_obs_lyrics_settings") return localStorage.getItem("settings") || '{}';
        if (command === "set_obs_lyrics_settings") {
          if (JSON.parse(args.settings).preset === "custom-html") throw Error("Invalid lyrics preset");
          localStorage.setItem("settings", args.settings); return null;
        }
        if (command === "get_obs_lyrics_templates") return localStorage.getItem("templates") || '[]';
        if (command === "set_obs_lyrics_templates") {
          if (window.failWrite) throw Error("style write failed");
          localStorage.setItem("templates", args.templates); return null;
        }
        if (command === "get_obs_lyrics_canvases") return '{"enabled":false,"activeId":"","presets":[]}';
        if (command === "get_obs_lyrics_api") return { enabled: true, url: "http://127.0.0.1:17844", apiKey: "fixture" };
        if (command === "fetch_lyrics_styles") return { version: "1.1.0", styles: [] };
        throw Error(command);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.route("http://127.0.0.1:17842/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }));
  await page.goto(`http://127.0.0.1:1460/${html}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const styles = page.getByLabel("歌词风格", { exact: true });
  const name = page.getByLabel("新歌词风格名称", { exact: true });
  const save = page.getByRole("button", { name: "保存设置", exact: true });
  const fontSize = page.getByRole("spinbutton", { name: "字号", exact: true });
  const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("templates") || '[]'));
  async function create(label) {
    await name.fill(label);
    await page.getByRole("button", { name: "另存为新风格", exact: true }).click();
    await page.waitForFunction(label => JSON.parse(localStorage.getItem("templates") || '[]').some(item => item.name === label), label);
    return (await db()).find(item => item.name === label);
  }
  async function persist() { await save.click(); await page.getByRole("status").getByText("已保存", { exact: true }).waitFor(); }
  await name.waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="新歌词风格名称"]').disabled);
  await page.getByRole("button", { name: "展开设置", exact: true }).click();
  await name.fill("我的白字");
  await fontSize.fill("66"); await persist();
  const first = (await db())[0];
  console.log("Checked original save-as.");
  assert.equal(await styles.inputValue(), `template:${first.id}`, "saving an edited original must automatically create and select a named copy");
  assert.equal((await db())[0].settings.size, 66, "saving edits must update the chosen reusable style");
  assert.equal((await db())[0].settings.localStyleId, undefined, "portable snapshots cannot retain a machine-local style identity");
  await fontSize.fill("68"); await persist();
  assert.equal((await db()).length, 1, "saving an already saved style must edit it without creating another copy");
  assert.equal((await db())[0].settings.size, 68);
  const second = await create("大号白字");
  await fontSize.fill("72"); await persist();
  await styles.selectOption(`template:${first.id}`);
  assert.equal(await fontSize.inputValue(), "68", "styles sharing the same renderer must keep independent settings");
  await styles.selectOption(`template:${second.id}`);
  assert.equal(await fontSize.inputValue(), "72");
  await persist(); await page.reload();
  await page.waitForFunction(id => document.querySelector('[aria-label="歌词风格"]').value === `template:${id}`, second.id);
  await page.getByRole("button", { name: "展开设置", exact: true }).click();
  assert.equal(await fontSize.inputValue(), "72", "selected named style and edits must survive reopening settings");
  console.log("Checked custom edit, save-as and reopen.");
  await styles.selectOption("classic");
  assert.equal(await fontSize.inputValue(), "42", "custom edits must not overwrite the original built-in style");
  await name.fill("我的白字"); await page.getByRole("button", { name: "另存为新风格", exact: true }).click();
  await page.getByText("Error: 已有同名歌词风格，请换一个名称", { exact: true }).waitFor();
  assert.equal((await db()).length, 2, "duplicate names cannot overwrite an existing style");
  await page.evaluate(() => { window.failWrite = true; });
  await name.fill("失败风格"); await page.getByRole("button", { name: "另存为新风格", exact: true }).click();
  await page.getByText("Error: style write failed", { exact: true }).waitFor();
  assert.equal((await db()).length, 2, "a failed create must preserve saved styles and current selection");
  assert.equal(await styles.inputValue(), "classic");
  await page.evaluate(() => { window.failWrite = false; });
  await name.fill("");
  await fontSize.fill("55"); await persist();
  const automatic = (await db())[2];
  assert.equal(automatic.settings.size, 55, "automatic save-as must keep visible edits");
  assert.notEqual(automatic.id, first.id);
  await styles.selectOption("classic");
  assert.equal(await fontSize.inputValue(), "42");
  await fontSize.fill("57"); await persist();
  assert.equal((await db()).length, 4, "saving the original again must generate another preset instead of overwriting an earlier copy");
  assert.notEqual((await db())[3].name, automatic.name, "automatic names must stay distinct");
  await styles.selectOption("folia-hanabi");
  const folia = await create("我的花火");
  assert.equal(folia.settings.preset, "folia-hanabi", "Folia must offer the same direct creation entry as HTML");
  await page.evaluate(id => {
    localStorage.setItem("templates", JSON.stringify(JSON.parse(localStorage.getItem("templates")).filter(template => template.id !== id)));
    window.dispatchEvent(new Event("obs-lyrics-templates-changed"));
  }, folia.id);
  await page.waitForFunction(() => !document.querySelector('[aria-label="歌词风格"]').value.startsWith("template:"));
  assert.equal((await db()).length, 4, "removing a template must remove its named style entry without deleting others");
  await name.fill(""); await persist();
  assert.equal((await db()).length, 5, "deleting an active custom style must clear its stale identity so the next save creates a copy");
  await styles.selectOption("custom-html"); await persist();
  const htmlSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("settings")));
  assert.equal(htmlSaved.preset, "classic", "custom HTML must use the native renderer's accepted baseline when saving a copy");
  assert.equal(htmlSaved.customHtmlEnabled, true);
  assert.ok(htmlSaved.customHtml.length > 0);
  console.log("Checked original isolation, failures, deletion and HTML save-as.");
  await styles.selectOption("classic");
  const shareId = "b".repeat(64);
  let releaseImport, importStarted;
  const importGate = new Promise(resolve => { releaseImport = resolve; });
  const started = new Promise(resolve => { importStarted = resolve; });
  await page.route(`https://music.xn--hlr32k.com/api/lyrics-templates/${shareId}`, async route => {
    importStarted(); await importGate;
    await route.fulfill({ json: { format: "rustmusic-lyrics-template", version: 1, name: "导入风格", settings: first.settings, files: {} } });
  });
  await page.getByRole("button", { name: "导入歌词风格", exact: true }).click();
  await page.getByLabel("歌词风格分享链接", { exact: true }).fill(`https://music.xn--hlr32k.com/lyrics-template/${shareId}`);
  await page.getByRole("button", { name: "导入链接", exact: true }).click(); await started;
  const concurrent = await create("导入期间新建");
  releaseImport();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("templates")).some(item => item.name === "导入风格"));
  assert.equal((await db()).some(item => item.id === concurrent.id), true, "a delayed import must preserve styles saved through the other entry while waiting");
  await styles.selectOption(`template:${first.id}`);
  await page.screenshot({ path: `${out}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "style creation controls must fit narrow settings panels");
  await page.screenshot({ path: `${out}/narrow.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: automatic save-as for originals, custom edit and save-as, independent presets, persistent selection, intact originals, naming and write failures, Folia, deletion, concurrent import and narrow layout.");
} catch (error) {
  console.error(error);
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) console.error((await page.locator('[role="status"]').allTextContents()).join(" | "));
  throw error;
} finally {
  await browser?.close(); await server?.close();
  await unlink(html).catch(() => {}); await unlink(entry).catch(() => {});
}
