import React, { useEffect, useRef, useState } from "react";
import type { LyricAntialias, SubtitleContentMode, Theme } from "../../_third_party/folia-web/src/types";
import { Button, Group, Row, Select, Tabs } from "../../_third_party/folia-web/src/components/modal/settings/kit";
import { settingsTokens, SettingsKitThemeContext } from "../../_third_party/folia-web/src/components/modal/settings/kit/kitTheme";
import { percent, SliderRow, ToggleRow } from "../../_third_party/folia-web/src/components/visualizer/panelRows";
import { getVisualizerRegistryEntry } from "../../_third_party/folia-web/src/components/visualizer/registry";
import { getVisualizerTuning } from "../../_third_party/folia-web/src/components/visualizer/tuningRegistry";
import { useVisualizerAssetStore } from "../../_third_party/folia-web/src/stores/useVisualizerAssetStore";
import { useVisualizerSettingsStore } from "../../_third_party/folia-web/src/stores/useVisualizerSettingsStore";
import { getTemperaLayerImage } from "../../_third_party/folia-web/src/services/temperaLayerImages";
import SubtitleOverlayRowsSetting from "../../_third_party/folia-web/src/components/visualizer/window/SubtitleOverlayRowsSetting";
import { parseSubtitleOverlayLayout } from "../../_third_party/folia-web/src/utils/lyrics/subtitleOverlayLayout";
import { LYRIC_RENDER_SCALES, normalizeLyricRenderQuality } from "../../_third_party/folia-web/src/utils/lyricRenderQuality";
import { imageUrls, resolveTheme, type Appearance, type AssetSlot, type FoliaSettings } from "./appearance";
import i18n from "./i18n";

const tabs = [
  { id: "effects", label: "歌词动画" },
  { id: "colors", label: "配色" },
  { id: "fonts", label: "字体" },
  { id: "subtitles", label: "字幕" },
  { id: "global", label: "全局" },
];
const colorFields = [["primaryColor", "主文本"], ["accentColor", "强调色"], ["secondaryColor", "辅助色"]] as const;
const fontOptions = [
  { value: "sans", label: "无衬线" }, { value: "serif", label: "衬线" }, { value: "mono", label: "等宽" },
] as const;
const subtitleOptions = [
  { value: "translation", label: "翻译" }, { value: "romanization", label: "音译" },
  { value: "both", label: "音译＋翻译" }, { value: "none", label: "不显示" },
] as const;
type SettingsPatch = Partial<Pick<FoliaSettings, "foliaAppearance" | "foliaTunings" | "foliaAssets">>;

export default function Settings() {
  const [settings, setSettings] = useState<FoliaSettings>();
  const [tab, setTab] = useState("effects");
  const [altMode, setAltMode] = useState<"translation" | "romanization">("translation");
  const [daylight, setDaylight] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const hostOrigin = useRef("");
  const pendingAssets = useRef(new Map<string, (data: { file?: string; error?: string }) => void>());
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== parent) return;
      if (event.data?.type === "folia-asset-result" && event.origin === hostOrigin.current) {
        pendingAssets.current.get(event.data.id)?.(event.data);
        pendingAssets.current.delete(event.data.id);
        return;
      }
      if (event.data?.type !== "folia-settings-init") return;
      hostOrigin.current = event.origin;
      setSettings(event.data.settings);
      setAltMode(event.data.altMode);
      setDaylight(event.data.daylight === true);
    };
    window.addEventListener("message", receive);
    if (parent !== window) parent.postMessage({ type: "folia-settings-ready" }, "*");
    const observer = new ResizeObserver(([entry]) => {
      if (hostOrigin.current) parent.postMessage({ type: "folia-settings-height", height: Math.ceil(entry.contentRect.height) + 16 }, hostOrigin.current);
    });
    if (container.current) observer.observe(container.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", receive);
    };
  }, []);
  const patch = (values: SettingsPatch) => {
    setSettings(previous => ({ ...previous, ...values }));
    if (hostOrigin.current) parent.postMessage({ type: "folia-settings-change", values }, hostOrigin.current);
  };
  const importAsset = (blob: Blob, name: string, kind: "image" | "font") => new Promise<string>((resolve, reject) => {
    const id = crypto.randomUUID();
    pendingAssets.current.set(id, data => data.file ? resolve(data.file) : reject(new Error(data.error ?? "导入失败")));
    parent.postMessage({ type: "folia-asset-import", id, blob, name, kind }, hostOrigin.current);
  });
  const appearance = settings?.foliaAppearance ?? {};
  const assets = settings?.foliaAssets;
  const quality = normalizeLyricRenderQuality(appearance.renderQuality);
  useEffect(() => {
    useVisualizerSettingsStore.setState({ lyricRenderQuality: normalizeLyricRenderQuality(appearance.renderQuality) });
  }, [appearance.renderQuality]);
  useEffect(() => {
    useVisualizerAssetStore.setState({
      monetPortraitImage: imageUrls(assets?.monet)?.[0] ?? null,
      cappellaCustomEmojiImages: imageUrls(assets?.emoji) ?? [],
      cappellaCustomAvatarImages: imageUrls(assets?.avatar) ?? [],
      isLoadingMonetPortraitImage: false,
      isLoadingCappellaEmojiPack: false,
      isLoadingCappellaAvatarPack: false,
    });
  }, [assets]);
  const mode = settings?.preset?.replace(/^folia-/, "") ?? "classic";
  const theme = resolveTheme(mode, appearance);
  const t = (key: string) => i18n.t(key) as string;
  const update = <K extends keyof Appearance>(key: K, value: Appearance[K]) => {
    patch({ foliaAppearance: { ...appearance, [key]: value } });
  };
  const ranges = (key: "lyricsFontScale" | "visualizerOpacity" | "subtitleFontScale" | "subtitleOverlayOpacity", label: string, min: number, max: number, fallback = 1) =>
    <SliderRow label={label} value={appearance[key] ?? fallback} min={min} max={max} step={0.05} format={percent} onChange={value => update(key, value)} />;
  const font = (subtitle: boolean) => {
    const style = subtitle ? "subtitleFontStyle" : "fontStyle";
    const family = subtitle ? "subtitleFontFamily" : "fontFamily";
    const weight = subtitle ? "subtitleFontWeight" : "fontWeight";
    const file = subtitle ? "subtitleFontFile" : "fontFile";
    return <>
      <Row label="字体类型"><Select<Theme["fontStyle"]> options={[...fontOptions]} value={appearance[style] ?? "sans"} onChange={value => update(style, value)} /></Row>
      <Row label="系统字体"><input aria-label="系统字体" className="max-w-full rounded-md border border-current px-2 py-1" maxLength={120} placeholder="例如 Microsoft YaHei" value={appearance[family] ?? ""} onChange={e => update(family, e.target.value)} /></Row>
      <Row label="导入字体">
        <input aria-label="导入字体" className="max-w-full" type="file" accept=".ttf,.otf,.woff,.woff2" onChange={event => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (selected) void importAsset(selected, selected.name, "font").then(value => {
            setError("");
            update(file, value);
          }, problem => setError(String(problem)));
        }} />
        {appearance[file] && <Button onClick={() => update(file, undefined)}>移除导入字体</Button>}
      </Row>
      <ToggleRow label="自动字重" checked={appearance[weight] == null} onChange={auto => update(weight, auto ? undefined : 500)} />
      {appearance[weight] != null && <SliderRow label="字重" value={appearance[weight]} min={100} max={900} step={10} format={String} onChange={value => update(weight, value)} />}
    </>;
  };
  const adapter = getVisualizerTuning(mode);
  const entry = getVisualizerRegistryEntry(mode as Parameters<typeof getVisualizerRegistryEntry>[0]);
  const stored = settings?.foliaTunings?.[mode];
  const tuning = stored ? adapter?.storage?.read(stored) ?? stored : adapter?.defaults;
  const tuningsWith = (change: object) => {
    const next = mode === "cappella" ? { ...tuning as object, ...change }
      : adapter?.storage?.merge(tuning, change) ?? { ...tuning as object, ...change };
    return { ...settings?.foliaTunings, [mode]: next as Record<string, unknown> };
  };
  const updateTuning = (change: object) => {
    const foliaTunings = tuningsWith(change);
    if (mode !== "tempera" || !("layerImages" in change) || !Array.isArray(change.layerImages)) {
      patch({ foliaTunings });
      return;
    }
    void Promise.all(change.layerImages.map(async ({ id, name }) => {
      const existing = assets?.tempera?.find(item => item.id === id);
      if (existing) return existing;
      const image = await getTemperaLayerImage(id);
      if (!image) throw new Error(`缺少图片 ${name}`);
      return { id, name, file: await importAsset(image.blob, name, "image") };
    })).then(tempera => {
      setError("");
      patch({ foliaTunings, foliaAssets: { ...assets, tempera } });
    }, problem => setError(String(problem)));
  };
  const importImages = async (slot: AssetSlot, files: File[], option: object) => {
    try {
      const previous = slot === "monet" ? [] : assets?.[slot] ?? [];
      if (previous.length + files.length > 30) throw new Error("每组最多 30 张图片");
      const added = [];
      for (const file of files) {
        const id = await importAsset(file, file.name, "image");
        added.push({ id: crypto.randomUUID(), name: file.name.slice(0, 120), file: id });
      }
      patch({ foliaTunings: tuningsWith(option), foliaAssets: { ...assets, [slot]: [...previous, ...added] } });
      return { ok: true };
    } catch (problem) {
      return { ok: false, error: String(problem) };
    }
  };
  const clearImages = async (slot: AssetSlot, option: object) => {
    patch({ foliaTunings: tuningsWith(option), foliaAssets: { ...assets, [slot]: [] } });
  };
  const assetActions = {
    handleUploadMonetPortraitImage: (files: File[]) => importImages("monet", files.slice(0, 1), { portraitSource: "custom" }),
    handleClearMonetPortraitImage: () => clearImages("monet", { portraitSource: "cover" }),
    handleImportCustomCappellaEmojiPack: (files: File[]) => importImages("emoji", files, { emojiPackSource: "custom" }),
    handleClearCustomCappellaEmojiPack: () => clearImages("emoji", { emojiPackSource: "builtin" }),
    handleImportCustomCappellaAvatar: (files: File[]) => importImages("avatar", files, { avatarSource: "custom" }),
    handleClearCustomCappellaAvatar: () => clearImages("avatar", { avatarSource: "builtin" }),
  };
  const reset = () => {
    if (tab === "effects") {
      const next = { ...settings?.foliaTunings };
      delete next[mode];
      patch({ foliaTunings: next });
    } else {
      const next = { ...appearance };
      for (const key of Object.keys(next) as (keyof Appearance)[]) {
        const group = key.startsWith("subtitle") || key === "hideTranslationSubtitle" || key === "showHarmonySubtitle" || key === "harmonySubtitleBackground"
          ? "subtitles" : key.endsWith("Color") ? "colors" : key === "renderQuality" || key === "showOriginalBackground" ? "global" : "fonts";
        if (group === tab) delete next[key];
      }
      patch({ foliaAppearance: next });
    }
  };
  const isEnabled = settings?.foliaTuningEnabled?.[mode] !== false;
  return <SettingsKitThemeContext.Provider value={{ isDaylight: daylight }}>
    <div ref={container} className="px-2 text-sm" style={{
      ...settingsTokens(daylight),
      ["--text-primary" as string]: daylight ? "#242429" : "#eeeeef",
      color: "var(--text-primary)",
      fontFamily: "system-ui, sans-serif",
    }}>
      <Tabs tabs={tabs} activeId={tab} onSelect={setTab} label="Folia 歌词设置"
        action={<Button variant="quiet" onClick={reset}>恢复默认</Button>} />
      {error && <p role="status" className="p-2 text-red-500">{error}</p>}
      {settings && <div className="space-y-3 py-3" data-folia-mode={mode}>
        {tab === "effects" && (entry.renderSettingsPanel ? (
          <fieldset disabled={!isEnabled} className="min-w-0 disabled:opacity-50" key={mode}>
            {entry.renderSettingsPanel({ t, isDaylight: daylight, theme, controlCardBg: "", rangeInputClass: "w-full", tuning, settings: assetActions, onTuningChange: updateTuning })}
          </fieldset>
        ) : <p className="px-3 py-2">这个样式没有独立动画参数。可在其他标签调整通用外观。</p>)}
        {tab === "colors" && <Group def={{ id: "folia-colors", titleKey: "theme.themePark" }}>
          {colorFields.map(([key, label]) => <Row key={key} label={label}>
            <input aria-label={label} type="color" value={theme[key]} onChange={e => update(key, e.target.value)} />
          </Row>)}
        </Group>}
        {tab === "fonts" && <Group def={{ id: "folia-fonts", titleKey: "options.previewCommonSettings" }}>
          {font(false)}
          {ranges("lyricsFontScale", "歌词字号", 0.85, 1.4)}
          {ranges("visualizerOpacity", "歌词画面不透明度", 0.2, 1)}
        </Group>}
        {tab === "subtitles" && <Group def={{ id: "folia-subtitles", titleKey: "options.previewSubtitleSettings" }}>
          <ToggleRow label="隐藏底部字幕" checked={appearance.hideTranslationSubtitle ?? false} onChange={value => update("hideTranslationSubtitle", value)} />
          <SubtitleOverlayRowsSetting t={t} layout={parseSubtitleOverlayLayout(appearance.subtitleOverlayLayout) ?? `${altMode}|only`} onChange={value => update("subtitleOverlayLayout", value)} />
          <Row label="样式内副字幕内容"><Select<SubtitleContentMode> options={[...subtitleOptions]} value={appearance.subtitleContentMode ?? altMode} onChange={value => update("subtitleContentMode", value)} /></Row>
          {ranges("subtitleOverlayOpacity", "字幕不透明度", 0.2, 1, 0.6)}
          <ToggleRow label="字幕柔光" checked={appearance.subtitleOverlayBackground ?? false} onChange={value => update("subtitleOverlayBackground", value)} />
          <ToggleRow label="模糊下一句" checked={appearance.subtitleUpcomingLyricsBlur ?? true} onChange={value => update("subtitleUpcomingLyricsBlur", value)} />
          <ToggleRow label="显示和声字幕" checked={appearance.showHarmonySubtitle ?? false} onChange={value => update("showHarmonySubtitle", value)} />
          {appearance.showHarmonySubtitle && <ToggleRow label="和声字幕柔光" checked={appearance.harmonySubtitleBackground ?? false} onChange={value => update("harmonySubtitleBackground", value)} />}
          <ToggleRow label="字幕继承歌词字体" checked={appearance.subtitleFontInheritsLyrics !== false} onChange={value => update("subtitleFontInheritsLyrics", value)} />
          {appearance.subtitleFontInheritsLyrics === false && font(true)}
          {ranges("subtitleFontScale", "字幕缩放", 0.85, 1.4)}
        </Group>}
        {tab === "global" && <Group def={{ id: "folia-global", titleKey: "options.previewGlobalSettings" }}>
          <ToggleRow label="显示 Folia 原版背景" checked={appearance.showOriginalBackground === true} onChange={value => update("showOriginalBackground", value)} />
          <Row label="默认渲染分辨率">
            <Select value={String(quality.scale)} options={LYRIC_RENDER_SCALES.map(scale => ({ value: String(scale), label: `${scale}×` }))}
              onChange={value => update("renderQuality", normalizeLyricRenderQuality({ ...quality, scale: Number(value) }))} />
          </Row>
          <Row label="默认抗锯齿">
            <Select<LyricAntialias> value={quality.antialias} options={[{ value: "auto", label: "自动" }, { value: "on", label: "开启" }, { value: "off", label: "关闭" }]}
              onChange={antialias => update("renderQuality", { ...quality, antialias })} />
          </Row>
        </Group>}
      </div>}
    </div>
  </SettingsKitThemeContext.Provider>;
}
