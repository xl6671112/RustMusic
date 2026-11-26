import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const runtimeRequire = createRequire("C:/Users/xiaolan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.package.json");
const { chromium } = runtimeRequire("playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const html = new URL("../_accompaniment-badges.html", import.meta.url);
const entry = new URL("../_accompaniment-badges.tsx", import.meta.url);
await writeFile(html, (await readFile(new URL("./fixtures/ui.html", import.meta.url), "utf8")).replace("/_ui-test.tsx", "/_accompaniment-badges.tsx"));
await writeFile(entry, await readFile(new URL("./fixtures/accompaniment-badges.tsx", import.meta.url), "utf8"));
await mkdir(new URL("../outputs/accompaniment-badges/", import.meta.url), { recursive: true });
const vite = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--host", "127.0.0.1", "--port", "1449", "--strictPort"], { cwd: root, windowsHide: true, stdio: "ignore" });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 880 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  const local = { path: "C:/fixture/instrumental.wav", title: "Fixture Track", artist: "Fixture Artist", album: "Fixture Album", durationMs: 180000, sourceKind: "track", sourceId: "876543", originalSource: "C:/fixture/test.wav", stem: "instrumental" };
  window.__badgeResults = [local, { ...local, path: "cloud:7654", sourceKind: "netease", sourceId: "998877", originalSource: undefined }];
  window.__badgeCalls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__badgeCalls.push(cmd);
      if (cmd === "list_accompaniments") return window.__badgeResults;
      if (cmd === "find_accompaniment") return null;
      if (cmd === "vocal_removal_status") return { installed: true, supportedPlatform: true };
      if (cmd === "get_vocal_removal" || cmd === "get_pitch_shift") return 0;
      if (cmd === "list_output_devices") return { devices: [], current: "", preference: null };
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "extract_accompaniment") return local;
      return null;
    },
    convertFileSrc: (path) => path,
    transformCallback: (callback) => callback,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
});
try {
  const url = "http://127.0.0.1:1449/_accompaniment-badges.html";
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url)).ok; } catch {}
    if (ready) break;
    if (vite.exitCode !== null) throw new Error("Badge fixture server failed");
    await delay(250);
  }
  assert(ready);
  await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  const badges = page.locator("[data-accompaniment-badge]");
  await page.waitForFunction(() => document.querySelectorAll("[data-accompaniment-badge]").length === 4, undefined, { timeout: 120000 });
  assert.equal(await page.locator(".player-dock-caption [data-accompaniment-badge]").count(), 1, "the bottom title must identify a saved accompaniment");
  assert.equal(await page.evaluate(() => window.__badgeCalls.filter((cmd) => cmd === "list_accompaniments").length), 1, "all rows must share one catalog request");
  await page.evaluate(async () => { window.__badgeResults = []; await window.__badgeApi.refreshAccompanimentAvailability(); });
  await page.waitForFunction(() => !document.querySelector("[data-accompaniment-badge]"));
  await page.evaluate(() => window.__badgeApi.rememberAccompaniment({ path: "vocals.wav", sourceKind: "track", sourceId: "876543", stem: "vocals" }));
  assert.equal(await badges.count(), 0, "a vocals-only result must not claim an accompaniment exists");
  await page.evaluate(() => window.__generateBadge());
  await page.waitForFunction(() => document.querySelectorAll("[data-accompaniment-badge]").length === 2);
  assert.equal(await page.locator(".player-dock-caption [data-accompaniment-badge]").count(), 1, "a completed generation must update the footer without restarting");
  await page.evaluate(() => window.__badgeApi.rememberAccompaniment({ path: "wrong-source.wav", sourceKind: "qq", sourceId: "998877" }));
  assert.equal(await badges.count(), 2, "equal numeric IDs from different music services must not share a badge");
  await page.evaluate(() => window.__badgeApi.rememberAccompaniment({ path: "cloud:7654", sourceKind: "netease", sourceId: "998877" }));
  await page.waitForFunction(() => document.querySelectorAll("[data-accompaniment-badge]").length === 4);
  const matching = await page.evaluate(() => {
    const item = { path: "instrumental.wav", sourceKind: "netease", sourceId: "1", title: "Same", artist: "Artist", album: "Album", durationMs: 180000 };
    const source = { kind: "qq", id: "2", title: "Same", artist: "Artist", album: "Album", durationMs: 180000 };
    return [
      window.__badgeApi.hasSavedAccompaniment([item], source),
      window.__badgeApi.hasSavedAccompaniment([item, { ...item, path: "another.wav" }], source),
      window.__badgeApi.hasSavedAccompaniment([item], { ...source, durationMs: 190000 }),
      window.__badgeApi.hasSavedAccompaniment([{ ...item, originalSource: "C:\\Music\\Song.wav" }], { kind: "track", path: "c:/music/song.wav" }),
    ];
  });
  assert.deepEqual(matching, [true, false, false, true], "metadata fallback must reject ambiguous recordings and different durations, while local file matching survives library IDs changing");
  for (const theme of ["standard", "liquid", "skeuo"]) {
    await page.evaluate((value) => window.__renderPlayerBar(false, value), theme);
    for (const [width, height] of [[1000, 660], [1280, 880], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await delay(200);
      const valid = await badges.evaluateAll((elements) => elements.every((element) => {
        const box = element.getBoundingClientRect();
        const parent = element.parentElement.getBoundingClientRect();
        return box.width >= 14 && box.height >= 14 && box.x >= 0 && box.right <= innerWidth
          && box.y >= 0 && box.bottom <= innerHeight && box.right <= parent.right + 1;
      }));
      assert(valid, `badges must remain visible within title bounds: ${theme} ${width}`);
      await page.screenshot({ path: `outputs/accompaniment-badges/${theme}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile("outputs/accompaniment-badges/verification.json", JSON.stringify({ passed: true, sharedCatalogRequest: true, footerAndLists: true, taskCompletionRefresh: true, vocalsExcluded: true, sourceAndRecordingIdentity: true, themes: 3, viewports: 3, nativeAudioCovered: false }, null, 2));
  console.log("PASS: list/footer badges, generated results, recording identity, three themes and three viewports");
} finally {
  await browser.close();
  vite.kill();
  await unlink(html);
  await unlink(entry);
}
