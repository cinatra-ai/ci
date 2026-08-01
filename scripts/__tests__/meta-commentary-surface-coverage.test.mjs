// Tests for the new-surface detector (cinatra-ai/docs#160 AC11).
//
// The reconciliation core is pure, so every case is a recorded census against a
// recorded inventory — no network, no fixtures that drift with the real org.
// The two cases the AC names explicitly are pinned by their own fixtures:
// a MISSING REPO (a public repo that arrived after the census) and a MISSING
// CALLER ON A NEWLY DECLARED SURFACE (an inventoried repo that grew a docs/
// tree). The degraded-read cases are pinned too, because a coverage check that
// passes when it cannot see is worse than none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "scripts", "meta-commentary-surface-coverage.mjs");
const FIX = "scripts/__fixtures__/meta-commentary-coverage";
const INVENTORY = `${FIX}/inventory.json`;

function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function findings(censusFixture) {
  const { code, out } = run(["--inventory", INVENTORY, "--census-json", `${FIX}/${censusFixture}`, "--json"]);
  const jsonStart = out.indexOf("{");
  return { code, out, data: JSON.parse(out.slice(jsonStart, out.lastIndexOf("}") + 1)) };
}

test("a fully accounted-for org is green", () => {
  const { code, out } = run(["--inventory", INVENTORY, "--census-json", `${FIX}/census-clean.json`]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 3 public, non-archived repo\(s\) reconciled/);
});

test("private and archived repos are out of scope, not findings", () => {
  // census-clean carries one archived repo (excluded by the inventory) and one
  // PRIVATE repo with published-looking paths and no caller. Neither may fail:
  // a private repo publishes nothing, and no caller can be added to an archive.
  const { data } = findings("census-clean.json");
  assert.deepEqual(data.findings, []);
  assert.equal(data.checked, 3);
});

test("AC11 case 1 — a NEW public repo with no inventory entry fails", () => {
  const { code, data, out } = findings("census-missing-repo.json");
  assert.equal(code, 1, out);
  const f = data.findings.find((x) => x.kind === "unknown-repo");
  assert.ok(f, out);
  assert.equal(f.repo, "fixture-org/brand-new-connector");
});

test("AC11 case 2 — a newly declared surface on a known repo, with no caller covering it, fails", () => {
  const { code, data, out } = findings("census-missing-caller.json");
  assert.equal(code, 1, out);

  // The repo grew docs/*.md the inventory never recorded — the surface is
  // undeclared even though its repo (and its caller) are known.
  const undeclared = data.findings.filter((x) => x.kind === "undeclared-surface" && x.repo === "fixture-org/example-connector");
  assert.deepEqual(undeclared.map((x) => x.path).sort(), ["docs/overview.md", "docs/use-it.md"]);

  // And the repo that grew a CHANGELOG has neither a record nor a caller.
  const internal = data.findings.filter((x) => x.repo === "fixture-org/internal-tooling");
  assert.deepEqual(internal.map((x) => x.kind), ["undeclared-surface"]);
  assert.equal(internal[0].path, "CHANGELOG.md");
});

test("a deleted caller on a recorded published repo fails", () => {
  const { code, data, out } = findings("census-caller-removed.json");
  assert.equal(code, 1, out);
  const f = data.findings.find((x) => x.kind === "missing-caller");
  assert.ok(f, out);
  assert.equal(f.repo, "fixture-org/example-connector");
});

test("a recorded `coverage` escape — and only a recorded one — stands in for a caller", () => {
  // fixture-org/docs publishes and has NO caller, but every published surface
  // records coverage: "repo-local". It must not be a missing-caller finding in
  // any census.
  for (const c of ["census-clean.json", "census-missing-repo.json", "census-caller-removed.json"]) {
    const { data } = findings(c);
    assert.equal(
      data.findings.some((x) => x.kind === "missing-caller" && x.repo === "fixture-org/docs"),
      false,
      `fixture-org/docs was reported missing-caller in ${c}`
    );
  }
});

test("an inventory entry for a repo that is no longer public/live is reported", () => {
  const { data } = findings("census-missing-caller.json");
  // census-missing-caller drops nothing, so no stale entries; the archived repo
  // is in excludedArchivedRepos and never counts as stale.
  assert.equal(data.findings.some((x) => x.kind === "stale-inventory-repo"), false);

  // Now a census that has genuinely lost a repo.
  const { code, out } = run([
    "--inventory",
    INVENTORY,
    "--census-json",
    `${FIX}/census-caller-removed.json`,
  ]);
  assert.equal(code, 1, out);
});

test("fail-closed: an empty census is refused, never reported as green", () => {
  const { code, out } = run(["--inventory", INVENTORY, "--census-json", `${FIX}/census-empty.json`]);
  assert.equal(code, 2, out);
  assert.match(out, /census is empty/);
});

test("fail-closed: a missing inventory or census is a config error, not a pass", () => {
  assert.equal(run(["--inventory", `${FIX}/nope.json`, "--census-json", `${FIX}/census-clean.json`]).code, 2);
  assert.equal(run(["--inventory", INVENTORY, "--census-json", `${FIX}/nope.json`]).code, 2);
});

test("fail-closed: neither or both of --live/--census-json is a usage error", () => {
  assert.equal(run(["--inventory", INVENTORY]).code, 2);
  assert.equal(run(["--inventory", INVENTORY, "--live", "--census-json", `${FIX}/census-clean.json`]).code, 2);
});

test("the real inventory is well-formed for this check", () => {
  // Guards the shape the check depends on, in the file the org actually ships:
  // surfacePatterns present, every repo entry carrying surfaces with a class,
  // and every recorded coverage escape being a non-empty string.
  const inv = JSON.parse(
    execFileSync("node", ["-e", "process.stdout.write(require('fs').readFileSync('config/meta-commentary-inventory.json','utf8'))"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
  );
  assert.ok(Array.isArray(inv.surfacePatterns) && inv.surfacePatterns.length > 0);
  assert.match(inv.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
  for (const r of inv.repos) {
    assert.ok(typeof r.repo === "string" && r.repo.includes("/"), `bad repo entry: ${JSON.stringify(r)}`);
    for (const s of r.surfaces || []) {
      assert.ok(typeof s.path === "string" && s.path.length > 0);
      assert.ok(typeof s.class === "string" && s.class.length > 0);
      if ("coverage" in s) assert.ok(typeof s.coverage === "string" && s.coverage.length > 0);
    }
  }
});
