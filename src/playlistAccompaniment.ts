import { enqueueAccompanimentTask, hasPendingAccompaniment } from "./accompanimentTasks";
import type { Playlist, TrackMeta } from "./types";

type BatchInput = Parameters<typeof enqueueAccompanimentTask>[0];
type Candidate = { key: string; kind: string; id: string; path: string; input: BatchInput };
const supportedKinds = new Set(["netease", "qq", "kugou", "bilibili", "navidrome"]);

/** Preserve playlist order; repeat songs across playlists only need one extraction. */
export function collectPlaylistAccompaniments(playlists: Playlist[], tracks: TrackMeta[]) {
  const local = new Map(tracks.map((track) => [track.id, track]));
  const unique = new Map<string, Candidate>();
  let duplicates = 0;
  let unavailable = 0;
  const addLocal = (id: number | null) => {
    const track = id == null ? undefined : local.get(id);
    if (!track || track.missing || !track.path) { unavailable++; return; }
    add({
      key: `local:${track.path.replace(/\\/g, "/").toLowerCase()}`,
      kind: "track", id: String(track.id), path: track.path,
      input: { source: track.path, title: track.title, artist: track.artist, album: track.album,
        sourceKind: "track", sourceId: String(track.id), force: false },
    });
  };
  const add = (candidate: Candidate) => {
    if (unique.has(candidate.key)) duplicates++;
    else unique.set(candidate.key, candidate);
  };
  for (const playlist of playlists) {
    const entryIDs = new Set<number>();
    for (const entry of playlist.entries ?? []) {
      if (entry.kind === "local") {
        if (entry.trackId != null) entryIDs.add(entry.trackId);
        addLocal(entry.trackId);
      } else if (supportedKinds.has(entry.kind) && entry.onlineId) {
        add({
          key: `${entry.kind}:${entry.onlineId}`, kind: entry.kind, id: entry.onlineId, path: "",
          input: {
            title: entry.title, artist: entry.artist, album: entry.album, force: false,
            online: { kind: entry.kind, id: entry.onlineId, title: entry.title, artist: entry.artist,
              album: entry.album, cover: entry.cover, durationMs: Math.round(entry.duration * 1000),
              mediaMid: entry.mediaMid ?? "" },
          },
        });
      } else unavailable++;
    }
    // Older playlists may still only have trackIds.
    for (const id of playlist.trackIds) if (!entryIDs.has(id)) addLocal(id);
  }
  return { candidates: [...unique.values()], duplicates, unavailable };
}

export function enqueuePlaylistAccompaniments(playlists: Playlist[], tracks: TrackMeta[], modelId?: string) {
  const { candidates, duplicates, unavailable } = collectPlaylistAccompaniments(playlists, tracks);
  let queued = 0;
  let pending = 0;
  for (const candidate of candidates) {
    if (hasPendingAccompaniment(candidate.kind, candidate.id, candidate.path, modelId)) pending++;
    else { enqueueAccompanimentTask({ ...candidate.input, modelId }); queued++; }
  }
  return { queued, pending, duplicates, unavailable };
}
