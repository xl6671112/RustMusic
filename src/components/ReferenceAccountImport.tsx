import { useState } from "react";
import { importReferenceAccount } from "../accountImport";
import Modal from "./Modal";

export default function ReferenceAccountImport() {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  return <>
    <button className="btn-secondary !py-1.5 !px-3 whitespace-nowrap" onClick={() => setOpen(true)}>
      接入原账号收藏
    </button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title="接入原播放器网易云账号" width={520}>
      <div className="space-y-3 text-[12.5px] text-[var(--ink-2)]">
        <p>选择 ListenFree 实际使用的配置目录（包含 library.sqlite）。只读取该目录对应的登录凭据，联网校验后合并收藏与歌单，不清空现有内容。已登录其他账号时不会覆盖。</p>
        <input className="input w-full" aria-label="原播放器配置目录" placeholder="C:\...\ListenFree\data"
          value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy} />
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={busy} onClick={async () => {
            const { open: select } = await import("@tauri-apps/plugin-dialog");
            const chosen = await select({ directory: true, multiple: false, title: "选择原播放器配置目录" });
            if (typeof chosen === "string") setProfile(chosen);
          }}>选择目录</button>
          <button className="btn-primary" disabled={busy || !profile.trim()} onClick={async () => {
            setBusy(true);
            setStatus("正在校验账号并读取收藏与歌单…");
            try {
              const result = await importReferenceAccount(profile.trim());
              setStatus(`账号 ${result.uid}：合并 ${result.favorites} 首收藏、${result.playlists} 个歌单，新增 ${result.addedTracks} 条歌单曲目。${result.warnings.join("；")}`);
            } catch (error) { setStatus(`导入未完成：${String(error)}`); }
            finally { setBusy(false); }
          }}>{busy ? "读取中…" : "校验并合并"}</button>
        </div>
        <p role="status" className="whitespace-pre-wrap break-words">{status}</p>
      </div>
    </Modal>
  </>;
}
