import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";

export interface ReferenceAccountImport {
  uid: number;
  favorites: number;
  playlists: number;
  addedTracks: number;
  warnings: string[];
}

export async function importReferenceAccount(profile: string): Promise<ReferenceAccountImport> {
  const result = await invoke<ReferenceAccountImport>("import_reference_account", { profile });
  const store = useStore.getState();
  await Promise.all([
    store.neteaseRefreshStatus(),
    store.refreshLikedOnline(),
    store.refreshPlaylists(),
  ]);
  await useStore.getState().neteaseSyncLikes();
  return result;
}
