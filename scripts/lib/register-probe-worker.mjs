#!/usr/bin/env node
// ---------------------------------------------------------------------------
// register-probe-worker — runs an extension's serverEntry `register(ctx)` against
// the faithful grant-aware test host context, in an ISOLATED CHILD PROCESS.
//
// WHY a child process (codex MUST-FIX): the probe imports + executes UNTRUSTED
// extension code. In-process, a malicious/buggy artifact could call
// `process.exit(0)` (silently passing the gate), pollute stdout, or monkey-patch
// builtins (JSON.stringify / fs.writeSync) to forge an output line.
//
// THREAT MODEL (codex rounds 5-9 — the honest conclusion): `--register-probe` is
// an OPT-IN best-effort DIAGNOSTIC, NOT a security/trust boundary. It answers
// "does this extension's register(ctx) run clean against a faithful host?" for the
// AUTHOR. It executes UNTRUSTED extension code in-process, and any in-process
// secret is recoverable by that code (V8 heap snapshot / /proc/self/mem), so NO
// in-process verdict signal is truly forgery-proof. The PRIMARY conformance gate
// — the only TRUST boundary — is the STATIC analysis in the PARENT (import-ban,
// manifest, host-peer, readme, license, serverEntry preflight), which never runs
// extension code and cannot be bypassed by any runtime trick.
//
// The result channel below is DEFENSE-IN-DEPTH against accidental/buggy register
// code and casual forgery (it defeats a register that merely `process.exit(0)`s
// or prints a fake stdout line): a per-run nonce is delivered over STDIN (consumed
// + at EOF before import, so it does not leak via /proc env/cmdline), the verdict
// is the worker's nonce-tagged fd-3 line (not the child-mutable exit code), and
// the worker captures the real writeSync/JSON.stringify before import. A
// determined in-process attacker CAN still recover the nonce from process memory —
// which is why the probe is documented as non-authoritative, not a gate.
//
// Invocation: env IOC_PROBE_NONCE=<nonce>; fd 3 = summary pipe;
//   argv: <artifactAbs> <packageName> <grantsCsv>
// ---------------------------------------------------------------------------

import { writeSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createTestHostContext, summarizeRecorder } from "./vendor/test-host-context.mjs";

// Read the NONCE from STDIN (fd 0) SYNCHRONOUSLY at startup, BEFORE importing any
// extension code (codex round-8 MUST-FIX). Env/argv leak via /proc/self/environ
// and /proc/self/cmdline on Linux even after `delete process.env.X`; a consumed
// stdin pipe does not. fd 0 is at EOF after this read, so the imported extension
// cannot recover the nonce. Capture the REAL writeSync/JSON.stringify too, before
// any extension patch.
let NONCE = "";
try { NONCE = readFileSync(0, "utf8").trim(); } catch { NONCE = ""; }
const realWriteSync = writeSync;
const realStringify = JSON.stringify.bind(JSON);
const realExit = process.exit.bind(process); // captured before any extension patch
const RESULT_FD = 3;

// Best-effort, DISPLAY-ONLY summary on fd 3 (the verdict is the exit code). Uses
// the captured-early real builtins so a patched JSON.stringify/writeSync cannot
// rewrite it — but even if it could, it would only change DISPLAY, not the exit.
function emitSummary(obj) {
  try {
    realWriteSync(RESULT_FD, `${NONCE} ${realStringify(obj)}\n`);
  } catch {
    /* display only */
  }
}

async function run() {
  const [artifactAbs, packageName, grantsCsv] = process.argv.slice(2);
  const grants = (grantsCsv ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  let ctx, recorder, diagnostics;
  try {
    ({ ctx, recorder, diagnostics } = createTestHostContext({ packageName, grants }));
  } catch (e) {
    emitSummary({ ran: false, error: `test host context error: ${String(e && e.message)}` });
    return 1;
  }

  let mod;
  try {
    mod = await import(pathToFileURL(artifactAbs).href);
  } catch (e) {
    emitSummary({ ran: false, error: `serverEntry import failed: ${String(e && e.message)}` });
    return 1;
  }
  const register = mod.register ?? (mod.default && mod.default.register);
  if (typeof register !== "function") {
    emitSummary({ ran: false, error: `serverEntry exports no register(ctx) function` });
    return 1;
  }
  try {
    await register(ctx);
  } catch (e) {
    emitSummary({ ran: false, error: `register(ctx) threw: ${String(e && e.message)}` });
    return 1;
  }
  emitSummary({ ran: true, summary: summarizeRecorder(recorder), diagnostics });
  return 0;
}

// Use the REAL process.exit captured before the extension import so a patched
// process.exit cannot flip the exit-code verdict (codex round-6 MUST-FIX).
run().then(
  (code) => realExit(code === 0 ? 0 : 1),
  (e) => {
    emitSummary({ ran: false, error: `probe worker internal error: ${String(e && e.message)}` });
    realExit(1);
  },
);
