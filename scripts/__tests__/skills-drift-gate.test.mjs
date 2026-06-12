import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractIdentifiers,
  buildSkillIndex,
  intersect,
  parseAcks,
  listSkillFiles,
  pathDerivedRoutes,
} from "../skills-drift-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "skills-drift-gate.mjs");
const SKILLS = path.join(import.meta.dirname, "..", "__fixtures__", "skills-drift");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdg-")));
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function git(cwd, ...a) { return spawnSync("git", a, { cwd, encoding: "utf8" }); }

// Build a throwaway git repo with one commit on main and a feature branch whose
// diff is `diffText`, so the gate's real diff path (merge-base..HEAD) is exercised.
function repoWithDiff(baseFile, headContent) {
  const dir = tmpDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src.ts"), baseFile);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src.ts"), headContent);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  return dir;
}

function runGate(cwd, extraArgs) {
  return spawnSync("node", [GATE, "--skills-dir", SKILLS, "--format", "json", ...extraArgs], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" },
  });
}

// --- Pure: extractIdentifiers ------------------------------------------------

test("extractIdentifiers pulls primitives, packages, and routes; not prose", () => {
  const { primitives, packages, routes } = extractIdentifiers(
    "call agent_run with @cinatra-ai/email-outreach-agent at /api/agents/passthrough; please run the campaign and follow up",
  );
  assert.ok(primitives.has("agent_run"));
  assert.ok(packages.has("@cinatra-ai/email-outreach-agent"));
  assert.ok(routes.has("/api/agents/passthrough"));
  // prose words ("run", "campaign", "follow up") are NOT snake_case primitives
  assert.ok(!primitives.has("run"));
  assert.ok(!primitives.has("campaign"));
  assert.ok(!primitives.has("follow"));
});

test("extractIdentifiers: a bare slug without the @cinatra-ai scope is not a package", () => {
  const { packages } = extractIdentifiers("the email-outreach-agent does outreach");
  assert.equal(packages.size, 0);
});

test("extractIdentifiers: a single bare word is never a primitive (needs an underscore)", () => {
  const { primitives } = extractIdentifiers("dispatch invoke configure validate publish");
  assert.equal(primitives.size, 0);
});

test("extractIdentifiers: a generic /agents mention without a sub-segment is not a route", () => {
  const { routes } = extractIdentifiers("see the /agents page");
  assert.equal(routes.size, 0);
});

test("extractIdentifiers: a Next.js dynamic route keeps its bracket segment whole", () => {
  const { routes } = extractIdentifiers("hit /api/agents/[agentId]/run for the dispatch");
  assert.ok(routes.has("/api/agents/[agentId]/run"), [...routes].join(","));
});

test("extractIdentifiers: @cinatra-ai/foo_bar is one package, not package foo + primitive foo_bar", () => {
  const { packages, primitives } = extractIdentifiers("dep @cinatra-ai/foo_bar here");
  assert.ok(packages.has("@cinatra-ai/foo_bar"));
  assert.ok(!packages.has("@cinatra-ai/foo"));
  assert.ok(!primitives.has("foo_bar"), "the slug tail must not leak as a phantom primitive");
});

test("pathDerivedRoutes maps Next route files (and strips groups), ignores others", () => {
  const blob = pathDerivedRoutes([
    "src/app/api/agents/passthrough/route.ts",
    "app/api/agents/[id]/route.tsx",
    "app/(marketing)/campaigns/new/route.ts",
    "packages/agents/src/a2a-actions.ts",
  ]);
  const routes = blob.split("\n");
  assert.ok(routes.includes("/api/agents/passthrough"));
  assert.ok(routes.includes("/api/agents/[id]"));
  assert.ok(routes.includes("/campaigns/new"), "route group (marketing) must be stripped");
  assert.ok(!blob.includes("a2a-actions"), "non-route files contribute nothing");
});

// --- Pure: index + intersect -------------------------------------------------

test("buildSkillIndex indexes every fixture SKILL.md", () => {
  const { files, index } = buildSkillIndex(SKILLS);
  assert.equal(files.length, listSkillFiles(SKILLS).length);
  assert.equal(files.length, 3);
  assert.ok(index.primitives.has("agent_run"));
  assert.ok(index.packages.has("@cinatra-ai/email-outreach-agent"));
  assert.ok(index.routes.has("/api/agents/passthrough"));
});

test("TRUE HIT: a changed primitive flags the skill(s) that reference it", () => {
  const { index } = buildSkillIndex(SKILLS);
  const diffIds = extractIdentifiers("renamed agent_run_get to agent_run_status");
  const findings = intersect(diffIds, index);
  const hit = findings.find((f) => f.identifier === "agent_run_get");
  assert.ok(hit, "agent_run_get should be flagged");
  assert.deepEqual(hit.skills, ["skill-a/SKILL.md"]);
});

test("MULTI-SKILL HIT: an identifier referenced by two skills surfaces both", () => {
  const { index } = buildSkillIndex(SKILLS);
  // agent_run is referenced by skill-a and skill-b; @cinatra-ai/email-outreach-agent too.
  const diffIds = extractIdentifiers("touch agent_run and @cinatra-ai/email-outreach-agent");
  const findings = intersect(diffIds, index);
  const prim = findings.find((f) => f.identifier === "agent_run");
  assert.deepEqual(prim.skills, ["skill-a/SKILL.md", "skill-b/SKILL.md"]);
  const pkg = findings.find((f) => f.identifier === "@cinatra-ai/email-outreach-agent");
  assert.deepEqual(pkg.skills, ["skill-a/SKILL.md", "skill-b/SKILL.md"]);
});

test("PROSE FALSE-POSITIVE GUARD: prose-only change flags nothing", () => {
  const { index } = buildSkillIndex(SKILLS);
  // Mirrors skill-prose wording — should not intersect any indexed identifier.
  const diffIds = extractIdentifiers(
    "When you run the campaign, double check the recipient list and confirm before you proceed.",
  );
  const findings = intersect(diffIds, index);
  assert.equal(findings.length, 0);
});

test("ROUTE HIT: a changed route string flags the referencing skill", () => {
  const { index } = buildSkillIndex(SKILLS);
  const diffIds = extractIdentifiers("moved /api/agents/passthrough to /api/agents/bridge");
  const findings = intersect(diffIds, index);
  const hit = findings.find((f) => f.identifier === "/api/agents/passthrough");
  assert.ok(hit);
  assert.deepEqual(hit.skills, ["skill-a/SKILL.md"]);
});

// --- Pure: ack parsing -------------------------------------------------------

test("parseAcks reads Skills-reviewed and Skills-unaffected trailers", () => {
  assert.deepEqual(parseAcks("body\n\nSkills-reviewed: checked chat-agent-dispatch"), {
    reviewed: "checked chat-agent-dispatch", unaffected: null,
  });
  assert.deepEqual(parseAcks("Skills-unaffected: rename is internal-only, no skill ref"), {
    reviewed: null, unaffected: "rename is internal-only, no skill ref",
  });
  assert.deepEqual(parseAcks("nothing here"), { reviewed: null, unaffected: null });
});

// --- CLI: end-to-end through a real git diff, warn mode ----------------------

test("CLI warn mode: a real primitive-RENAME diff WARNS but exits 0 (catches removed-side identifier)", () => {
  // The old primitive `agent_run_get` (referenced by skill-a) is removed and a
  // new name added. The skill still references the OLD name, so the drift signal
  // lives on the REMOVED line — the gate must scan removed lines, not just added.
  const dir = repoWithDiff(
    "export function old() { return agent_run_get; }\n",
    "export function neo() { return agent_run_status; }\n",
  );
  try {
    const res = runGate(dir, ["--diff-base", "main", "--mode", "warn"]);
    assert.equal(res.status, 0, `warn mode must be non-failing; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.mode, "warn");
    assert.ok(out.findingCount >= 1, "should flag the removed/changed primitive surface");
    assert.ok(out.findings.some((f) => f.identifier === "agent_run_get"),
      "the renamed-away primitive (removed side) must be flagged");
  } finally { rm(dir); }
});

test("CLI: a prose-only diff stays quiet (clean, exit 0)", () => {
  const dir = repoWithDiff(
    "// initial note\n",
    "// please run the campaign and follow up with the recipient list\n",
  );
  try {
    const res = runGate(dir, ["--diff-base", "main", "--mode", "warn"]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.findingCount, 0, `clean PRs must stay quiet; got ${JSON.stringify(out.findings)}`);
  } finally { rm(dir); }
});

test("CLI enforce mode: an unacknowledged finding FAILS (exit 1); an ack clears it", () => {
  const dir = repoWithDiff(
    "old agent_run_get path\n",
    "new agent_run_get touched here\n",
  );
  try {
    // No diff at all would be empty; force a touch that re-adds the primitive.
    fs.writeFileSync(path.join(dir, "src.ts"), "agent_run_get and @cinatra-ai/lint-policy-agent\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "touch surfaces");

    const fail = runGate(dir, ["--diff-base", "main", "--mode", "enforce"]);
    assert.equal(fail.status, 1, "enforce mode must gate an unacknowledged finding");

    const ack = path.join(dir, "ack.txt");
    fs.writeFileSync(ack, "Skills-unaffected: identifiers only moved, dependent skills unchanged\n");
    const pass = runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack]);
    assert.equal(pass.status, 0, "a recorded ack clears the enforce gate");
    const out = JSON.parse(pass.stdout);
    assert.equal(out.acknowledgements.unaffected, "identifiers only moved, dependent skills unchanged");
  } finally { rm(dir); }
});

test("CLI: a pure route-FILE rename (string only in the path) is flagged", () => {
  // skill-a references /api/agents/passthrough. Rename the route FILE without
  // touching its contents — the route string lives only in the path. The gate
  // derives the route from the renamed-from path and flags the skill.
  const dir = tmpDir();
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    fs.mkdirSync(path.join(dir, "app/api/agents/passthrough"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app/api/agents/passthrough/route.ts"), "export const GET = () => 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base route");
    git(dir, "checkout", "-q", "-b", "feature");
    fs.mkdirSync(path.join(dir, "app/api/agents/bridge"), { recursive: true });
    git(dir, "mv", "app/api/agents/passthrough/route.ts", "app/api/agents/bridge/route.ts");
    git(dir, "commit", "-q", "-m", "rename route dir");

    const res = runGate(dir, ["--diff-base", "main", "--mode", "warn"]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.ok(
      out.findings.some((f) => f.identifier === "/api/agents/passthrough"),
      `renamed-away route should be flagged; got ${JSON.stringify(out.findings)}`,
    );
  } finally { rm(dir); }
});

test("CLI fails loud (exit 2) when the diff base does not resolve (never silent clean)", () => {
  const dir = repoWithDiff("agent_run_get a\n", "agent_run_get b\n");
  try {
    // A base that does not exist must NOT be reported as a clean PR.
    const res = runGate(dir, ["--diff-base", "does-not-exist-ref", "--mode", "warn"]);
    assert.equal(res.status, 2, `unresolvable base must fail loud; stderr: ${res.stderr}`);
  } finally { rm(dir); }
});

// --- CLI: fail-loud on a bad pin --------------------------------------------

test("CLI fails loud (exit 2) when --skills-dir is missing", () => {
  const res = spawnSync("node", [GATE, "--skills-dir", path.join(os.tmpdir(), "sdg-nope"), "--format", "json"], { encoding: "utf8" });
  assert.equal(res.status, 2);
});

test("CLI fails loud (exit 2) when --skills-dir has no SKILL.md", () => {
  const dir = tmpDir();
  try {
    const res = spawnSync("node", [GATE, "--skills-dir", dir, "--format", "json"], { encoding: "utf8" });
    assert.equal(res.status, 2);
  } finally { rm(dir); }
});

test("CLI fails loud (exit 2) on unknown flags / bad values", () => {
  assert.equal(spawnSync("node", [GATE, "--skills-dir", SKILLS, "--mode", "loud"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [GATE, "--skills-dir", SKILLS, "--format", "yaml"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [GATE, "--skills-dir", SKILLS, "--bogus", "x"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [GATE, "--skills-dir"], { encoding: "utf8" }).status, 2);
});
