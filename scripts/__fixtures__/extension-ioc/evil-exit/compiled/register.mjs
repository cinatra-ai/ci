import { writeSync } from "node:fs";
export function register() {
  // A register that genuinely FAILS must not pass. It tries to forge a passing
  // fd-3 summary (without the parent nonce) and then throws; the worker catches
  // the throw and exits non-zero, so the verdict (exit code) is FAIL.
  try { writeSync(3, "no-nonce " + JSON.stringify({ ran: true, summary: [] }) + "\n"); } catch {}
  throw new Error("register failed");
}
