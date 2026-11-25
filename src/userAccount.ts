import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { api } from "./api";
import { detectSystemLang, setLanguagePref } from "./i18n";
import { ACCENTS, UI_THEMES } from "./theme";
export type Account = { id: number; username: string };
let account: Account | null = null;
let initialized = false;
let revision = 0;
const changed = "user-account-changed";
export function currentAccount() { return account; }
function update(user: Account | null) { ++revision; account = user; window.dispatchEvent(new Event(changed)); }
export function accountRequest<T>(action: string, body?: unknown): Promise<T> { return invoke<T>("user_account_request", { action, body }); }
export async function refreshAccount() {
  const version = revision;
  const value = await accountRequest<{ user: Account }>("me");
  if (version === revision) update(value.user); return account;
}
export function subscribeAccount(listener: () => void) {
  window.addEventListener(changed, listener);
  if (!initialized) {
    initialized = true;
    void listen("user-account-invalidated", () => {
      update(null); useStore.getState().toast("帐号已在其他设备登录或登录已失效，请重新登录", "error");
    }).catch(() => {});
    void refreshAccount().catch(() => {});
  }
  return () => window.removeEventListener(changed, listener);
}
export async function signIn(action: "register" | "login", username: string, password: string) {
  const version = ++revision;
  const value = await accountRequest<{ user: Account }>(action, { username: username.trim(), password });
  if (version === revision) update(value.user);
}
export async function signOut() { const version = ++revision; try { await accountRequest("logout"); } finally { if (version === revision) update(null); } }
// Only appearance and playback preferences are portable; never serialize the store wholesale.
export function portableSettings() {
  const s = useStore.getState();
  return { theme: s.theme, uiTheme: s.uiTheme, accent: s.accent, language: s.language,
    qualities: s.qualities, closeAction: s.closeAction, autoUpdate: s.autoUpdate };
}
export async function saveAccountSettings() { await accountRequest("settings-put", { settings: portableSettings() }); }
export async function restoreAccountSettings() {
  const owner = currentAccount()?.id;
  const { settings: p } = await accountRequest<{ settings: Record<string, unknown> | null }>("settings-get");
  if (currentAccount()?.id !== owner) throw new Error("帐号已切换，请重试");
  if (!p) throw new Error("帐号中还没有保存设置");
  const s = useStore.getState();
  if (p.theme === "dark" || p.theme === "light") s.setTheme(p.theme);
  if (UI_THEMES.some(t => t.key === p.uiTheme)) s.setUiTheme(p.uiTheme as typeof s.uiTheme);
  if (ACCENTS.some(t => t.key === p.accent)) s.setAccent(p.accent as string);
  if (p.language === "auto" || p.language === "zh" || p.language === "en") { await api.setLanguage(p.language, detectSystemLang()); useStore.setState({ language: p.language }); setLanguagePref(p.language); }
  if (p.closeAction === "tray" || p.closeAction === "exit") { await api.setCloseAction(p.closeAction); useStore.setState({ closeAction: p.closeAction }); }
  if (typeof p.autoUpdate === "boolean") { await api.setAutoUpdate(p.autoUpdate); useStore.setState({ autoUpdate: p.autoUpdate }); }
  const q = p.qualities as Record<string, unknown> | undefined;
  for (const kind of ["netease", "qq", "kugou"] as const) if (q && typeof q[kind] === "string" && ["standard", "high", "exhigh", "lossless", "hires", "jyeffect", "sky", "jymaster"].includes(q[kind] as string)) { await api.setPlayQuality(kind, q[kind] as string); useStore.setState(state => ({ qualities: { ...state.qualities, [kind]: q[kind] as string } })); }
}

