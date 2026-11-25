import { createContext } from "react";
import type { MotionValue } from "framer-motion";
import type { AudioBands, Theme } from "../../_third_party/folia-web/src/types";
import type { VisualizerSharedProps } from "../../_third_party/folia-web/src/components/visualizer/definition";

export interface VisualizerBackdropFrame {
  pointerArea: HTMLElement | null;
}

export const VisualizerBackdropContext = createContext<VisualizerBackdropFrame | null>(null);

export const VisualizerBackdropLayers = (_props: {
  theme: Theme;
  audioPower: MotionValue<number>;
  audioBands: AudioBands;
  sharedProps?: Partial<VisualizerSharedProps>;
  renderBackground: boolean;
}) => null;
