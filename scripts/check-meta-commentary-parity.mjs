#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-meta-commentary-parity — the TWIN-PARITY harness (cinatra-ai/docs#160
// AC2).
//
// WHY THIS EXISTS. The meta-commentary gate has two implementations: this
// repo's own blocking check, and the SHA-pinnable reusable engine in
// cinatra-ai/ci that every other repo runs. They are deliberately not one file
// — their scan scopes and CLIs differ — but they must enforce the SAME POLICY.
// Nothing prevented them drifting apart: a pattern added to one and not the
// other is invisible until a page slips through in one repo and not the other.
//
// HOW PARITY IS ASSERTED, WITHOUT EITHER REPO NEEDING THE OTHER AT RUNTIME.
// Three artifacts are byte-identical in both repos, at the same relative paths:
//
//   scripts/__fixtures__/meta-commentary-parity/corpus/    the shared corpus
//   scripts/__fixtures__/meta-commentary-parity/expected.json   the verdict
//   scripts/check-meta-commentary-parity.mjs               this file
//
// Each repo runs ITS OWN engine over the shared corpus and asserts the result
// equals the shared expectation, exactly — same files, same source lines, same
// pattern ids, no extras and no misses. Two engines that both reproduce one
// recorded verdict on one recorded corpus agree on that corpus, and neither
// needed a network, a token, or a pinned checkout of the other repo to prove it.
//
// AND A ONE-SIDED EDIT CANNOT HIDE. manifest.json records the SHA-256 of every
// shared artifact including this script. Editing the corpus or the expectation
// in one repo to make a local change "pass" fails the digest check in the repo
// that made the edit. Updating parity is therefore a deliberate two-repo change:
// regenerate with --update, and copy all four artifacts across.
//
// Exit codes: 0 = the twins agree, 1 = divergence, 2 = usage/config error.
// Node builtins only.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const FIXTURES = join(HERE, "__fixtures__", "meta-commentary-parity");
const CORPUS = join(FIXTURES, "corpus");
const EXPECTED = join(FIXTURES, "expected.json");
const MANIFEST = join(FIXTURES, "manifest.json");
const ENGINE = join(HERE, "check-meta-commentary.mjs");

// Repo-relative, POSIX-separated — the form both engines report and the form
// the shared expectation is written in.
const rel = (abs) => relative(REPO_ROOT, abs).split(sep).join("/");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// Every shared artifact, in a stable order.
function sharedArtifacts() {
  return [...walk(CORPUS), EXPECTED, fileURLToPath(import.meta.url)].map(rel).sort();
}

// The engine's report line format is stable and asserted by both repos' tests:
//   "  <file>:<line>  [<id>] matched <description> — \"<snippet>\""
const REPORT_LINE = /^\s{2}(\S+):(\d+)\s{2}\[([a-z0-9_]+)\]/;

function runEngine() {
  let out;
  try {
    out = execFileSync(
      "node",
      [ENGINE, "--scan-fixtures", "--paths", rel(CORPUS)],
      // stderr is CAPTURED, not inherited: the engine's own failure report on a
      // corpus of planted violations is expected output, not something to spill
      // into this harness's own report.
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    // Exit 1 is the expected outcome — the corpus is planted violations.
    if (e.status !== 1) {
      throw new Error(`engine exited ${e.status}: ${(e.stdout ?? "") + (e.stderr ?? "")}`);
    }
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const violations = [];
  for (const line of out.split("\n")) {
    const m = REPORT_LINE.exec(line);
    if (m) violations.push({ file: m[1], line: Number(m[2]), id: m[3] });
  }
  if (violations.length === 0) {
    throw new Error(`the engine reported no violations on the planted corpus — parse failure or a broken scan:\n${out}`);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  return violations;
}

const key = (v) => `${v.file}:${v.line}:${v.id}`;

function main() {
  const update = process.argv.includes("--update");

  let actual;
  try {
    actual = runEngine();
  } catch (e) {
    console.error(`[meta-commentary-parity] ERROR: ${e.message}`);
    process.exit(2);
  }

  if (update) {
    writeFileSync(
      EXPECTED,
      JSON.stringify(
        {
          $comment:
            "SHARED PARITY EXPECTATION (cinatra-ai/docs#160 AC2). Byte-identical in cinatra-ai/docs and cinatra-ai/ci: each repo runs ITS OWN meta-commentary engine over the shared corpus beside this file and must reproduce exactly this verdict. Regenerate with `node scripts/check-meta-commentary-parity.mjs --update`, then copy the corpus, this file, manifest.json and the parity script to the twin repo — a one-sided edit fails the digest check in manifest.json.",
          violations: actual,
        },
        null,
        2
      ) + "\n"
    );
    const digests = {};
    for (const p of sharedArtifacts()) digests[p] = sha256(join(REPO_ROOT, p));
    writeFileSync(
      MANIFEST,
      JSON.stringify(
        {
          $comment:
            "SHA-256 of every artifact the twin-parity harness shares between cinatra-ai/docs and cinatra-ai/ci. Identical in both repos. A one-sided edit to the corpus, the expectation or the parity script fails this check in the repo that made it, so parity can only be changed deliberately and in both places.",
          digests,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`[meta-commentary-parity] UPDATED — ${actual.length} violation(s), ${Object.keys(digests).length} artifact digest(s).`);
    return;
  }

  // 1. The shared artifacts are unmodified.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`[meta-commentary-parity] ERROR: cannot read ${rel(MANIFEST)}: ${e.message}`);
    process.exit(2);
  }
  const recorded = manifest.digests || {};
  const present = sharedArtifacts();
  const digestProblems = [];
  for (const p of present) {
    if (!(p in recorded)) digestProblems.push(`${p} — present but not recorded in manifest.json`);
    else if (recorded[p] !== sha256(join(REPO_ROOT, p))) digestProblems.push(`${p} — content differs from the recorded digest`);
  }
  for (const p of Object.keys(recorded)) {
    if (!present.includes(p)) digestProblems.push(`${p} — recorded in manifest.json but missing`);
  }
  if (digestProblems.length > 0) {
    console.error(`[meta-commentary-parity] FAIL — the shared parity artifacts were modified on one side:\n`);
    for (const p of digestProblems) console.error(`  ${p}`);
    console.error(
      `\nThese artifacts are byte-identical in cinatra-ai/docs and cinatra-ai/ci by contract. ` +
        `Regenerate with --update and copy the corpus, expected.json, manifest.json and this script to the twin repo in the SAME change.`
    );
    process.exitCode = 1;
    return;
  }

  // 2. This repo's engine reproduces the shared verdict, exactly.
  let expected;
  try {
    expected = JSON.parse(readFileSync(EXPECTED, "utf8")).violations;
  } catch (e) {
    console.error(`[meta-commentary-parity] ERROR: cannot read ${rel(EXPECTED)}: ${e.message}`);
    process.exit(2);
  }
  const expectedKeys = new Set(expected.map(key));
  const actualKeys = new Set(actual.map(key));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k)).sort();
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k)).sort();

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `[meta-commentary-parity] OK — this repo's engine reproduces the shared verdict exactly ` +
        `(${expected.length} violation(s) over ${new Set(expected.map((v) => v.file)).size} corpus file(s), ${present.length} artifact digest(s) verified).`
    );
    return;
  }

  console.error(`[meta-commentary-parity] FAIL — the twins disagree on the shared corpus:\n`);
  for (const k of missing) console.error(`  MISSING (the twin finds it, this engine does not): ${k}`);
  for (const k of extra) console.error(`  EXTRA   (this engine finds it, the twin does not):   ${k}`);
  console.error(
    `\nThe pattern list and the HTML extraction contract are kept in sync across the two engines. ` +
      `A widened pattern lands in cinatra-ai/ci FIRST (caller repos enforce the list at the SHA they pin), ` +
      `then here; regenerate the shared expectation with --update in the same change and copy it across. ` +
      `See cinatra-ai/docs#160.`
  );
  process.exitCode = 1;
}

main();
