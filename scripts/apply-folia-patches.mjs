import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "_third_party/folia-web");
const patch = path.join(root, "patches/folia-glow-colors.patch");
const git = (...args) => spawnSync("git", ["-C", source, "apply", ...args, patch], { encoding: "utf8" });
if (git("--reverse", "--check").status === 0) {
  console.log("Folia glow color patch already applied.");
} else {
  const check = git("--check");
  if (check.status !== 0) throw new Error(`Folia patch check failed. Initialize the pinned submodule first.\n${check.stderr}`);
  const apply = git();
  if (apply.status !== 0) throw new Error(`Folia patch failed.\n${apply.stderr}`);
  console.log("Applied Folia glow color patch.");
}
