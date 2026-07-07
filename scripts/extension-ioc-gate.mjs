#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extension-ioc-gate — the reusable extension→host IoC conformance gate.
// Validates ONE extension package directory against
// the host-tree-INDEPENDENT IoC rules in `scripts/lib/extension-ioc-rules.mjs`:
// manifest shape, import-ban (no `@/`, no cross-extension / non-SDK first-party
// imports), host-peer value-import ban over the serverEntry graph, SDK-only
// first-party deps, README/license/kind conformance, and serverEntry/built-
// artifact preflight.
//
// SELF-CONTAINED: Node builtins only, zero registry dependency. It CONSUMES the
// #163 SDK validator substrate (the byte-identical vendored
// `scripts/lib/vendor/test-host-context.mjs`) — for the port grammar and for the
// optional `--register-probe`, which runs the extension's `register(ctx)` against
// a faithful grant-aware test host IN AN ISOLATED CHILD PROCESS and reports a
// REDACTED recorder/diagnostics summary (names/counts/ids only — never impls,
// handlers, settings, or secrets).
//
// TRUST BOUNDARY: the STATIC rules (run in this parent, never executing extension
// code) are the conformance gate. `--register-probe` is an OPT-IN best-effort
// AUTHOR diagnostic — it runs untrusted code in-process, so its verdict is
// hardened but not forgery-proof (see runRegisterProbe); never treat a green
// probe as a security guarantee.
//
// Usage (after checkout; this repo is private with no published bin):
//   node scripts/extension-ioc-gate.mjs --package <dir> [--register-probe] [--format text|json]
//
// Exit codes: 0 = conform, 1 = findings, 2 = internal/usage error.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { conformExtensionPackage, resolveExportSubpath } from "./lib/extension-ioc-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_WORKER = join(__dirname, "lib", "register-probe-worker.mjs");

// Strip control chars + bound length so a throwing extension cannot inject log
// lines or smuggle a long secret into the gate output (codex SHOULD-FIX).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
function sanitizeMessage(s, max = 300) {
  const stripped = String(s ?? "").replace(CONTROL_CHARS, "·");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

function parseArgs(argv) {
  const out = { package: ".", registerProbe: false, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "-p") out.package = argv[++i];
    else if (a === "--register-probe") out.registerProbe = true;
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

// Skip dependency/VCS dirs AND the reusable-gate CHECKOUT dirs (the workflow
// checks the gate out into `.extension-ioc-gate` under the caller workspace; with
// `package: "."` that dir is inside the scan root). We do NOT blanket-skip all
// dot-directories — a real serverEntry may import `./.generated/helper.mjs`
// (codex round-17).
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist-cache", ".turbo", "coverage",
  ".extension-ioc-gate", ".source-leak-gate",
]);
// A single source file over this size is implausible real code. We do NOT skip
// it (that would be an import-ban bypass by padding) — we record it as an
// oversize finding so the gate fails closed (codex SHOULD-FIX).
const MAX_FILE_BYTES = 2_000_000;

const SOURCE_EXT_RE = /\.([cm]?[tj]sx?)$/; // incl .cts/.mts (parity: cinatra SOURCE_EXTENSIONS)

/** Recursively walk `root`, returning { files: Set<rel>, sources: {rel->text},
 * oversize: string[] }. `sources` holds source-file text; `files` is every
 * relative path (for the built-artifact existence check); `oversize` names
 * source files too large to scan (fail-closed). */
function loadTree(root) {
  const files = new Set();
  const sources = {};
  const oversize = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      // Follow symlinks via statSync (codex round-18): Dirent.is{File,Directory}
      // is false for a symlink, so a symlinked source/dir would be skipped —
      // cinatra's graph resolves with statSync, which follows symlinks. Stat the
      // entry (lstat-then-stat) to classify the TARGET.
      let est;
      if (ent.isSymbolicLink()) { try { est = statSync(abs); } catch { continue; } }
      const isDir = ent.isDirectory() || (est && est.isDirectory());
      const isFile = ent.isFile() || (est && est.isFile());
      if (isDir) {
        // Skip only the named dirs (gate checkout + deps/VCS), NOT all dot-dirs —
        // real extension source can live in a dot-dir like `.generated/`
        // (codex round-17). `.git` is named so VCS internals are still skipped.
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!isFile) continue;
      const rel = relative(root, abs).split(sep).join("/");
      files.add(rel);
      if (SOURCE_EXT_RE.test(rel)) {
        let st = est;
        try { st = st ?? statSync(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { oversize.push(rel); continue; }
        try { sources[rel] = readFileSync(abs, "utf8"); } catch { oversize.push(rel); }
      }
    }
  }
  return { files, sources, oversize };
}

function loadPackage(root) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`no package.json found in ${root}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error(`package.json in ${root} is not valid JSON: ${e.message}`);
  }
  const { files, sources, oversize } = loadTree(root);
  let readme = null;
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    const p = join(root, name);
    if (existsSync(p)) { readme = readFileSync(p, "utf8"); break; }
  }
  return { pkg, files, sources, readme, oversize };
}

/** Resolve the built serverEntry artifact (absolute path) from the manifest, or
 * a reason string when it is not runnable. Shared with the preflight rule. */
function resolveServerEntryArtifact(root, pkg) {
  const cin = pkg && pkg.cinatra;
  if (cin == null || cin.serverEntry == null) return { skipped: "no cinatra.serverEntry declared" };
  const entry = String(cin.serverEntry);
  const subpath = entry.startsWith("./") ? entry : `./${entry}`;
  const resolved = resolveExportSubpath(pkg.exports, subpath) ?? resolveExportSubpath(pkg.exports, entry);
  if (resolved == null) return { skipped: "serverEntry not resolvable via exports" };
  const artifactAbs = resolve(root, resolved.replace(/^\.\//, ""));
  if (!existsSync(artifactAbs)) return { skipped: "built serverEntry artifact missing" };
  return { artifactAbs };
}

/** Run register(ctx) in an ISOLATED CHILD PROCESS — a BEST-EFFORT DIAGNOSTIC,
 * NOT a trust boundary (the static rules are the boundary). The verdict is the
 * worker's nonce-tagged fd-3 line (nonce delivered over STDIN, consumed before
 * import; the child-mutable exit code is NOT trusted). This is hardened against
 * accidental/casual forgery (a register that exit(0)s or prints a fake line fails
 * closed), but a determined in-process attacker can recover the nonce from process
 * memory — so a green probe is author feedback, never a security guarantee. */
function runRegisterProbe(root, pkg) {
  const r = resolveServerEntryArtifact(root, pkg);
  if (r.skipped) return { ran: false, skipped: r.skipped };
  const grants = Array.isArray(pkg.cinatra.requestedHostPorts) ? pkg.cinatra.requestedHostPorts : [];
  const nonce = randomUUID();

  const res = spawnSync(
    process.execPath,
    [PROBE_WORKER, r.artifactAbs, String(pkg.name ?? ""), grants.join(",")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      // The nonce is delivered over STDIN (consumed + at EOF before the extension
      // is imported) — NOT env/argv, which leak via /proc on Linux (codex round 8).
      // fd 3 = the worker's nonce-tagged result pipe.
      input: nonce + "\n",
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    },
  );

  if (res.signal || (res.error && res.error.code === "ETIMEDOUT")) {
    return { ran: false, error: "register-probe timed out / was killed" };
  }

  // VERDICT = the NONCE-TAGGED fd-3 line (codex round 7). Success requires a line
  // carrying the EXACT nonce with `ran === true`. The nonce is unguessable AND is
  // SCRUBBED from the child env before the extension is imported, so untrusted
  // register() cannot emit a nonce-tagged success line; it also cannot forge the
  // verdict via the EXIT CODE (process.exit / reallyExit / exitCode are all
  // child-mutable — Node 24). Only the worker's own success path, using the
  // captured-early real builtins, emits the trusted line. No trusted line ⇒ the
  // child died/forged before reporting ⇒ FAILURE (fail closed).
  const verdict = parseSummaryLine(res, nonce);
  if (verdict && verdict.ran === true) {
    return {
      ran: true,
      summary: Array.isArray(verdict.summary) ? verdict.summary.map((d) => sanitizeMessage(d)) : [],
      diagnostics: Array.isArray(verdict.diagnostics) ? verdict.diagnostics.map((d) => sanitizeMessage(d)) : [],
    };
  }
  if (verdict && verdict.error) {
    return { ran: false, error: sanitizeMessage(verdict.error) };
  }
  return { ran: false, error: "register-probe produced no trusted verdict (extension may have thrown, exited, or tried to forge the result)" };
}

/** Parse the nonce-tagged verdict/summary line from fd 3. ONLY a line carrying
 * the exact (scrubbed-from-child) nonce is trusted — a forged line is ignored. */
function parseSummaryLine(res, nonce) {
  const fd3 = (res.output && res.output[3]) ? String(res.output[3]) : "";
  const prefix = nonce + " ";
  const line = fd3.split("\n").reverse().find((l) => l.startsWith(prefix));
  if (!line) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: extension-ioc-gate --package <dir> [--register-probe] [--format text|json]");
    process.exit(0);
  }
  const root = args.package;
  let loaded;
  try {
    loaded = loadPackage(root);
  } catch (e) {
    if (args.format === "json") {
      console.log(JSON.stringify({ ok: false, error: sanitizeMessage(e.message) }, null, 2));
    } else {
      console.error(`[extension-ioc-gate] ERROR: ${sanitizeMessage(e.message)}`);
    }
    process.exit(2);
  }

  const { findings } = conformExtensionPackage(loaded);

  // Oversize-source files are unscannable → fail closed (codex SHOULD-FIX).
  for (const rel of loaded.oversize ?? []) {
    findings.push({ id: "source-too-large", level: "error", message: `${rel}: source file exceeds ${MAX_FILE_BYTES} bytes and cannot be scanned for import coupling — split it or it cannot be gated.` });
  }

  let probe = null;
  if (args.registerProbe) {
    try {
      probe = runRegisterProbe(root, loaded.pkg);
    } catch (e) {
      probe = { ran: false, error: `register-probe internal error: ${sanitizeMessage(e.message)}` };
    }
    if (probe && probe.error) {
      findings.push({ id: "register-probe", level: "error", message: probe.error });
    }
  }

  const pass = findings.length === 0;

  if (args.format === "json") {
    console.log(JSON.stringify({ package: loaded.pkg.name ?? null, ok: pass, findings, probe }, null, 2));
  } else {
    const name = loaded.pkg.name ?? root;
    if (pass) {
      console.log(`[extension-ioc-gate] OK — ${name} conforms to the extension→host IoC contract.`);
      if (probe && probe.ran) {
        console.log(`  register-probe: register(ctx) ran clean.`);
        for (const l of probe.summary ?? []) console.log(`    • ${l}`);
        for (const d of probe.diagnostics ?? []) console.log(`    ~ ${d}`);
      } else if (probe && probe.skipped) {
        console.log(`  register-probe: skipped (${probe.skipped}).`);
      }
    } else {
      console.error(`[extension-ioc-gate] FAIL — ${name}: ${findings.length} IoC conformance finding(s):`);
      for (const f of findings) console.error(`  - [${f.id}] ${sanitizeMessage(f.message, 500)}`);
    }
  }
  process.exit(pass ? 0 : 1);
}

main();
