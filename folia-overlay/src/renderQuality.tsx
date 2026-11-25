import { createContext, useContext } from "react";
import type { LyricRenderOverride, LyricRenderQuality } from "../../_third_party/folia-web/src/types";
import { resolveLyricRenderQuality } from "../../_third_party/folia-web/src/utils/lyricRenderQuality";

export const LyricRenderQualityGlobalContext = createContext<LyricRenderQuality>({
  scale: 1,
  antialias: "auto",
});

export const LyricRenderQualityPinContext = createContext<LyricRenderQuality | null>(null);

export const useLyricRenderQualityPin = () => useContext(LyricRenderQualityPinContext);
export const useGlobalLyricRenderQuality = () => (
  useLyricRenderQualityPin() ?? useContext(LyricRenderQualityGlobalContext)
);
export const useLyricRenderQuality = (override?: LyricRenderOverride | null) => {
  const pinned = useLyricRenderQualityPin();
  const global = useGlobalLyricRenderQuality();
  return resolveLyricRenderQuality(
    global,
    !pinned && override?.scale && override.antialias
      ? { scale: override.scale, antialias: override.antialias }
      : null,
  );
};
