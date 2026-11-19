// Reloads Pi's skills when skillnet syncs new ones, so pushed skills show up without typing /reload.
// skillnet touches ~/.config/skillnet/changed after each sync that changed files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANGED = path.join(process.env.SKILLNET_HOME || path.join(os.homedir(), ".config", "skillnet"), "changed");
const stamp = () => { try { return fs.statSync(CHANGED).mtimeMs; } catch { return 0; } };

export default function (pi: ExtensionAPI) {
  let seen = stamp(), pending = false, ctxRef: { isIdle(): boolean } | undefined;
  const reload = () => { pending = false; pi.sendUserMessage("/skillnet-reload", { expandPromptTemplates: true }); };
  const check = () => {
    const s = stamp();
    if (s <= seen) return;
    seen = s;
    if (ctxRef?.isIdle()) reload(); else pending = true; // never reload in the middle of a run
  };

  pi.registerCommand("skillnet-reload", {
    description: "Reload skills after skillnet synced changes",
    handler: async (_args, ctx) => { await ctx.reload(); return; },
  });
  pi.on("session_start", (_e, ctx) => { ctxRef = ctx; seen = stamp(); });
  pi.on("agent_settled", () => { if (pending) reload(); });
  const timer = setInterval(check, 2000);
  pi.on("session_shutdown", () => clearInterval(timer));
}
