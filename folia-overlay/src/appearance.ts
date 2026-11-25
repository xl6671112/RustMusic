import type { LyricRenderQuality, SubtitleContentMode, SubtitleOverlayLayout, Theme } from "../../_third_party/folia-web/src/types";

export const defaultTheme: Theme = {
  name: "RustMusic",
  backgroundColor: "transparent",
  primaryColor: "#ffffff",
  accentColor: "#8df7ff",
  secondaryColor: "#c8d0dc",
  fontStyle: "sans",
  animationIntensity: "normal",
};

export type Appearance = Partial<Pick<Theme,
  "primaryColor" | "accentColor" | "secondaryColor" | "fontStyle" | "fontFamily" | "fontWeight"
>> & {
  lyricsFontScale?: number;
  visualizerOpacity?: number;
  showOriginalBackground?: boolean;
  subtitleFontScale?: number;
  subtitleFontInheritsLyrics?: boolean;
  subtitleFontStyle?: Theme["fontStyle"];
  subtitleFontFamily?: string;
  subtitleFontWeight?: number;
  subtitleContentMode?: SubtitleContentMode;
  subtitleOverlayLayout?: SubtitleOverlayLayout;
  subtitleOverlayOpacity?: number;
  subtitleOverlayBackground?: boolean;
  subtitleUpcomingLyricsBlur?: boolean;
  hideTranslationSubtitle?: boolean;
  showHarmonySubtitle?: boolean;
  harmonySubtitleBackground?: boolean;
  fontFile?: string;
  subtitleFontFile?: string;
  renderQuality?: LyricRenderQuality;
};

export type AssetSlot = "monet" | "emoji" | "avatar" | "tempera";
export type Asset = { id: string; name: string; file: string };
export const imageUrls = (assets?: Asset[]) => assets?.map(({id, name, file}) => ({ id, name, url: `/folia-images/${file}` }));

export type FoliaSettings = {
  preset?: string;
  lyricTimeline?: "original" | "split";
  foliaTunings?: Record<string, Record<string, unknown>>;
  foliaTuningEnabled?: Record<string, boolean>;
  foliaAppearance?: Appearance;
  foliaAssets?: Partial<Record<AssetSlot, Asset[]>>;
};

export function resolveTheme(mode: string, appearance: Appearance): Theme {
  const { primaryColor, accentColor, secondaryColor, fontStyle, fontFamily, fontWeight } = appearance;
  return {
    ...defaultTheme,
    backgroundColor: mode === "cappella" ? "#14232d" : appearance.showOriginalBackground ? "#09090b" : "transparent",
    primaryColor: primaryColor ?? defaultTheme.primaryColor,
    accentColor: accentColor ?? defaultTheme.accentColor,
    secondaryColor: secondaryColor ?? defaultTheme.secondaryColor,
    fontStyle: fontStyle ?? defaultTheme.fontStyle,
    fontFamily: appearance.fontFile ? "RustMusicFoliaLyrics" : fontFamily,
    fontWeight,
  };
}
