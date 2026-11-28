import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build, preview } from "vite";
import { readFile, mkdir } from "node:fs/promises";

const require = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json");
const { chromium } = require("playwright");
const legacyHtml = await readFile("src/obs-lyrics.html", "utf8");
const foliaHtml = '<!doctype html><html><head><link rel="stylesheet" href="/folia.css"></head><body><div id="root"></div><script type="module" src="/folia.js"></script></body></html>';
const foliaJs = await readFile("folia-overlay/dist/folia.js");
const foliaCss = await readFile("folia-overlay/dist/folia.css");
const outDir = "outputs/obs-lyrics-preview/fixture";

await build({
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: "scripts/fixtures/obs-lyrics-preview.html" },
  },
});
const server = await preview({ build: { outDir }, preview: { host: "127.0.0.1", port: 1438, strictPort: true } });
const browser = await chromium.launch({ headless: true, channel: "msedge" });

try {
  const page = await browser.newPage();
  const errors = [];
  let missingTranslation = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://127.0.0.1:17842/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/state")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          trackKey: "preview-fixture",
          title: "测试歌曲",
          artist: "测试歌手",
          positionMs: 500,
          durationMs: 4000,
          playing: true,
          lyrics: { synced: true, lines: [
            { timeMs: 0, text: "旧版歌词预览验证", trans: missingTranslation ? undefined : "中文译文", roman: "Test phonetics" },
            { timeMs: 3500, text: "Next English original" },
          ] },
          settings: { preset: "folia-partita" },
        }),
      });
    }
    if (url.endsWith("/lyrics") || url.endsWith("/folia")) {
      return route.fulfill({ contentType: "text/html", body: foliaHtml });
    }
    if (url.endsWith("/folia.js")) return route.fulfill({ contentType: "text/javascript", body: foliaJs });
    if (url.endsWith("/folia.css")) return route.fulfill({ contentType: "text/css", body: foliaCss });
    return route.fulfill({ contentType: "text/html", body: legacyHtml });
  });

  await page.goto("http://127.0.0.1:1438/scripts/fixtures/obs-lyrics-preview.html");
  const settings = page.locator("section");
  await settings.getByLabel("歌词风格", { exact: true }).waitFor();
  const folia = page.frameLocator('iframe[title="Folia 原版歌词预览"]');
  await folia.locator("#root > *").first().waitFor();
  const foliaFrame = page.frames().find((frame) => frame.url().endsWith("/folia"));
  assert(foliaFrame, "Folia renders in its own frame");
  await foliaFrame.waitForFunction(() => document.querySelector("#root")?.textContent.includes("验"), undefined, { timeout: 5000 })
    .catch(async (error) => {
      const text = await foliaFrame.locator("#root").textContent();
      throw new Error(`Folia did not render the fixture lyric. Text: ${text}; page errors: ${errors.join("; ")}`, { cause: error });
    });
  const expand = settings.getByRole("button", { name: "展开设置" });
  const panel = page.frameLocator('iframe[title="Folia 歌词样式设置"]');
  assert.equal(await settings.locator('iframe[title="Folia 歌词样式设置"]').count(), 0, "advanced settings do not crowd the preview by default");
  await expand.click();
  const tuning = panel.getByRole("slider").first();
  await tuning.waitFor();
  const initialValue = await tuning.inputValue();
  await tuning.press("End");
  if (await tuning.inputValue() === initialValue) await tuning.press("Home");
  assert.notEqual(await tuning.inputValue(), initialValue, "upstream style controls can update the active preset");
  const enabled = settings.getByRole("switch", { name: "自定义动画" });
  await enabled.uncheck();
  await panel.getByText("配色", { exact: true }).click();
  await panel.getByLabel("辅助色", { exact: true }).fill("#ff7788");
  await panel.getByLabel("光晕颜色", { exact: true }).fill("#ff2244");
  await foliaFrame.waitForFunction(() => [...document.querySelectorAll("span")].some(node =>
    [getComputedStyle(node).textShadow, getComputedStyle(node).filter].some(value => value.includes("255, 34, 68"))), undefined, { timeout: 5000 })
    .catch(async error => { throw new Error(JSON.stringify(await foliaFrame.evaluate(() => [...document.querySelectorAll("span")].slice(0, 25).map(node => ({ text: node.textContent, shadow: getComputedStyle(node).textShadow, filter: getComputedStyle(node).filter })))), { cause: error }); });
  await panel.getByText("字幕", { exact: true }).click();
  await panel.getByRole("slider").last().press("End");
  const translation = folia.locator('[data-subtitle-track="translation"]').getByText("中文译文", { exact: true }).first();
  await translation.waitFor();
  assert.equal(await translation.evaluate(node => getComputedStyle(node).color), "rgb(255, 119, 136)", "Folia preview renders the chosen subtitle color");
  await panel.getByRole("tab", { name: "全局" }).click();
  const backgroundToggle = panel.getByRole("switch", { name: "显示 Folia 原版背景" });
  const background = folia.locator("[data-folia-original-background]");
  assert.equal(await backgroundToggle.isChecked(), false, "existing OBS setups stay transparent");
  await backgroundToggle.check();
  await background.locator("> div").first().waitFor({ state: "attached" });
  await backgroundToggle.uncheck();
  await background.waitFor({ state: "detached" });
  assert.equal(await translation.isVisible(), true, "hiding the Folia background preserves subtitles");
  await settings.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => window.__lyricsSettings.foliaTuningEnabled?.partita === false
    && window.__lyricsSettings.foliaTunings?.partita
    && window.__lyricsSettings.foliaAppearance?.secondaryColor === "#ff7788"
    && window.__lyricsSettings.foliaAppearance?.glowColors?.partita === "#ff2244"
    && window.__lyricsSettings.foliaAppearance?.subtitleFontScale === 1.4);
  const style = settings.getByLabel("歌词风格", { exact: true });
  await panel.getByRole("tab", { name: "歌词动画" }).click();
  const modes = (await style.locator('optgroup[label="Folia 原版效果"] option').evaluateAll(options =>
    options.map(option => option.value))).filter(mode => mode !== "folia-partita");
  for (const mode of modes) {
    await style.selectOption(mode);
    await panel.locator(`[data-folia-mode="${mode.slice(6)}"]`).waitFor();
  }
  await style.selectOption("folia-monet");
  const monetPanel = panel.locator('[data-folia-mode="monet"]');
  await monetPanel.getByRole("button", { name: "上传肖像图" }).waitFor();
  await monetPanel.locator('input[type="file"]').setInputFiles({
    name: "fixture.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2FoAAAAASUVORK5CYII=", "base64"),
  });
  await monetPanel.getByRole("button", { name: "清空肖像图" }).waitFor();
  await monetPanel.getByText("fixture.png", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => window.__lyricsSettings.foliaAssets?.monet?.[0]?.file === `${"a".repeat(64)}.png`
    && window.__lyricsSettings.foliaTunings?.monet?.portraitSource === "custom");
  await panel.getByRole("tab", { name: "配色", exact: true }).click();
  await panel.getByLabel("光晕颜色", { exact: true }).fill("#2244ff");
  await style.selectOption("folia-partita");
  assert.equal(await panel.getByLabel("光晕颜色", { exact: true }).inputValue(), "#ff2244", "each Folia style restores its own halo color");
  await panel.getByRole("button", { name: "原版光晕配色", exact: true }).click();
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(() => window.__lyricsSettings.foliaAppearance?.glowColors?.partita === undefined
    && window.__lyricsSettings.foliaAppearance?.glowColors?.monet === "#2244ff");
  await settings.getByRole("button", { name: "收起设置" }).click();
  assert.equal(await settings.locator('iframe[title="Folia 歌词样式设置"]').count(), 0);
  await settings.getByLabel("歌词风格", { exact: true }).selectOption("classic");

  const previewFrame = page.frameLocator('iframe[title="OBS 歌词预览"]');
  await previewFrame.locator('#lyrics[data-preset="classic"]').waitFor({ state: "attached" });
  await previewFrame.locator("#current").getByText("旧版歌词预览验证").waitFor();
  const htmlExpand = settings.getByRole("button", { name: "展开设置", exact: true });
  assert.equal(await htmlExpand.getAttribute("aria-expanded"), "false", "HTML settings start collapsed without disabling animation");
  assert.equal(await settings.locator("#html-settings-panel").count(), 0);
  await htmlExpand.click();
  await settings.getByLabel("粒子溶解装饰", { exact: true }).check();
  await settings.getByLabel("装饰动效", { exact: true }).uncheck();
  const htmlEnabled = settings.getByRole("switch", { name: "自定义动画", exact: true });
  await htmlEnabled.uncheck();
  await style.selectOption("neon");
  assert.equal(await htmlEnabled.isChecked(), true, "disabling customization belongs to the selected HTML style");
  await style.selectOption("classic");
  assert.equal(await htmlEnabled.isChecked(), false, "switching back restores the saved animation choice");
  await previewFrame.locator('#lyrics[data-motion="on"][data-particle-dissolve="false"]').waitFor({ state: "attached" });
  assert.equal(await settings.getByLabel("粒子溶解装饰", { exact: true }).isEnabled(), false);
  await htmlEnabled.check();
  await previewFrame.locator('#lyrics[data-motion="off"][data-particle-dissolve="true"]').waitFor({ state: "attached" });
  await settings.getByRole("button", { name: "收起设置", exact: true }).click();
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(() => window.__lyricsSettings.htmlTuningEnabled === true
    && window.__lyricsSettings.motion === false && window.__lyricsSettings.particleDissolve === true);
  await mkdir("outputs/obs-lyrics-preview", { recursive: true });
  await page.screenshot({ path: "outputs/obs-lyrics-preview/html-collapsed-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "outputs/obs-lyrics-preview/html-collapsed-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "collapsed HTML controls fit the mobile viewport");
  await htmlExpand.click();
  assert.equal(await settings.getByLabel("粒子溶解装饰", { exact: true }).isChecked(), true, "collapsing the settings does not discard changes");
  await page.screenshot({ path: "outputs/obs-lyrics-preview/html-expanded-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "expanded HTML controls fit the mobile viewport");

  const iframeUrl = await page.locator('iframe[title="OBS 歌词预览"]').getAttribute("src");
  assert.equal(iframeUrl, "http://127.0.0.1:17842/lyrics-preview");
  missingTranslation = true;
  await page.goto("http://127.0.0.1:17842/folia");
  await page.waitForFunction(() => document.querySelector("#root")?.textContent.includes("验"));
  assert.equal(await page.locator("p").getByText("Next English original", { exact: true }).count(), 0,
    "a missing translation does not replace the subtitle with the next English original lyric");
  assert.deepEqual(errors, []);
  console.log(`PASS: ${modes.length + 1} Folia styles, theme color, subtitle scale, picture import, tuning persistence and legacy live preview`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
