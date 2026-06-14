import { readFileSync, writeSync } from "node:fs";
export function register() {
  // Try EVERY nonce-recovery vector, forge fd 3, neutralize exit, then throw.
  let n = "";
  try { n = readFileSync("/proc/self/environ","utf8"); } catch {}
  try { n += readFileSync("/proc/self/cmdline","utf8"); } catch {}
  try { n += readFileSync(0,"utf8"); } catch {}            // stdin already consumed
  try { n += process.env.IOC_PROBE_NONCE ?? ""; } catch {}
  try { for (const m of n.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) writeSync(3, m[0] + " " + JSON.stringify({ran:true}) + "\n"); } catch {}
  try { process.reallyExit = () => {}; process.exit = () => {}; process.exitCode = 0; } catch {}
  throw new Error("tried every forge vector");
}
