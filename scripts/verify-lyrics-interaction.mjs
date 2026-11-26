import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = "outputs/lyrics-interaction";
const { chromium } = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json")("playwright");
await mkdir(output, { recursive: true });
await build({ root, build: { outDir: `${output}/build`, rollupOptions: { input: { main: "scripts/fixtures/lyrics-interaction.html", "desktop-lyrics": "desktop-lyrics.html" } } } });
const server = await preview({ root, build: { outDir: `${output}/build` }, preview: { host: "127.0.0.1", port: 1468, strictPort: false } });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const errors = [], checks = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__nativeCalls = [];
    window.__listeners = {};
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "desktop-lyrics" }, currentWebview: { label: "desktop-lyrics", windowLabel: "desktop-lyrics" } },
      invoke: async (command, args) => {
        window.__nativeCalls.push({ command, args });
        if (command === "plugin:event|listen") { window.__listeners[args.event] = args.handler; return 1; }
        if (command === "plugin:window|scale_factor") return devicePixelRatio;
        if (command === "plugin:window|inner_size") return { width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio };
        if (command === "plugin:window|is_always_on_top") return true;
        return null;
      },
      transformCallback: callback => callback,
      convertFileSrc: path => path,
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const origin = server.resolvedUrls.local[0];
  await page.goto(origin + "scripts/fixtures/lyrics-interaction.html");
  const rows = page.locator(".lyric-selectable");
  for (const theme of ["standard", "liquid", "skeuo"]) {
    for (const [width, height, scale] of [[1280, 880, 1], [860, 1100, 1.5]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ theme, scale }) => window.__theme(theme, "light", scale), { theme, scale });
      await rows.nth(1).waitFor();
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__seeks = []; });
      await rows.nth(1).click();
      await rows.nth(1).click();
      assert.deepEqual(await page.evaluate(() => window.__seeks), [], "Selecting or double clicking lyric text must never seek");
      assert.equal(await page.locator(".lyric-seek-button").count(), 1, "Only the selected line offers a play button");
      await rows.nth(2).click();
      const bounds = await rows.nth(2).evaluate(row => {
        const button = row.querySelector("button").getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(row.querySelector(".lyric-fill-ov > span"));
        const clips = [];
        for (let parent = row.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|hidden|scroll)/.test(getComputedStyle(parent).overflowY)) clips.push(parent.getBoundingClientRect().toJSON());
        }
        return { button: button.toJSON(), row: row.getBoundingClientRect().toJSON(), textRight: Math.max(...[...range.getClientRects()].map(rect => rect.right)), clips };
      });
      assert(bounds.button.left > bounds.textRight, "Wrapped lyric text must not cover the play button");
      assert(bounds.button.right <= bounds.row.right && bounds.button.left > bounds.row.left + bounds.row.width / 2, "Play stays at the far right inside its lyric row");
      assert(bounds.clips.every(clip => bounds.button.top >= clip.top && bounds.button.bottom <= clip.bottom), "The play button must be fully visible inside scrolling panels");
      await page.screenshot({ path: `${output}/${theme}-${width}.png` });
      await page.locator(".lyric-seek-button").click();
      assert.deepEqual(await page.evaluate(() => window.__seeks), [120000], "Only confirming the selected line seeks to its own timestamp");
      assert.equal(await page.locator(".lyric-seek-button").count(), 0, "Confirmation clears the pending selection");
      await rows.nth(1).focus();
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.__seeks), [120000], "Keyboard selection must also require confirmation");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.__seeks), [120000, 60000], "The play button remains keyboard accessible");
      await rows.nth(1).focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      assert.deepEqual(await page.evaluate(() => window.__seeks), [120000, 60000, 60000], "Space selects and confirms through separate actions");
      assert.equal(await page.evaluate(() => window.__globalSpace), 0, "Lyric controls must not trigger the global playback shortcut");
      await rows.nth(1).click();
      await page.evaluate(() => window.__replaceLyrics());
      await page.waitForTimeout(50);
      assert.equal(await page.locator(".lyric-seek-button").count(), 0, "Reloaded lyrics invalidate a pending selection");
      await rows.nth(1).click();
      await page.evaluate(() => window.__changeTrack());
      await page.waitForTimeout(50);
      assert.equal(await page.locator(".lyric-seek-button").count(), 0, "Changing tracks clears a stale play target");
      await page.evaluate(() => window.__play(true));
      await page.waitForTimeout(100);
      assert.equal(await page.locator(".lyric-line.active").count(), 1, "Normal playback still tracks and fills the active lyric");
      await page.evaluate(() => window.__play(false));
      checks.push({ theme, width, scale, twoStepSeek: true, keyboard: true, wraps: true });
    }
  }
  await page.close();
  for (const dpr of [1, 1.5, 2]) {
    const desktop = await browser.newContext({ viewport: { width: 800, height: 260 }, deviceScaleFactor: dpr });
    await desktop.addInitScript(() => {
      window.__bounds = [];
      window.__listeners = {};
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "desktop-lyrics" }, currentWebview: { label: "desktop-lyrics", windowLabel: "desktop-lyrics" } },
        invoke: async (command, args) => {
          if (command === "desktop_lyrics_set_bounds") window.__bounds.push(args.bounds);
          if (command === "plugin:event|listen") { window.__listeners[args.event] = args.handler; return 1; }
          if (command === "plugin:window|scale_factor") return devicePixelRatio;
          if (command === "plugin:window|inner_size") return { width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio };
          if (command === "plugin:window|is_always_on_top") return true;
          return null;
        },
        transformCallback: callback => callback,
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    });
    const overlay = await desktop.newPage();
    overlay.on("pageerror", error => errors.push(error.message));
    await overlay.goto(origin + "desktop-lyrics.html");
    await overlay.waitForFunction(() => !!window.__listeners["dlyrics://push"]);
    const push = text => overlay.evaluate(text => window.__listeners["dlyrics://push"]({ payload: { synced: true, pos: 1000, dur: 180000, playing: false, lines: [{ timeMs: 0, text }] } }), text);
    await push("贴合歌词");
    await overlay.waitForTimeout(200);
    const compact = await overlay.evaluate(() => window.__bounds.at(-1));
    assert(compact[1] > 150 && compact[2] - compact[0] < 300, "The native region must exclude the large transparent space above and beside short lyrics");
    await overlay.mouse.move(400, 220);
    await overlay.waitForTimeout(100);
    const hover = await overlay.evaluate(() => window.__bounds.at(-1));
    assert(hover[1] < compact[1], "Hover expands the native region to include the toolbar");
    await overlay.getByTitle("下一首", { exact: true }).click();
    await overlay.mouse.move(0, 0);
    await overlay.waitForTimeout(1100);
    await push("更长的歌词内容出现时原生区域也要跟着变宽");
    await overlay.waitForTimeout(200);
    const expanded = await overlay.evaluate(() => window.__bounds.at(-1));
    assert(expanded[2] - expanded[0] > compact[2] - compact[0], "A longer line expands the region without resizing the font basis");
    await push("短句");
    await overlay.waitForTimeout(200);
    const short = await overlay.evaluate(() => window.__bounds.at(-1));
    assert(short[2] - short[0] < expanded[2] - expanded[0], "A shorter line releases the previous mouse interception area");
    await overlay.setViewportSize({ width: 420, height: 180 });
    await overlay.waitForTimeout(200);
    const resized = await overlay.evaluate(() => window.__bounds.at(-1));
    assert(resized[2] <= 420 && resized[3] <= 180, "Resizing keeps the region in the current viewport");
    await overlay.screenshot({ path: `${output}/desktop-${dpr}.png`, omitBackground: true });
    checks.push({ desktopDpr: dpr, compact, hover, expanded, short, resized });
    await desktop.close();
  }
  assert.deepEqual(errors, [], "The changed lyric views must have no uncaught browser errors");
  await writeFile(`${output}/verification.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log("PASS: two-step lyric seek in all themes, long lines at 150% zoom, keyboard confirmation and selection reset; desktop content/toolbar bounds at 100%, 150%, 200% DPI.");
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
