export function readEffectShortcuts(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("studioOne.effectShortcuts") || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === "string"));
    }
  } catch { /* Ignore invalid saved preferences. */ }
  return {};
}

export function shortcutFor(event: KeyboardEvent) {
  if (event.repeat || event.isComposing || event.getModifierState("AltGraph")) return "";
  if (!event.code || /^(Control|Alt|Shift|Meta|Escape|Unidentified)/.test(event.code)) return "";
  const key = event.code.replace(/^(Key|Digit)([A-Z0-9])$/, "$2");
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Win", key].filter(Boolean).join("+");
}
