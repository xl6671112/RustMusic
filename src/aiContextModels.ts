const key = "rustmusic-ai-context-models";
const changed = "ai-context-models-changed";

export function readContextModelIDs(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
  } catch { return null; }
}

export function saveContextModelIDs(ids: string[]) {
  localStorage.setItem(key, JSON.stringify([...new Set(ids)]));
  window.dispatchEvent(new Event(changed));
}

export function contextModels<T extends { id: string }>(models: T[], ids = readContextModelIDs()): T[] {
  return ids === null ? models : models.filter((model) => ids.includes(model.id));
}

export function subscribeContextModels(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", listener);
  };
}
