import { createRoot } from "react-dom/client";
import "../../src/index.css";
import ObsLyricsSettings from "../../src/components/ObsLyricsSettings";

declare global {
  interface Window {
    __lyricsSettings: Record<string, unknown>;
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (...args: unknown[]) => unknown) => number;
      convertFileSrc: (path: string) => string;
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
  }
}

window.__lyricsSettings = { preset: "folia-partita" };
window.__TAURI_INTERNALS__ = {
  transformCallback: (callback) => {
    (window as unknown as Record<string, unknown>).__callback = callback;
    return 1;
  },
  convertFileSrc: (path) => path,
  invoke: async (command, args) => {
    if (command === "get_obs_lyrics_settings") return JSON.stringify(window.__lyricsSettings);
    if (command === "fetch_lyrics_styles") return { version: "1.0.0", styles: [] };
    if (command === "import_folia_image" && String(args?.data).startsWith("iVBORw0KGgo")) return `${"a".repeat(64)}.png`;
    if (command === "set_obs_lyrics_settings") {
      window.__lyricsSettings = JSON.parse(String(args?.settings));
      return null;
    }
    return null;
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

createRoot(document.getElementById("root")!).render(<ObsLyricsSettings />);
