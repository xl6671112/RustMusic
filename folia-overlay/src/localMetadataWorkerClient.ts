export interface EmbeddedMetadataResult {
  title?: string;
  artist?: string;
  artists?: string[];
  album?: string;
  trackNumber?: number;
  discNumber?: number;
  cover?: Blob;
  coverAssetId?: string;
  bitrate?: number;
  lyrics?: string;
  translationLyrics?: string;
  replayGain?: number;
  replayGainTrackGain?: number;
  replayGainTrackPeak?: number;
  replayGainAlbumGain?: number;
  replayGainAlbumPeak?: number;
  duration?: number;
}

export interface HashedLocalCoverResult {
  cover: Blob;
  coverAssetId: string;
}

export const initMetadataWorker = (): Worker => {
  throw new Error("Local media metadata import is not available in the lyrics renderer");
};

export const parseEmbeddedMetadataAsync = async (): Promise<EmbeddedMetadataResult | null> => null;
export const hashLocalCoverBlobAsync = async (): Promise<HashedLocalCoverResult | null> => null;
