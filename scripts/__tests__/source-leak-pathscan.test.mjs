import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCANNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "source-leak-gate.mjs");

// Every marker is ASSEMBLED from individually-clean fragments so this committed
// test file stays clean under the gate's own self-check — no complete marker
// (and none of the negative examples, which are themselves content-rule matches)
// appears as a literal here. The real names exist only in throwaway temp repos.
const V = "v" + "6.13";                          // version prefix (avoids a vN.N literal)
const ph = (n) => "phase" + "-" + n;             // milestone-number segment
const ws = (n) => "GS" + "D-" + n;               // workstream id, assembled from fragments
const planV = V + "-" + "PL" + "AN.md";          // versioned planning-doc name
const roadV = V + "-" + "ROAD" + "MAP.md";
// Negative examples (must NOT be path-flagged); also assembled so they don't
// trip the CONTENT rules in this file:
const apiDir = "api/" + "v2";                    // versioned API dir
const eccDir = "crypto/" + "P" + "-256";         // ECC curve dir
const hashSlug = "assets/" + "000123" + "-abc";  // 6-digit slug
const localeFile = "i18n/" + "en-US-" + "001-AB" + "-12" + ".json"; // region code
const httpName = "lib/" + "P" + "404" + "-error.png"; // HTTP code in a name

function sh(cwd, args) { execFileSync("git", args, { cwd, stdio: "ignore" }); }

function makeRepo(baseFiles, prFiles, renames = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slg-path-"));
  sh(dir, ["init", "-q"]);
  sh(dir, ["config", "user.email", "t@t.t"]);
  sh(dir, ["config", "user.name", "t"]);
  const write = (p, c) => { fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
  for (const [p, c] of Object.entries(baseFiles)) write(p, c);
  sh(dir, ["add", "-A"]); sh(dir, ["commit", "--allow-empty", "-qm", "base"]); sh(dir, ["branch", "base-ref"]);
  sh(dir, ["checkout", "-q", "-b", "pr"]);
  for (const [from, to] of renames) sh(dir, ["mv", from, to]);
  for (const [p, c] of Object.entries(prFiles)) write(p, c);
  sh(dir, ["add", "-A"]); sh(dir, ["commit", "-qm", "pr"]);
  return dir;
}

function scan(dir, mode, extra = []) {
  let out;
  try {
    out = execFileSync("node", [SCANNER, "--profile", "default", "--ratchet-mode", mode, "--format", "json", ...extra],
      { cwd: dir, encoding: "utf8", env: { ...process.env, SOURCE_LEAK_DIFF_BASE: "base-ref" } });
  } catch (e) { out = e.stdout || "{}"; }
  return JSON.parse(out);
}
const pathFiles = (j) => new Set((j.samples || []).filter((f) => f.line === 0).map((f) => f.file));

test("line mode: newly-added leaky dir, file, and binary names block; clean adds don't", () => {
  const dir = makeRepo(
    { "src/index.ts": "ok\n" },
    {
      "src/feature.ts": "clean\n",
      [`${ph("553")}/migration.ts`]: "x\n",
      [roadV]: "x\n",
      [`${ws("001")}-notes.md`]: "x\n",
      [`report-${ph("553")}-diagram.png`]: "x\n", // binary-ish: content not scanned, name is
    });
  const f = pathFiles(scan(dir, "line"));
  assert.ok(f.has(`${ph("553")}/migration.ts`), "leaky dir blocked");
  assert.ok(f.has(roadV), "versioned planning doc blocked");
  assert.ok(f.has(`${ws("001")}-notes.md`), "workstream id blocked");
  assert.ok(f.has(`report-${ph("553")}-diagram.png`), "leaky binary name blocked (extension-independent)");
  assert.ok(!f.has("src/feature.ts"), "clean add not flagged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("line mode: pre-existing leaky path tolerated; rename INTO a leaky name blocks", () => {
  const dir = makeRepo(
    { [`${ph("100")}/old.ts`]: "legacy\n", "src/index.ts": "ok\n" },
    {},
    [["src/index.ts", `src/${ph("204")}-index.ts`]]);
  const f = pathFiles(scan(dir, "line"));
  assert.ok(!f.has(`${ph("100")}/old.ts`), "pre-existing leaky path tolerated");
  assert.ok(f.has(`src/${ph("204")}-index.ts`), "rename into a leaky name blocked");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no path false positives: versioned API dir, ECC curve dir, slug, region code, HTTP code", () => {
  const dir = makeRepo({}, {
    [`${apiDir}/handler.ts`]: "x\n",
    [`${eccDir}/ecc.ts`]: "x\n",
    [`${hashSlug}/up.sql`]: "x\n",
    [localeFile]: "x\n",
    [httpName]: "x\n",
  });
  const f = pathFiles(scan(dir, "line"));
  assert.equal(f.size, 0, `expected no path findings, got ${[...f]}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("per-segment isolation: a benign segment does not suppress a leaky sibling", () => {
  const dir = makeRepo({}, { [`${eccDir}/${ph("553")}/k.ts`]: "x\n" });
  assert.ok(pathFiles(scan(dir, "line")).has(`${eccDir}/${ph("553")}/k.ts`), "leaky segment caught despite benign sibling");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file mode: allowlisted leaky path tolerated (untouched); non-allowlisted blocks", () => {
  const dir = makeRepo(
    { [`${ph("100")}/old.ts`]: "legacy\n", "src/a.ts": "ok\n" },
    { [`${ph("553")}/new.ts`]: "x\n" });
  const allow = path.join(dir, "allow.json");
  fs.writeFileSync(allow, JSON.stringify({ files: [`${ph("100")}/old.ts`] }));
  const f = pathFiles(scan(dir, "file", ["--legacy-allowlist", allow]));
  assert.ok(!f.has(`${ph("100")}/old.ts`), "allowlisted (untouched) tolerated");
  assert.ok(f.has(`${ph("553")}/new.ts`), "non-allowlisted new leaky path blocks");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("versioned planning-doc name is path-caught; docs/ is exempt from path scan", () => {
  const dir = makeRepo({}, { [planV]: "x\n", [`docs/${planV}`]: "x\n" });
  const f = pathFiles(scan(dir, "line"));
  assert.ok(f.has(planV), "versioned planning doc name caught at repo root");
  assert.ok(![...f].some((p) => p.startsWith("docs/")), "docs/ exempt dir not path-flagged");
  fs.rmSync(dir, { recursive: true, force: true });
});
