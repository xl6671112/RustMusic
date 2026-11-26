import { createRoot } from "react-dom/client";
import NowPlaying from "../../src/components/NowPlaying";
import { useStore } from "../../src/store";
import { initI18n } from "../../src/i18n";
import { applyTheme, applyUiTheme } from "../../src/theme";
import "../../src/index.css";

initI18n();
const lines = [
  { timeMs: 0, text: "正在播放的第一行", trans: "The current line" },
  { timeMs: 60000, text: "先选择这一行再确认播放", trans: "Select this line before seeking" },
  { timeMs: 120000, text: "很长的歌词也应该完整换行显示并且不会和最右边的播放按钮重叠，翻译和逐字染色的位置保持一致", trans: "Long lyrics wrap without covering the play button" },
];
const fixture = window as any;
fixture.__seeks = [];
fixture.__globalSpace = 0;
window.addEventListener("keydown", event => {
  if (event.code === "Space") fixture.__globalSpace++;
});
useStore.setState({
  current: { kind: "track", id: 1, title: "歌词交互测试", artist: "RustMusic", album: "", cover: "", durationMs: 180000 },
  lyrics: { synced: true, lines }, lyricsLoading: false,
  loadLyricsByKey: async () => {},
  playing: false, dur: 180000, pos: 0, lyricsShowTrans: true, lyricsFontScale: 1,
  seek: (position) => { fixture.__seeks.push(position); useStore.setState({ pos: position }); },
});
fixture.__theme = (ui: "standard" | "liquid" | "skeuo", theme: "dark" | "light", scale = 1) => {
  applyUiTheme(ui);
  applyTheme(theme);
  useStore.setState({ uiTheme: ui, theme, lyricsFontScale: scale });
};
fixture.__changeTrack = () => useStore.setState({ current: { ...useStore.getState().current!, id: (useStore.getState().current!.id ?? 0) + 1 } });
fixture.__replaceLyrics = () => useStore.setState({ lyrics: { synced: true, lines: [...lines] } });
fixture.__play = (playing: boolean) => useStore.setState({ playing });
fixture.__theme("standard", "dark");
createRoot(document.getElementById("root")!).render(<NowPlaying />);
