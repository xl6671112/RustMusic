import { build } from "esbuild";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modes = "cadenza cappella claddagh classic diorama fume hanabi lumiere machi metaphor monet nebbia partita pendolo prompt sonnet still tempera tilt".split(" ");
const tunableModes = [];
for (const mode of modes) {
  try { await access(path.join(root, `_third_party/folia-web/src/components/visualizer/${mode}/tuning.ts`)); tunableModes.push(mode); }
  catch { /* Some original modes intentionally have no custom animation parameters. */ }
}
const imports = tunableModes.map((mode, index) => `import mode${index} from "./_third_party/folia-web/src/components/visualizer/${mode}/tuning.ts";`).join("\n");
const result = await build({
  absWorkingDir: root,
  stdin: { contents: `${imports}\nimport {initial} from "./src/obsLyricsPresets.ts";\nexport default {initial,tunings:[${tunableModes.map((_, index) => `mode${index}`).join(",")}]};`, resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "catalog-without-ui",
    setup(api) {
      api.onResolve({ filter: /\/i18n\/config$/ }, () => ({ path: "i18n", namespace: "catalog" }));
      api.onLoad({ filter: /.*/, namespace: "catalog" }, () => ({ contents: "export default {t: value => value};" }));
      api.onResolve({ filter: /\/stores\/useVisualizerAssetStore$/ }, () => ({ path: "assets", namespace: "catalog-stores" }));
      api.onResolve({ filter: /\/stores\/useStatusMessageStore$/ }, () => ({ path: "status", namespace: "catalog-stores" }));
      api.onResolve({ filter: /(?:^|\/)appDatabase$/ }, () => ({ path: "db", namespace: "catalog-stores" }));
      api.onLoad({ filter: /.*/, namespace: "catalog-stores" }, () => ({ contents: "export const useVisualizerAssetStore = {getState: () => ({})}; export const setStatusMessage = () => {}; export const appDatabase = {}; export const LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY = ''; export const LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY = '';" }));
    },
  }],
});
const { default: { initial, tunings } } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const catalog = Object.fromEntries(tunings.map(item => [item.mode, { defaults: item.defaults, fields: item.modKeys ?? {} }]));
for (const mode of modes) catalog[mode] ??= { defaults: {}, fields: {} };
await writeFile(path.join(root, "docs/obs-lyrics-api-folia.json"), JSON.stringify(catalog, null, 2) + "\n");
await writeFile(path.join(root, "docs/obs-lyrics-api-defaults.json"), JSON.stringify(initial, null, 2) + "\n");
console.log(`Generated ${Object.keys(catalog).length} Folia modes from the original tuning definitions.`);
