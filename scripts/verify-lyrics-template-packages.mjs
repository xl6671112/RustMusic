import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fontBytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const fontId = `${hash(fontBytes)}.woff2`;
const imageId = `${hash(imageBytes)}.png`;
const sourceAssets = new Map([[fontId, fontBytes], [imageId, imageBytes]]);
let profileAssets = new Map();
let validationCalls = 0, importedAssets = 0, settingsWrites = 0, templateWrites = 0;
let validationFailure = false;
let remoteBlob;
let remoteCalls = 0;

globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
  if (command === "validate_obs_lyrics_template") {
    validationCalls++;
    assert.equal(typeof args.settings.preset, "string", "each portable settings object passes the native validation boundary");
    if (validationFailure) throw new Error("native settings rejected");
    return;
  }
  if (command === "import_obs_lyrics_font" || command === "import_folia_image") {
    importedAssets++;
    const bytes = Buffer.from(args.data, "base64");
    const extension = command === "import_obs_lyrics_font" ? args.name.split(".").pop() : "png";
    const id = `${hash(bytes)}.${extension}`;
    profileAssets.set(id, bytes);
    return command === "import_obs_lyrics_font" ? { fontFile: id } : id;
  }
  if (command === "set_obs_lyrics_settings") { settingsWrites++; return; }
  if (command === "set_obs_lyrics_templates") { templateWrites++; return; }
  throw new Error(`Unexpected native command: ${command}`);
} } };
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.origin === "http://127.0.0.1:17842") {
    const id = parsed.pathname.split("/").pop();
    const bytes = sourceAssets.get(id);
    return new Response(bytes ?? "missing", { status: bytes ? 200 : 404 });
  }
  assert.equal(parsed.origin, "https://music.xn--hlr32k.com");
  remoteCalls++;
  return new Response(remoteBlob);
};

try {
  const { initial } = await server.ssrLoadModule("/src/obsLyricsPresets.ts");
  const { templateSnapshot, exportLyricsTemplate, importLyricsTemplate, templateLinkId, importLyricsTemplateLink } =
    await server.ssrLoadModule("/src/obsLyricsTemplates.ts");
  const make = (name, settings) => ({ id: crypto.randomUUID(), name, settings: { ...structuredClone(initial), ...settings } });
  const classic = make("自定义 HTML", {
    preset: "custom-html", customHtmlEnabled: true, htmlTuningEnabled: false,
    customHtml: '<p data-rustmusic-slot="current">shared lyric</p>', customHtmlValues: { color: "#34aabb", speed: 3 },
    size: 56, rawGlow: "#44aaff", fontFile: fontId, fontName: "Shared Font",
    styleSettings: { classic: { size: 12, fontFile: "" } },
    jizura: { transparent: false, sourceTrackKey: "private-track" },
  });
  const classicBefore = structuredClone(classic.settings);
  const snapshot = templateSnapshot(classic.settings);
  assert.equal(snapshot.size, 56, "saving a named template preserves the visible values over stale per-style values");
  assert.equal(snapshot.preset, "classic", "custom HTML uses a native-valid base renderer while retaining HTML activation");
  assert.equal(snapshot.customHtmlEnabled, true);
  assert.equal(snapshot.htmlTuningEnabled, false, "the original-animation switch survives saving a template");
  assert.equal(snapshot.jizura, undefined, "an ordinary template does not include inactive song-specific JIZURA settings");
  snapshot.customHtmlValues.speed = 8;
  assert.deepEqual(classic.settings, classicBefore, "saved snapshots are independent and cannot mutate the current editor");

  const folia = make("Folia 光晕和动画", {
    preset: "folia-hanabi",
    foliaAppearance: { fontFile: fontId, subtitleFontFile: fontId, glowColors: { hanabi: "#55ccdd" }, lyricsFontScale: 1.2 },
    foliaTunings: { hanabi: { intensity: 0.7, speed: 1.2, colors: ["#22aaff", "#ff6655"] } },
    foliaTuningEnabled: { hanabi: false },
    foliaAssets: { avatar: [{ id: "avatar-a", file: imageId, name: "Shared avatar" }] },
  });
  const jizura = make("JIZURA 自选组合", {
    preset: "jizura",
    jizura: {
      transparent: true, sourceTrackKey: "local:/private/song.flac", lineEffectsTrackKey: "local:42",
      analysis: { duration: 123, bpm: 120, beats: [0, 1], energy: [0.2, 0.8], energyRate: 2, sourceTrackKey: "local:42" },
      fontFiles: { custom: fontId },
      project: {
        style: "sakura", seed: 123,
        fx: { motion: 0.8, glitch: 0.1, chroma: 0.6, decor: 0.7 },
        enabled: { layout: { center: false, wave: true }, enter: { pop: true, blur: false } },
        colors: { text: "#ffaacc", background: "#123456" }, fonts: { display: "custom" },
        userFonts: [{ key: "custom", label: "Shared Font", family: "Shared Font", weight: 700 }],
        overrides: { 3: { layout: "wave", cuts: 2 } },
        lyrics: "private lyrics", audioUrl: "C:/private/song.flac", audioData: "private bytes", title: "Private song",
      },
    },
  });

  let foliaPackage;
  for (const template of [classic, folia, jizura]) {
    const original = structuredClone(template.settings);
    const before = validationCalls;
    const blob = await exportLyricsTemplate(template);
    assert.ok(validationCalls > before, "export validates settings before creating a shareable package");
    const parsed = JSON.parse(await blob.text());
    const required = template === folia ? [fontId, imageId] : [fontId];
    assert.deepEqual(Object.keys(parsed.files).sort(), required.sort(), "a portable package contains every referenced asset exactly once");
    profileAssets = new Map();
    const imported = await importLyricsTemplate(blob);
    assert.notEqual(imported.id, template.id, "the recipient gets a new local template identity");
    assert.equal(imported.name, template.name);
    for (const id of required) assert.deepEqual(profileAssets.get(id), sourceAssets.get(id), "an empty second profile receives identical font/image bytes");
    assert.deepEqual(template.settings, original, "sharing must not change the original local template");
    if (template === classic) {
      assert.equal(imported.settings.customHtml, classic.settings.customHtml);
      assert.deepEqual(imported.settings.customHtmlValues, classic.settings.customHtmlValues);
      assert.equal(imported.settings.htmlTuningEnabled, false);
      assert.equal(imported.settings.size, 56);
    } else if (template === folia) {
      foliaPackage = parsed;
      for (const key of ["foliaAppearance", "foliaTunings", "foliaTuningEnabled", "foliaAssets"]) {
        assert.deepEqual(imported.settings[key], folia.settings[key], `${key} must survive sharing Folia colors, effects and animation switches`);
      }
    } else {
      for (const key of ["fx", "enabled", "colors", "fonts", "userFonts"]) {
        assert.deepEqual(imported.settings.jizura.project[key], jizura.settings.jizura.project[key], `JIZURA global ${key} must survive sharing`);
      }
      const sharedText = await blob.text();
      for (const privateValue of ["local:/private/song.flac", "local:42", "private lyrics", "private bytes", "Private song", "C:/private/song.flac"]) {
        assert.ok(!sharedText.includes(privateValue), "shared visual templates cannot leak local song identity or audio analysis");
      }
      assert.deepEqual(imported.settings.jizura.project.overrides, {}, "song-bound line overrides are excluded from a general visual template");
    }
  }

  const failuresBefore = importedAssets;
  const missing = structuredClone(foliaPackage);
  delete missing.files[imageId];
  await assert.rejects(importLyricsTemplate(new Blob([JSON.stringify(missing)])), /素材缺失/, "missing assets fail before installing any files");
  const damaged = structuredClone(foliaPackage);
  damaged.files[imageId] = Buffer.from("damaged image").toString("base64");
  await assert.rejects(importLyricsTemplate(new Blob([JSON.stringify(damaged)])), /校验失败/, "changed asset bytes cannot masquerade as the original image");
  assert.equal(importedAssets, failuresBefore, "all package hashes are checked before any asset installation begins");
  validationFailure = true;
  await assert.rejects(importLyricsTemplate(new Blob([JSON.stringify(foliaPackage)])), /native settings rejected/);
  validationFailure = false;
  assert.equal(importedAssets, failuresBefore, "native-rejected settings cannot install package assets");
  const foreignSettings = structuredClone(foliaPackage);
  foreignSettings.settings.accountToken = "foreign-account-token";
  const clean = await importLyricsTemplate(new Blob([JSON.stringify(foreignSettings)]));
  assert.equal(clean.settings.accountToken, undefined, "imports cannot smuggle account settings into OBS configuration");

  const id = "a".repeat(64);
  const link = `https://music.xn--hlr32k.com/lyrics-template/${id}`;
  assert.equal(templateLinkId(` ${link} `), id);
  assert.equal(templateLinkId(`https://music.xn--hlr32k.com/api/lyrics-templates/${id}`), id);
  for (const bad of ["", "not-a-url", link.replace("https:", "http:"), link.replace("music.xn--hlr32k.com", "evil.example"), `${link}?url=evil`, `${link}#evil`, link.replace(id, "../private"), link.replace(id, id.toUpperCase())]) {
    assert.throws(() => templateLinkId(bad), "only exact RustMusic share URLs can trigger template downloads");
    await assert.rejects(importLyricsTemplateLink(bad));
  }
  assert.equal(remoteCalls, 0, "invalid links never make network requests");
  remoteBlob = new Blob([JSON.stringify(foliaPackage)]);
  profileAssets = new Map();
  const linked = await importLyricsTemplateLink(link);
  assert.equal(linked.settings.preset, "folia-hanabi");
  assert.equal(remoteCalls, 1);
  assert.equal(profileAssets.size, 2, "a shared link imports all required assets into a clean recipient profile");
  assert.equal(settingsWrites, 0, "template preview/import never silently changes active OBS settings");
  assert.equal(templateWrites, 0, "package validation never writes the local template collection by itself");
  console.log("PASS: independent snapshots, HTML, Folia colors/animation/font/images, JIZURA global combinations/fonts, private song exclusion, clean-profile imports, corrupt/missing assets, native rejection and exact-origin links.");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  await server.close();
}
