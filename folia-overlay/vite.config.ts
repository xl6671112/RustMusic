import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const folia = path.join(project, "_third_party", "folia-web", "src");
const runtimePackages = [
  "@applemusic-like-lyrics/ttml",
  "@chenglou/pretext",
  "dexie",
  "@xmldom/xmldom",
  "@paper-design/shaders",
  "@paper-design/shaders-react",
  "@react-three/drei",
  "@react-three/fiber",
  "@react-three/postprocessing",
  "blueimp-md5",
  "animejs",
  "budoux",
  "framer-motion",
  "fflate",
  "i18next",
  "lucide-react",
  "opencc-js",
  "react-window",
  "react-i18next",
  "react-colorful",
  "three",
  "twgl.js",
  "wanakana",
];

export default defineConfig({
  root: here,
  plugins: [
    {
      name: "folia-overlay-i18n",
      enforce: "pre",
      resolveId(source, importer) {
        if (source.endsWith("/i18n/config") && importer?.includes("_third_party/folia-web/src/")) {
          return path.join(here, "src/i18n.ts");
        }
        if (
          source.endsWith("VisualizerBackdrop")
          && (importer?.includes("_third_party/folia-web/src/") || importer?.includes("folia-overlay/src/main.tsx"))
        ) {
          return path.join(here, "src/visualizerBackdrop.tsx");
        }
        if (source.endsWith("usePlayerChrome") && importer?.includes("_third_party/folia-web/src/")) {
          return path.join(here, "src/usePlayerChrome.tsx");
        }
        if (source.endsWith("/mods/folium/registries/stageLayers") && importer?.includes("_third_party/folia-web/src/")) {
          return path.join(here, "src/stageLayers.tsx");
        }
        if (source.endsWith("/utils/localMetadataWorkerClient") && importer?.includes("_third_party/folia-web/src/")) {
          return path.join(here, "src/localMetadataWorkerClient.ts");
        }
        if (source.endsWith("lyricRenderQualityPin") || source.endsWith("useLyricRenderQuality")) {
          return path.join(here, "src/renderQuality.tsx");
        }
        if (source === "@neteasecloudmusicapienhanced/api/package.json") {
          return path.join(here, "src/netease-api-package.json");
        }
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${folia}/$1` },
      { find: /^react$/, replacement: path.join(here, "node_modules/react") },
      { find: /^react-dom$/, replacement: path.join(here, "node_modules/react-dom") },
      { find: /^react\/jsx-runtime$/, replacement: path.join(here, "node_modules/react/jsx-runtime.js") },
      { find: /^react-dom\/client$/, replacement: path.join(here, "node_modules/react-dom/client.js") },
      {
        find: /^@chenglou\/pretext\/rich-inline$/,
        replacement: path.join(here, "node_modules/@chenglou/pretext/dist/rich-inline.js"),
      },
      {
        find: /^pixi\.js\/advanced-blend-modes$/,
        replacement: path.join(here, "node_modules/pixi.js/lib/advanced-blend-modes/init.mjs"),
      },
      {
        find: /^pixi\.js$/,
        replacement: path.join(here, "node_modules/pixi.js/lib/index.mjs"),
      },
      ...runtimePackages.map((name) => ({
        find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`),
        replacement: path.join(here, "node_modules", name),
      })),
    ],
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 10_000_000,
    rollupOptions: {
      input: path.join(here, "index.html"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "folia.js",
        assetFileNames: "folia.[ext]",
      },
    },
  },
});
