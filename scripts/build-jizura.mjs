import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = path.join(root, "jizura-overlay");
const upstream = path.join(overlay, "upstream");
const output = path.join(overlay, "dist");
await mkdir(output, { recursive: true });
const version = (await readFile(path.join(upstream, "VERSION"), "utf8")).trim();
const files = (await readdir(path.join(upstream, "src"))).filter(file => file.endsWith(".js")).sort();
const engineFiles = files.filter(file => file !== "12_ui.js");
const chunks = await Promise.all(engineFiles.map(file => readFile(path.join(upstream, "src", file), "utf8")));
let engine = chunks.join("\n").replaceAll("\r\n", "\n").replaceAll("@VERSION@", version);
const integrationPatches = [
  {
    id: "literal-native-lines",
    from: "const parsed = J.parseLyrics(project.lyrics);\n  const title",
    to: "const parsed = project.nativeLines ? { lines: project.nativeLines, meta: {} } : J.parseLyrics(project.lyrics);\n  const title",
  },
  {
    id: "native-timeline",
    from: "const tm = J.computeTiming(project, parsed, audio);",
    to: "const tm = project.nativeTiming || J.computeTiming(project, parsed, audio);",
  },
  {
    id: "native-timeline-no-typeset-lead",
    from: "if (project.typeset) {",
    to: "if (project.typeset && !project.nativeTiming) {",
  },
  {
    id: "native-cut-bounds",
    from: "for (let k = 1; k < bounds.length - 1; k++) bounds[k] = J.clamp(snap(bounds[k]), bounds[k - 1] + 0.22, bounds[k + 1] - 0.22);",
    to: "if (!project.nativeTiming) for (let k = 1; k < bounds.length - 1; k++) bounds[k] = J.clamp(snap(bounds[k]), bounds[k - 1] + 0.22, bounds[k + 1] - 0.22);",
  },
  {
    id: "native-no-manual-cut-times",
    from: "if (ov.cutTime && typeof ov.cutTime === 'object') {",
    to: "if (!project.nativeTiming && ov.cutTime && typeof ov.cutTime === 'object') {",
  },
];
for (const patch of integrationPatches) {
  if (engine.split(patch.from).length !== 2) throw new Error(`JIZURA integration hook changed: ${patch.id}`);
  engine = engine.replace(patch.from, patch.to);
}
await writeFile(path.join(output, "engine.js"), engine);
const timeline = await readFile(path.join(overlay, "timeline.js"), "utf8");
await writeFile(path.join(output, "native-engine.mjs"), `const nativeJ = (() => {\nconst window = {};\n${engine}\n${timeline}\nreturn J;\n})();\nexport default nativeJ;\n`);
await copyFile(path.join(overlay, "native-engine.d.mts"), path.join(output, "native-engine.d.mts"));
for (const file of ["timeline.js", "runtime.js", "runtime.css", "lyrics.html"]) {
  await copyFile(path.join(overlay, file), path.join(output, file));
}
for (const file of ["editor.html", "editor-bridge.js"]) await rm(path.join(output, file), { force: true });

// Read the original localized engine's registries without starting its editor.
const editor = (await readFile(path.join(upstream, "editor.zh-Hans.html"), "utf8")).replaceAll("\r\n", "\n");
const localized = [...editor.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes("JIZURA — editor UI"));
const uiMarker = "/* ============================================================\n   JIZURA — editor UI";
if (!localized || localized.split(uiMarker).length !== 2) throw new Error("JIZURA localized metadata boundary changed.");
const sandbox = {
  window: {},
  document: { createElement: () => ({ getContext: () => ({}) }) },
  console,
  Intl,
};
vm.runInNewContext(localized.split(uiMarker)[0], sandbox, { timeout: 10000 });
const J = sandbox.window.J;
const entry = (id, value) => ({ id, ...value, label: value.label || value.name || id });
const groupLabels = { layout: "布局", enter: "入场", hold: "停留", exit: "退场", decor: "装饰", treat: "文字处理", bg: "背景图形", cam: "镜头", fx: "屏幕特效", trans: "转场" };
const setLabels = { horror: "恐怖", typo: "文字排版", kinetic: "动态文字", extra2: "新增特效 2" };
const catalog = {
  version,
  defaults: J.defaultProject(),
  styles: J.STYLE_ORDER.map(id => entry(id, { ...J.STYLES[id], palette: J.STYLES[id].schemes })),
  groups: J.GROUP_KEYS.map(id => ({ id, label: groupLabels[id], items: J.order(id).map(key => entry(key, J.registry(id)[key])) })),
  fonts: Object.entries(J.FONTS).map(([id, font]) => entry(id, font)),
  moods: Object.entries(J.MOODS).map(([id, mood]) => entry(id, mood)),
  sets: J.SET_ORDER.map(id => ({ id, label: setLabels[id], ...J.SETS[id] })),
  themes: Object.entries(J.THEMES || {}).map(([id, theme]) => entry(id, theme)),
};
await writeFile(path.join(output, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
const manifest = {
  upstream: "https://github.com/852wa/JIZURA",
  commit: "4c8278cef161b38b132055e7b5efa112a5d41790",
  version,
  integrationPatches,
  engineSources: await Promise.all(engineFiles.map(async file => ({
    file,
    sha256: createHash("sha256").update(await readFile(path.join(upstream, "src", file))).digest("hex"),
  }))),
};
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`JIZURA ${version}: ${engineFiles.length} engine sources, ${catalog.styles.length} styles, native settings catalog, isolated runtime.`);
