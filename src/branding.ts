import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

type Branding = { name: string; tagline: string; logo?: string | null };
let value: Branding = { name: "RustMusic", tagline: "" };
const listeners = new Set<() => void>();
export async function initBranding() {
  try {
    const data = await invoke<Branding>("get_branding");
    if (data?.name) {
      value = data;
      document.title = data.name;
      listeners.forEach((listener) => listener());
    }
  } catch { /* The built-in branding remains available. */ }
}
export function useBranding() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => value);
}
