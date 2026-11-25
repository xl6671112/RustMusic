import { useEffect, useState } from "react";
import { currentAccount, subscribeAccount, signIn, signOut, saveAccountSettings, restoreAccountSettings } from "../userAccount";
export default function UserAccountSettings({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [user, setUser] = useState(currentAccount);
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => subscribeAccount(() => { setUser(currentAccount()); setPassword(""); }), []);
  const run = async (action: () => Promise<unknown>, text: string) => {
    if (busy) return; setBusy(true); setMessage("");
    try { await action(); setPassword(""); setMessage(text); } catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  };
  return <section className={className} id={compact ? undefined : "user-account"}><h2 className="font-semibold mb-3">{compact ? "登录帐号" : "我的帐号"}</h2>{!compact && <p className="text-xs text-[var(--ink-3)] mb-4 leading-6">保存播放器偏好和网页歌单。帐号同时仅限一台设备在线，新设备登录会退出原设备。</p>}
    {user ? <><div className="flex flex-wrap items-center gap-3"><strong className="break-all flex-1">{user.username}</strong><button className="btn-secondary" disabled={busy} onClick={() => void run(signOut, "已退出帐号")}>退出帐号</button></div><div className="mt-4 flex flex-wrap gap-2"><button className="btn-secondary" disabled={busy} onClick={() => void run(saveAccountSettings, "设置已保存到帐号")}>保存设置到帐号</button><button className="btn-secondary" disabled={busy} onClick={() => void run(restoreAccountSettings, "已应用帐号中的外观与播放偏好")}>恢复帐号设置</button></div><p className="mt-2 text-xs text-[var(--ink-3)] leading-6">仅同步外观、语言、音质等偏好，不上传本地路径、第三方登录信息或设备配置。</p></> : <form onSubmit={e => { e.preventDefault(); void run(() => signIn(register ? "register" : "login", username, password), register ? "注册成功，已登录" : "登录成功"); }} className="space-y-3"><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="text-sm min-w-0">帐号<input aria-label="用户帐号" autoComplete="username" required maxLength={48} className="mt-1 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--shade)] p-2" value={username} onChange={e => setUsername(e.target.value)} /></label><label className="text-sm min-w-0">密码<input aria-label="用户密码" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={6} maxLength={128} className="mt-1 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--shade)] p-2" value={password} onChange={e => setPassword(e.target.value)} /></label></div><div className="flex flex-wrap gap-2"><button type="submit" className="btn-primary" disabled={busy}>{busy ? "正在处理…" : register ? "注册并登录" : "登录"}</button><button type="button" className="btn-secondary" disabled={busy} onClick={() => { setRegister(!register); setMessage(""); }}>{register ? "已有帐号，去登录" : "注册新帐号"}</button></div></form>}
    {!!message && <p role="status" className="mt-3 text-sm break-words">{message}</p>}
  </section>;
}
