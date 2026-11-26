import React from "react";
import { createRoot } from "react-dom/client";
import "./src/index.css";
import PlayerBar from "./src/components/PlayerBar";
import TrackList from "./src/components/TrackList";
import { TrackRowItem } from "./src/views/online/TrackRowItem";
import { useStore } from "./src/store";
import { initI18n } from "./src/i18n";
import { applyTheme, applyUiTheme } from "./src/theme";
import { enqueueAccompanimentTask } from "./src/accompanimentTasks";
import * as badgeApi from "./src/accompanimentAvailability";

initI18n();
const track = {
  id: 876543, path: "C:/fixture/test.wav", title: "Fixture Track", artist: "Fixture Artist",
  album: "Fixture Album", albumArtist: "Fixture Artist", trackNo: 1, disc: 1, year: 2026,
  duration: 180, format: "wav", bitrate: 1411, sampleRate: 44100, bitDepth: 16,
  cover: "", hasLrc: false, size: 1000, mtime: 1, liked: false, playCount: 0, lastPlayed: 0, likedAt: 0, missing: false,
};
const online = { kind: "netease" as const, id: 998877, name: "Online Fixture", artist: "Online Artist", album: "Online Album", cover: "", durationMs: 123000, vip: false, mediaMid: "" };
const entry = { rowid: 876544, kind: "netease" as const, trackId: null, onlineId: "998877", title: online.name, artist: online.artist, album: online.album, cover: "", duration: 123, mediaMid: "" };
useStore.setState({ current: { kind: "track", id: track.id, path: track.path, title: track.title, artist: track.artist, album: track.album, cover: "", durationMs: 180000 },
  tracks: [track], queue: [{ kind: "track", id: track.id }], qIndex: 0, playing: true, dur: 180000, pos: 12000, ready: true,
  uiTheme: "standard", theme: "dark", volume: .7, speed: 1, repeat: "off", shuffle: false, queueOpen: false, nowPlayingOpen: false, miniPlayer: false,
});
const root = createRoot(document.getElementById("root")!);
const noop = () => {};
const render = () => root.render(<><div style={{ padding: 24 }}><TrackList tracks={[track]} onlineEntries={[entry]} /><TrackRowItem row={online} index={0} batchMode={false} checked={false} onToggleSel={noop} onPlay={noop} onNext={noop} onLike={noop} onMore={noop} onContextMenu={noop} onOpenDetail={noop} /></div><PlayerBar /></>);
window.__badgeApi = badgeApi;
window.__generateBadge = () => enqueueAccompanimentTask({ source: track.path, title: track.title, artist: track.artist, album: track.album, sourceKind: "track", sourceId: String(track.id) });
window.__renderPlayerBar = (_centered, theme) => { applyUiTheme(theme); applyTheme("dark"); useStore.setState({ uiTheme: theme }); render(); };
applyUiTheme("standard");
applyTheme("dark");
render();
