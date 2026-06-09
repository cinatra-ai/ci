#!/usr/bin/env node
/**
 * gitignore-gate — reusable CI gate that fails when a repository has no usable
 * root `.gitignore`: missing, empty, whitespace-only, or not a regular file
 * (git >= 2.32 does not follow a symlinked `.gitignore`).
 *
 * Pairs with `config/baseline.gitignore` in this repo: the gate enforces
 * presence, the template supplies the org baseline content. A comment-only
 * `.gitignore` passes (presence is the contract); the effective entry count is
 * reported so a hollow file stays visible.
 *
 * Zero runtime dependencies (node builtins only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE_VERSION = "0.1.0";
const BASELINE_HINT =
  "seed it from the org baseline: https://github.com/cinatra-ai/ci/blob/main/config/baseline.gitignore";

const STATUS_REASONS = {
  missing: "no .gitignore found at the repo root",
  "not-a-file": "the .gitignore at the repo root is not a regular file (git >= 2.32 does not follow a symlinked .gitignore)",
  empty: "the .gitignore at the repo root is empty",
  "whitespace-only": "the .gitignore at the repo root contains only whitespace",
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      args[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[gitignore-gate] ${msg}`);
  process.exit(2);
}

// Effective entries: lines that actually ignore something (non-blank, non-comment).
function countEntries(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) count++;
  }
  return count;
}

function checkGitignore(root) {
  const file = path.join(root, ".gitignore");
  let stat;
  // lstat, not stat: a symlinked .gitignore is ignored by git >= 2.32 and must
  // not satisfy the gate even when its target has content.
  try { stat = fs.lstatSync(file); }
  catch { return { ok: false, status: "missing", file, entryCount: 0 }; }
  if (!stat.isFile()) return { ok: false, status: "not-a-file", file, entryCount: 0 };
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return fail(`.gitignore exists but is unreadable (${file}): ${e.message}`); }
  if (text.length === 0) return { ok: false, status: "empty", file, entryCount: 0 };
  if (text.trim() === "") return { ok: false, status: "whitespace-only", file, entryCount: 0 };
  return { ok: true, status: "ok", file, entryCount: countEntries(text) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root && args.root !== true ? path.resolve(String(args.root)) : process.cwd();
  let rootStat;
  try { rootStat = fs.statSync(root); } catch { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory()) fail(`--root is not a directory: ${root}`);
  const format = args.format || "text";
  const quiet = Boolean(args.quiet);

  const result = checkGitignore(root);

  if (format === "json") {
    process.stdout.write(JSON.stringify({ gateVersion: GATE_VERSION, root, ...result }, null, 2) + "\n");
  } else if (!quiet) {
    if (result.ok) {
      process.stderr.write(`gitignore-gate: clean (${result.entryCount} effective entr${result.entryCount === 1 ? "y" : "ies"}).\n`);
    } else {
      process.stderr.write(`gitignore-gate: FAIL — ${STATUS_REASONS[result.status]}; ${BASELINE_HINT}\n`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[gitignore-gate] gate failed:", e.message); process.exit(2); }
}

export { checkGitignore, countEntries };
