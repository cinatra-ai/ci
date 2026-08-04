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
  parseWatches,
  extractFrontmatter,
  hasDeclaredWatches,
  globToRegExp,
  matchPathGlobs,
  buildWatchIndex,
  intersectWatches,
  findingSatisfied,
  skillSlug,
  validateWatchSurface,
  WatchParseError,
  parseSkillsRepos,
  resolveSkillsRepos,
  isSkillsPRRef,
} from "../skills-drift-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "skills-drift-gate.mjs");
const FIX = path.join(import.meta.dirname, "..", "__fixtures__");
const SKILLS = path.join(FIX, "skills-drift");

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

function runGate(cwd, extraArgs, extraEnv = {}) {
  return spawnSync("node", [GATE, "--skills-dir", SKILLS, "--format", "json", ...extraArgs], {
    cwd,
    encoding: "utf8",
    // The skills-repo env inputs are cleared unless a test sets them, so an
    // ambient value in the developer's shell can never make a test pass.
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      SKILLS_DRIFT_PINNED_REF: "",
      SKILLS_DRIFT_SKILLS_REPOS: "",
      ...extraEnv,
    },
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

test("extractIdentifiers: a snake_case ROUTE segment does not leak as a phantom primitive (codex r4 MED)", () => {
  // `/api/agents/agent_run` is a route — its `agent_run` segment must NOT also be
  // extracted as a primitive, else a route-only change would falsely match a
  // `primitives: [agent_run]` watch.
  const { routes, primitives } = extractIdentifiers("hit /api/agents/agent_run for the bridge");
  assert.ok(routes.has("/api/agents/agent_run"));
  assert.ok(!primitives.has("agent_run"), "a route segment must not leak as a primitive");
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

// The heuristic index must EXCLUDE declared skills (skill-watched) so the
// verbatim heuristic only covers undeclared skills (v2 watches-first contract).
function heuristicIndex(dir = SKILLS) {
  const { declaredSkills } = buildWatchIndex(dir);
  return buildSkillIndex(dir, { declaredSkills });
}

test("buildSkillIndex indexes every UNDECLARED fixture SKILL.md (declared skills excluded)", () => {
  const { declaredSkills } = buildWatchIndex(SKILLS);
  // skill-watched declares a cinatra-watches block; the other three do not.
  assert.deepEqual([...declaredSkills].sort(), ["skill-watched/SKILL.md"]);
  const { files, index } = heuristicIndex();
  assert.equal(files.length, listSkillFiles(SKILLS).length);
  assert.equal(files.length, 4, "four fixture skills on disk");
  assert.ok(index.primitives.has("agent_run"));
  assert.ok(index.packages.has("@cinatra-ai/email-outreach-agent"));
  assert.ok(index.routes.has("/api/agents/passthrough"));
  // skill-watched's prose mentions agent_run_get, but it is DECLARED so it is not
  // in the heuristic index under skill-watched (only skill-a references it).
  assert.deepEqual([...index.primitives.get("agent_run_get")], ["skill-a/SKILL.md"]);
});

test("TRUE HIT: a changed primitive flags the skill(s) that reference it", () => {
  const { index } = heuristicIndex();
  const diffIds = extractIdentifiers("renamed agent_run_get to agent_run_status");
  const findings = intersect(diffIds, index);
  const hit = findings.find((f) => f.identifier === "agent_run_get");
  assert.ok(hit, "agent_run_get should be flagged");
  assert.deepEqual(hit.skills, ["skill-a/SKILL.md"]);
  assert.equal(hit.source, "heuristic");
});

test("MULTI-SKILL HIT: an identifier referenced by two skills surfaces both", () => {
  const { index } = heuristicIndex();
  // agent_run is referenced by skill-a and skill-b; @cinatra-ai/email-outreach-agent too.
  const diffIds = extractIdentifiers("touch agent_run and @cinatra-ai/email-outreach-agent");
  const findings = intersect(diffIds, index);
  const prim = findings.find((f) => f.identifier === "agent_run");
  assert.deepEqual(prim.skills, ["skill-a/SKILL.md", "skill-b/SKILL.md"]);
  const pkg = findings.find((f) => f.identifier === "@cinatra-ai/email-outreach-agent");
  assert.deepEqual(pkg.skills, ["skill-a/SKILL.md", "skill-b/SKILL.md"]);
});

test("PROSE FALSE-POSITIVE GUARD: prose-only change flags nothing", () => {
  const { index } = heuristicIndex();
  // Mirrors skill-prose wording — should not intersect any indexed identifier.
  const diffIds = extractIdentifiers(
    "When you run the campaign, double check the recipient list and confirm before you proceed.",
  );
  const findings = intersect(diffIds, index);
  assert.equal(findings.length, 0);
});

test("ROUTE HIT: a changed route string flags the referencing skill", () => {
  const { index } = heuristicIndex();
  const diffIds = extractIdentifiers("moved /api/agents/passthrough to /api/agents/bridge");
  const findings = intersect(diffIds, index);
  const hit = findings.find((f) => f.identifier === "/api/agents/passthrough");
  assert.ok(hit);
  assert.deepEqual(hit.skills, ["skill-a/SKILL.md"]);
});

// --- Pure: ack parsing -------------------------------------------------------

test("parseAcks reads Skills-reviewed and Skills-unaffected trailers", () => {
  assert.deepEqual(parseAcks("body\n\nSkills-reviewed: checked chat-agent-dispatch"), {
    reviewed: "checked chat-agent-dispatch", unaffected: null, linkedPRs: [], rejectedRefs: [],
  });
  assert.deepEqual(parseAcks("Skills-unaffected: rename is internal-only, no skill ref"), {
    reviewed: null, unaffected: "rename is internal-only, no skill ref", linkedPRs: [], rejectedRefs: [],
  });
  assert.deepEqual(parseAcks("nothing here"), { reviewed: null, unaffected: null, linkedPRs: [], rejectedRefs: [] });
});

test("parseAcks: a bare Skills-unaffected with no reason does NOT count (issue: not '...:' only)", () => {
  assert.deepEqual(parseAcks("Skills-unaffected:   "), { reviewed: null, unaffected: null, linkedPRs: [], rejectedRefs: [] });
  assert.deepEqual(parseAcks("Skills-unaffected:"), { reviewed: null, unaffected: null, linkedPRs: [], rejectedRefs: [] });
});

test("parseAcks: an ack value must be on the SAME line — it does not swallow the next line (codex r3 MED)", () => {
  // `Skills-unaffected:` followed by a newline must NOT pull the next line in as
  // the reason (a `\s*` regex bug would). The reason must be empty => not counted.
  assert.equal(parseAcks("Skills-unaffected:\nThis is the next paragraph.").unaffected, null);
  assert.equal(parseAcks("Skills-reviewed:\nnext line").reviewed, null);
  // A same-line reason still works.
  assert.equal(parseAcks("Skills-unaffected: internal rename\nmore text").unaffected, "internal rename");
});

test("parseAcks: Skills-PR parses ref + covers list of skill slugs", () => {
  const a = parseAcks("Skills-PR: https://github.com/cinatra-ai/assistant-skills/pull/7 covers: chat-agent-dispatch, chat-run-polling");
  assert.equal(a.linkedPRs.length, 1);
  assert.equal(a.linkedPRs[0].ref, "https://github.com/cinatra-ai/assistant-skills/pull/7");
  assert.deepEqual([...a.linkedPRs[0].covers].sort(), ["chat-agent-dispatch", "chat-run-polling"]);
});

test("parseAcks: a Skills-PR with no covers list covers nothing", () => {
  const a = parseAcks("Skills-PR: #7");
  assert.equal(a.linkedPRs.length, 1);
  assert.equal(a.linkedPRs[0].covers.size, 0);
});

test("parseAcks: a Skills-PR ref that is not a real PR reference is DROPPED (no spoofing)", () => {
  // Arbitrary text must not satisfy a finding (codex LOW).
  assert.equal(parseAcks("Skills-PR: nonsense covers: skill-watched").linkedPRs.length, 0);
  assert.equal(parseAcks("Skills-PR: see the other repo covers: skill-watched").linkedPRs.length, 0);
  // Real references are accepted: #n, bare n, GH-n, and an assistant-skills URL.
  assert.equal(parseAcks("Skills-PR: #12 covers: x").linkedPRs.length, 1);
  assert.equal(parseAcks("Skills-PR: 12 covers: x").linkedPRs.length, 1);
  assert.equal(parseAcks("Skills-PR: GH-12 covers: x").linkedPRs.length, 1);
  assert.equal(parseAcks("Skills-PR: https://github.com/cinatra-ai/assistant-skills/pull/12 covers: x").linkedPRs.length, 1);
  // A PR URL for a DIFFERENT repo is not a pinned skills-repo PR — dropped.
  assert.equal(parseAcks("Skills-PR: https://github.com/cinatra-ai/cinatra/pull/12 covers: x").linkedPRs.length, 0);
});

// --- Pure: Skills-PR ref grammar over the caller-pinned skills-repo set ------
//
// The pinned set below mirrors the shape a real multi-repo caller passes: the
// successor skill repos that replaced the single retired pack, each entry
// `owner/name@<sha>` exactly as pinned in the caller's required-extensions lock.
const PINNED_SPEC = [
  "cinatra-ai/chat-assistant-core-skill@2cb491e1e3ccf7fe946b253254f2e7a4d509bc55",
  "cinatra-ai/extension-authoring-skill@01c040e6453a08f8de128bc40b7b9047793fde1a",
  "cinatra-ai/automation-authoring-skill@596afabf6a10b8f1f297521fcb7d1f78fb70213b",
  "cinatra-ai/company-research-skill@639fdc073b7d600a8436900843bfd3ac42778743",
  "cinatra-ai/blog-content-skill@163f73c05b441b61799a2db203f8ce873ec8aae7",
  "cinatra-ai/hitl-prompt-drive-skill@81edce91254e677d7e68269503f3cf22fe7c9a2d",
].join("\n");
const PINNED = parseSkillsRepos(PINNED_SPEC);

test("parseSkillsRepos: parses the caller pin spec in every separator form; ignores junk", () => {
  // Newline-separated `owner/name@sha` (the multi-repo caller's literal block).
  assert.deepEqual([...PINNED].sort(), [
    "cinatra-ai/automation-authoring-skill",
    "cinatra-ai/blog-content-skill",
    "cinatra-ai/chat-assistant-core-skill",
    "cinatra-ai/company-research-skill",
    "cinatra-ai/extension-authoring-skill",
    "cinatra-ai/hitl-prompt-drive-skill",
  ]);
  // Comma- and space-separated, and the bare `owner/name` (single-repo) form.
  assert.deepEqual([...parseSkillsRepos("a/one-skill@abc,b/two-skill@def")].sort(), ["a/one-skill", "b/two-skill"]);
  assert.deepEqual([...parseSkillsRepos("a/one-skill  b/two-skill")].sort(), ["a/one-skill", "b/two-skill"]);
  assert.deepEqual([...parseSkillsRepos("cinatra-ai/assistant-skills")], ["cinatra-ai/assistant-skills"]);
  // Case is normalized so the URL comparison is case-insensitive like GitHub.
  assert.deepEqual([...parseSkillsRepos("Cinatra-AI/Chat-Assistant-Core-Skill@AB")], ["cinatra-ai/chat-assistant-core-skill"]);
  // Empty / junk inputs register NO repo — they can only narrow the grammar.
  assert.equal(parseSkillsRepos("").size, 0);
  assert.equal(parseSkillsRepos(undefined).size, 0);
  assert.equal(parseSkillsRepos(null).size, 0);
  assert.equal(parseSkillsRepos("not-a-repo").size, 0);
  assert.equal(parseSkillsRepos("too/many/segments@sha").size, 0);
  assert.equal(parseSkillsRepos("/leading-slash@sha").size, 0);
  assert.equal(parseSkillsRepos("owner/@sha").size, 0);
  assert.equal(parseSkillsRepos("0123456789abcdef0123456789abcdef01234567").size, 0, "a bare SHA is not a repo");
});

test("resolveSkillsRepos: explicit caller pins win; the pinned-ref display value is the fallback", () => {
  // (1) explicit `--skills-repos` / SKILLS_DRIFT_SKILLS_REPOS.
  assert.deepEqual([...resolveSkillsRepos({ explicit: "a/one-skill@abc" })], ["a/one-skill"]);
  // (2) fallback: multi-repo mode already publishes the pinned set as the display
  // ref, so an older caller workflow that does not pass (1) still resolves.
  assert.deepEqual([...resolveSkillsRepos({ pinnedRef: "a/one-skill@abc b/two-skill@def" })].sort(),
    ["a/one-skill", "b/two-skill"]);
  // explicit takes precedence over the fallback.
  assert.deepEqual([...resolveSkillsRepos({ explicit: "a/one-skill@abc", pinnedRef: "b/two-skill@def" })],
    ["a/one-skill"]);
  // Single-repo mode publishes a BARE SHA as the display ref => no repo, legacy only.
  assert.equal(resolveSkillsRepos({ pinnedRef: "0123456789abcdef0123456789abcdef01234567" }).size, 0);
  // Nothing at all => empty (fail-closed to the legacy arm).
  assert.equal(resolveSkillsRepos().size, 0);
  assert.equal(resolveSkillsRepos({}).size, 0);
});

test("isSkillsPRRef: EVERY legacy-accepted form is still accepted, with or without a pinned set", () => {
  for (const repos of [undefined, new Set(), PINNED]) {
    // Repo-relative numbers.
    assert.equal(isSkillsPRRef("#12", repos), true);
    assert.equal(isSkillsPRRef("12", repos), true);
    assert.equal(isSkillsPRRef("GH-12", repos), true);
    assert.equal(isSkillsPRRef("gh-12", repos), true);
    // The retired single pack's pull URL — ANY owner, http or https, as before.
    assert.equal(isSkillsPRRef("https://github.com/cinatra-ai/assistant-skills/pull/12", repos), true);
    assert.equal(isSkillsPRRef("http://github.com/cinatra-ai/assistant-skills/pull/12", repos), true);
    assert.equal(isSkillsPRRef("https://github.com/someone-else/assistant-skills/pull/1", repos), true);
    assert.equal(isSkillsPRRef("HTTPS://GitHub.com/Cinatra-AI/Assistant-Skills/PULL/12", repos), true);
    // …and every legacy REJECTION still rejects.
    assert.equal(isSkillsPRRef("nonsense", repos), false);
    assert.equal(isSkillsPRRef("see the other repo", repos), false);
    assert.equal(isSkillsPRRef("", repos), false);
    assert.equal(isSkillsPRRef("https://github.com/cinatra-ai/cinatra/pull/12", repos), false);
  }
});

test("isSkillsPRRef: a pull URL on EACH caller-pinned successor repo is accepted", () => {
  for (const repo of PINNED) {
    assert.equal(isSkillsPRRef(`https://github.com/${repo}/pull/5`, PINNED), true, repo);
    assert.equal(isSkillsPRRef(`http://github.com/${repo}/pull/5`, PINNED), true, repo);
    // Case-insensitive, like GitHub itself.
    assert.equal(isSkillsPRRef(`https://GITHUB.com/${repo.toUpperCase()}/pull/5`, PINNED), true, repo);
    // …and the SAME URL is rejected when that repo is not pinned (fail-closed:
    // the grammar follows the caller's pins, it is not a standing allowance).
    assert.equal(isSkillsPRRef(`https://github.com/${repo}/pull/5`, undefined), false, repo);
    assert.equal(isSkillsPRRef(`https://github.com/${repo}/pull/5`, new Set()), false, repo);
  }
});

test("isSkillsPRRef: lookalike and foreign URLs are REJECTED even with a pinned set", () => {
  const bad = [
    // A different repo in the same org (the classic laundering attempt).
    "https://github.com/cinatra-ai/cinatra/pull/12",
    // Repo-name lookalikes around a pinned entry.
    "https://github.com/cinatra-ai/chat-assistant-core-skill-evil/pull/1",
    "https://github.com/cinatra-ai/evil-chat-assistant-core-skill/pull/1",
    // Right repo name, WRONG owner.
    "https://github.com/evil-ai/chat-assistant-core-skill/pull/1",
    // Host lookalikes (the anchor + literal host must hold).
    "https://github.com.evil.example/cinatra-ai/chat-assistant-core-skill/pull/1",
    "https://evil.example/cinatra-ai/chat-assistant-core-skill/pull/1",
    "https://raw.github.com/cinatra-ai/chat-assistant-core-skill/pull/1",
    "https://github.evil.example/cinatra-ai/chat-assistant-core-skill/pull/1",
    // Not a PULL url, or a decorated pull url.
    "https://github.com/cinatra-ai/chat-assistant-core-skill/issues/1",
    "https://github.com/cinatra-ai/chat-assistant-core-skill/pulls/1",
    "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/1/files",
    "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/abc",
    "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/",
    // Prose wrapped around a valid URL is not a bare ref.
    "see https://github.com/cinatra-ai/chat-assistant-core-skill/pull/1",
    // A pinned entry is a REPO, not a licence to name any URL on that org.
    "https://github.com/cinatra-ai/pull/1",
  ];
  for (const ref of bad) assert.equal(isSkillsPRRef(ref, PINNED), false, ref);
});

test("isSkillsPRRef: a UNICODE case-fold lookalike cannot impersonate a repo (codex HIGH)", () => {
  // U+212A KELVIN SIGN lowercases to ASCII "k", so a naive fold-and-compare
  // would accept a repo name GitHub itself cannot resolve. Both the pinned arm
  // and the legacy arm must reject it. U+017F LATIN SMALL LETTER LONG S folds to
  // "s" the same way.
  const KELVIN = "K";
  const LONG_S = "ſ";
  const foldLookalikes = [
    `https://github.com/cinatra-ai/chat-assistant-core-s${KELVIN}ill/pull/1`,
    `https://github.com/cinatra-ai/chat-a${LONG_S}sistant-core-skill/pull/1`,
    `https://github.com/cinatra-ai/assistant-s${KELVIN}ills/pull/1`,
    `https://github.com/someone-else/assistant-s${KELVIN}ills/pull/1`,
  ];
  for (const ref of foldLookalikes) {
    assert.equal(isSkillsPRRef(ref, PINNED), false, ref);
    assert.equal(isSkillsPRRef(ref, undefined), false, ref);
  }
  // …and an owner-side fold is rejected too.
  assert.equal(isSkillsPRRef(`https://github.com/cinatra-ai/blog-content-s${KELVIN}ill/pull/1`, PINNED), false);
});

test("parseAcks: a successor-repo pull URL validates against the pinned set (the reported failure)", () => {
  const line = "Skills-PR: https://github.com/cinatra-ai/chat-assistant-core-skill/pull/5 covers: chat-assistant-core";
  // Without the pinned set the ref is dropped — the pre-fix behaviour.
  const without = parseAcks(line);
  assert.equal(without.linkedPRs.length, 0);
  assert.deepEqual(without.rejectedRefs, ["https://github.com/cinatra-ai/chat-assistant-core-skill/pull/5"]);
  // With it, the ack parses and carries its covers list.
  const withSet = parseAcks(line, { skillsRepos: PINNED });
  assert.equal(withSet.linkedPRs.length, 1);
  assert.equal(withSet.linkedPRs[0].ref, "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/5");
  assert.deepEqual([...withSet.linkedPRs[0].covers], ["chat-assistant-core"]);
  assert.deepEqual(withSet.rejectedRefs, []);
  // A foreign URL stays rejected even WITH the pinned set (anti-laundering).
  const foreign = parseAcks("Skills-PR: https://github.com/cinatra-ai/cinatra/pull/12 covers: chat-assistant-core", { skillsRepos: PINNED });
  assert.equal(foreign.linkedPRs.length, 0);
  assert.deepEqual(foreign.rejectedRefs, ["https://github.com/cinatra-ai/cinatra/pull/12"]);
});

test("findingSatisfied: a successor-repo Skills-PR clears a covered finding; a foreign one never does", () => {
  const f = { class: "primitive", identifier: "workflow_draft_create", skills: ["skill-watched/SKILL.md"], source: "watch" };
  const good = "Skills-PR: https://github.com/cinatra-ai/blog-content-skill/pull/5 covers: skill-watched";
  assert.equal(findingSatisfied(f, parseAcks(good, { skillsRepos: PINNED })), true);
  assert.equal(findingSatisfied(f, parseAcks(good)), false, "unpinned => the ref is not accepted");
  const foreign = "Skills-PR: https://github.com/cinatra-ai/cinatra/pull/5 covers: skill-watched";
  assert.equal(findingSatisfied(f, parseAcks(foreign, { skillsRepos: PINNED })), false);
});

test("skillSlug normalizes a relpath or a slug to the directory slug", () => {
  assert.equal(skillSlug("chat-agent-dispatch/SKILL.md"), "chat-agent-dispatch");
  assert.equal(skillSlug("chat-agent-dispatch"), "chat-agent-dispatch");
  assert.equal(skillSlug("./nested/skill-x/SKILL.md"), "skill-x");
});

test("findingSatisfied: Skills-reviewed / Skills-unaffected cover all skills; Skills-PR is per-skill", () => {
  const f = { class: "primitive", identifier: "workflow_draft_create", skills: ["skill-watched/SKILL.md"], source: "watch" };
  assert.equal(findingSatisfied(f, parseAcks("")), false);
  assert.equal(findingSatisfied(f, parseAcks("Skills-reviewed: checked")), true);
  assert.equal(findingSatisfied(f, parseAcks("Skills-unaffected: internal rename")), true);
  // Skills-PR must NAME the impacted skill.
  assert.equal(findingSatisfied(f, parseAcks("Skills-PR: #7 covers: some-other-skill")), false);
  assert.equal(findingSatisfied(f, parseAcks("Skills-PR: #7 covers: skill-watched")), true);
  // A multi-skill finding needs ALL its skills covered by the linked PR.
  const multi = { class: "primitive", identifier: "agent_run", skills: ["skill-a/SKILL.md", "skill-b/SKILL.md"], source: "watch" };
  assert.equal(findingSatisfied(multi, parseAcks("Skills-PR: #7 covers: skill-a")), false);
  assert.equal(findingSatisfied(multi, parseAcks("Skills-PR: #7 covers: skill-a, skill-b")), true);
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

test("CLI enforce mode: an unacknowledged DECLARED-WATCH finding FAILS (exit 1); an ack clears it", () => {
  // workflow_draft_create is a DECLARED watch of skill-watched — a watch finding,
  // which is what gates enforce. (A heuristic-only finding never gates; see below.)
  const dir = repoWithDiff(
    "// initial\n",
    "renamed workflow_draft_create here\n",
  );
  try {
    const fail = runGate(dir, ["--diff-base", "main", "--mode", "enforce"]);
    assert.equal(fail.status, 1, "enforce must gate an unacknowledged declared-watch finding");
    const failOut = JSON.parse(fail.stdout);
    assert.ok(failOut.watchFindings.some((f) => f.identifier === "workflow_draft_create" && !f.satisfied));

    // (c) Skills-unaffected with a reason clears it.
    const ack = path.join(dir, "ack.txt");
    fs.writeFileSync(ack, "Skills-unaffected: identifier only moved, skill-watched semantics unchanged\n");
    const pass = runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack]);
    assert.equal(pass.status, 0, "a recorded ack clears the enforce gate");
    const out = JSON.parse(pass.stdout);
    assert.equal(out.acknowledgements.unaffected, "identifier only moved, skill-watched semantics unchanged");
    assert.equal(out.unacknowledgedWatchFindingCount, 0);
  } finally { rm(dir); }
});

test("CLI enforce mode: a HEURISTIC-only finding is ADVISORY — never gates (exit 0)", () => {
  // agent_run_get is referenced by skill-a (UNDECLARED => heuristic). Even in
  // enforce mode a heuristic finding must not fail the gate (issue: graduate to
  // declared watches FOR enforcement).
  const dir = repoWithDiff(
    "// initial\n",
    "renamed agent_run_get here\n",
  );
  try {
    const res = runGate(dir, ["--diff-base", "main", "--mode", "enforce"]);
    assert.equal(res.status, 0, `heuristic-only findings must not gate enforce; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.ok(out.heuristicFindings.some((f) => f.identifier === "agent_run_get"));
    assert.equal(out.watchFindingCount, 0);
    assert.equal(out.unacknowledgedWatchFindingCount, 0);
  } finally { rm(dir); }
});

test("CLI enforce mode: a linked Skills-PR that covers the impacted skill clears the watch finding", () => {
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  try {
    const fail = runGate(dir, ["--diff-base", "main", "--mode", "enforce"]);
    assert.equal(fail.status, 1);
    const ack = path.join(dir, "ack.txt");
    // A linked PR that names the wrong skill must NOT clear it.
    fs.writeFileSync(ack, "Skills-PR: https://github.com/cinatra-ai/assistant-skills/pull/9 covers: skill-a\n");
    assert.equal(runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack]).status, 1,
      "a Skills-PR naming the wrong skill must not satisfy the finding");
    // A linked PR that names skill-watched clears it.
    fs.writeFileSync(ack, "Skills-PR: https://github.com/cinatra-ai/assistant-skills/pull/9 covers: skill-watched\n");
    assert.equal(runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack]).status, 0,
      "a Skills-PR naming the impacted skill clears the finding");
  } finally { rm(dir); }
});

test("CLI enforce mode: a successor-repo Skills-PR URL clears the finding once the caller pins that repo", () => {
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  const ack = path.join(dir, "ack.txt");
  const url = "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/5";
  try {
    fs.writeFileSync(ack, `Skills-PR: ${url} covers: skill-watched\n`);
    const base = ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack];

    // (0) No pinned set anywhere: the URL is not a recognized ref — the finding
    // stays open AND the rejection is reported (not silently "no linked PR").
    const unpinned = runGate(dir, base);
    assert.equal(unpinned.status, 1, "an unrecognized ref must leave the finding unacknowledged");
    const unpinnedOut = JSON.parse(unpinned.stdout);
    assert.deepEqual(unpinnedOut.skillsRepos, []);
    assert.deepEqual(unpinnedOut.acknowledgements.rejectedRefs, [url]);

    // (1) --skills-repos (what the reusable workflow passes) clears it.
    const viaFlag = runGate(dir, [...base, "--skills-repos", PINNED_SPEC]);
    assert.equal(viaFlag.status, 0, `pinned successor-repo URL must clear the gate; stderr: ${viaFlag.stderr}`);
    const flagOut = JSON.parse(viaFlag.stdout);
    assert.equal(flagOut.unacknowledgedWatchFindingCount, 0);
    assert.equal(flagOut.acknowledgements.linkedPRs.length, 1);
    assert.deepEqual(flagOut.acknowledgements.rejectedRefs, []);
    assert.ok(flagOut.skillsRepos.includes("cinatra-ai/chat-assistant-core-skill"),
      "the effective ack grammar must be reported");

    // (2) the env form resolves identically.
    assert.equal(runGate(dir, base, { SKILLS_DRIFT_SKILLS_REPOS: PINNED_SPEC }).status, 0);

    // (3) fallback: multi-repo mode already publishes the pinned set as the
    // display ref, so an older caller workflow resolves without (1)/(2).
    assert.equal(runGate(dir, base, { SKILLS_DRIFT_PINNED_REF: PINNED_SPEC.replace(/\n/g, " ") }).status, 0);

    // (4) a bare-SHA display ref (single-repo mode) grants nothing.
    assert.equal(runGate(dir, base, { SKILLS_DRIFT_PINNED_REF: "0123456789abcdef0123456789abcdef01234567" }).status, 1);
  } finally { rm(dir); }
});

test("CLI enforce mode: an ARBITRARY repo's PR URL never clears the finding, even with pins", () => {
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  const ack = path.join(dir, "ack.txt");
  try {
    for (const url of [
      "https://github.com/cinatra-ai/cinatra/pull/2319",
      "https://github.com/evil-ai/chat-assistant-core-skill/pull/1",
      "https://github.com/cinatra-ai/chat-assistant-core-skill-evil/pull/1",
      "https://evil.example/cinatra-ai/chat-assistant-core-skill/pull/1",
      "https://github.com/cinatra-ai/chat-assistant-core-skill/pull/1/files",
    ]) {
      fs.writeFileSync(ack, `Skills-PR: ${url} covers: skill-watched\n`);
      const res = runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack, "--skills-repos", PINNED_SPEC]);
      assert.equal(res.status, 1, `a foreign PR URL must not launder the finding clear: ${url}`);
      assert.deepEqual(JSON.parse(res.stdout).acknowledgements.rejectedRefs, [url]);
    }
  } finally { rm(dir); }
});

test("CLI: --skills-repos never widens the OTHER ack forms, and junk pins grant nothing", () => {
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  const ack = path.join(dir, "ack.txt");
  try {
    // Prose is still not a ref, whatever is pinned.
    fs.writeFileSync(ack, "Skills-PR: the successor repo covers: skill-watched\n");
    assert.equal(runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack, "--skills-repos", PINNED_SPEC]).status, 1);
    // An unparseable pin spec registers no repo => the URL arm stays legacy-only.
    fs.writeFileSync(ack, "Skills-PR: https://github.com/cinatra-ai/chat-assistant-core-skill/pull/5 covers: skill-watched\n");
    const junk = runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack, "--skills-repos", "not-a-repo ///"]);
    assert.equal(junk.status, 1, "a junk pin spec must not widen the grammar");
    assert.deepEqual(JSON.parse(junk.stdout).skillsRepos, []);
    // …while the legacy assistant-skills URL still clears it with pins present.
    fs.writeFileSync(ack, "Skills-PR: https://github.com/cinatra-ai/assistant-skills/pull/9 covers: skill-watched\n");
    assert.equal(runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack, "--skills-repos", PINNED_SPEC]).status, 0);
  } finally { rm(dir); }
});

test("CLI: a rejected Skills-PR ref is REPORTED, but neutralized and bounded in the step summary", () => {
  // The rejected ref is arbitrary PR-author text, and it is newly echoed into a
  // Markdown step summary — so the code-span delimiter must not survive, each
  // ref is length-bounded, and the list is capped (codex LOW).
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  const ack = path.join(dir, "ack.txt");
  const summaryFile = path.join(dir, "summary.md");
  try {
    const crafted = "`](https://evil.example) **spoofed**" + "x".repeat(300);
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push(`Skills-PR: ${crafted}${i} covers: skill-watched`);
    fs.writeFileSync(ack, lines.join("\n") + "\n");
    const res = spawnSync("node", [GATE, "--skills-dir", SKILLS, "--diff-base", "main", "--mode", "enforce", "--ack-file", ack], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "",
        SKILLS_DRIFT_PINNED_REF: "",
        SKILLS_DRIFT_SKILLS_REPOS: "",
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    assert.equal(res.status, 1, "a rejected ack must never clear the finding");
    const reported = fs.readFileSync(summaryFile, "utf8").split("\n").filter((l) => l.startsWith("REJECTED"));
    assert.equal(reported.length, 10, "the rejected list is capped");
    for (const line of reported) {
      assert.ok(!line.includes("`]("), `the code-span delimiter must be neutralized: ${line}`);
      assert.ok(line.length <= 240, `each reported ref must be length-bounded: ${line.length}`);
    }
  } finally { rm(dir); }
});

test("CLI enforce mode: a BARE Skills-unaffected (no reason) does NOT clear the gate", () => {
  const dir = repoWithDiff("// initial\n", "moved workflow_draft_create\n");
  try {
    const ack = path.join(dir, "ack.txt");
    fs.writeFileSync(ack, "Skills-unaffected:\n");
    assert.equal(runGate(dir, ["--diff-base", "main", "--mode", "enforce", "--ack-file", ack]).status, 1,
      "a reasonless Skills-unaffected must not clear enforce (issue: not '...:' only)");
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

test("CLI: --format json stays valid JSON even under GITHUB_ACTIONS=true with findings (codex r4 MED)", () => {
  // Annotations write `::warning::` lines to stdout; in JSON mode that would
  // corrupt the machine-readable stream. JSON output must remain parseable.
  const dir = repoWithDiff("// initial\n", "renamed workflow_draft_create here\n");
  try {
    const res = spawnSync("node", [GATE, "--skills-dir", SKILLS, "--format", "json", "--diff-base", "main", "--mode", "enforce"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" },
    });
    // enforce + unacknowledged watch finding => exit 1, but stdout must be pure JSON.
    assert.equal(res.status, 1);
    assert.doesNotThrow(() => JSON.parse(res.stdout), `stdout must be valid JSON, got: ${res.stdout.slice(0, 200)}`);
    assert.ok(!res.stdout.includes("::"), "no ::annotation:: lines may pollute the JSON stdout stream");
    const out = JSON.parse(res.stdout);
    assert.ok(out.watchFindings.some((f) => f.identifier === "workflow_draft_create"));
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

// ===========================================================================
// v2 — skill-declared watches
// ===========================================================================

// --- Pure: frontmatter + watch parsing --------------------------------------

test("extractFrontmatter returns the block between the first two --- fences", () => {
  assert.equal(extractFrontmatter("---\nname: x\n---\nbody\n"), "name: x");
  assert.equal(extractFrontmatter("no frontmatter here"), null);
});

test("parseWatches: absent cinatra-watches => null (undeclared, heuristic fallback)", () => {
  assert.equal(parseWatches("---\nname: x\ndescription: y\n---\nbody"), null);
  assert.equal(parseWatches("no frontmatter"), null);
});

test("parseWatches: block + flow arrays parse to string lists", () => {
  const w = parseWatches([
    "---", "name: x",
    "cinatra-watches:",
    '  primitives: [agent_run, "agent_run_get"]',
    "  packages:",
    '    - "@cinatra-ai/trigger-agent"',
    "  routes: [/api/agents/passthrough]",
    "  paths:",
    "    - packages/agents/src/a2a-actions.ts",
    "---", "body",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run", "agent_run_get"]);
  assert.deepEqual(w.packages, ["@cinatra-ai/trigger-agent"]);
  assert.deepEqual(w.routes, ["/api/agents/passthrough"]);
  assert.deepEqual(w.paths, ["packages/agents/src/a2a-actions.ts"]);
  assert.ok(hasDeclaredWatches(w));
});

test("parseWatches FAIL-LOUD: a present-but-EMPTY watch key throws (no silent false-negative)", () => {
  // codex HIGH-1: an empty `paths: []` must NOT collapse a path-only watch to
  // "no watches" and fall back to the heuristic — it must fail loud.
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  primitives: []\n---\nbody"), WatchParseError);
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  paths:\n---\nbody"), WatchParseError);
});

test("parseWatches FAIL-LOUD: unknown key throws", () => {
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  pakages: [\"@cinatra-ai/typo\"]\n---\nb"), WatchParseError);
});

test("parseWatches FAIL-LOUD: a scalar where a list is expected throws", () => {
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  primitives: agent_run\n---\nb"), WatchParseError);
});

test("parseWatches FAIL-LOUD: a structured (nested-mapping) list item throws (codex HIGH-2)", () => {
  // `- glob: packages/foo/**` must not be swallowed as a literal string.
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  paths:\n    - glob: packages/foo/**\n---\nb"), WatchParseError);
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  primitives:\n    - [a, b]\n---\nb"), WatchParseError);
});

test("parseWatches FAIL-LOUD: a duplicate watch key throws", () => {
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\n  primitives: [a]\n  primitives: [b]\n---\nb"), WatchParseError);
});

test("parseWatches: a quoted item with a trailing comment reads the quoted value (codex MED-1)", () => {
  const w = parseWatches([
    "---", "name: x", "cinatra-watches:", "  primitives:",
    '    - "agent_run" # canonical dispatch primitive',
    "    - agent_run_get  # poll", "---", "b",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run", "agent_run_get"]);
});

test("parseWatches FAIL-LOUD: inline cinatra-watches value (not a mapping) throws", () => {
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches: agent_run\n---\nb"), WatchParseError);
});

test("parseWatches FAIL-LOUD: cinatra-watches with no recognized child keys throws", () => {
  assert.throws(() => parseWatches("---\nname: x\ncinatra-watches:\nname2: y\n---\nb"), WatchParseError);
});

// --- Dual-read: metadata.cinatra-watches (Skills cluster Wave-0) -------------

test("parseWatches DUAL-READ: metadata.cinatra-watches is read (preferred location)", () => {
  // The upstream-validator-compatible shape: the block lives under `metadata:`.
  const w = parseWatches([
    "---", "name: x",
    "metadata:",
    "  cinatra-watches:",
    "    primitives: [agent_run, \"agent_run_get\"]",
    "    packages:",
    '      - "@cinatra-ai/trigger-agent"',
    "    routes: [/api/agents/passthrough]",
    "    paths:",
    "      - packages/agents/src/a2a-actions.ts",
    "---", "body",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run", "agent_run_get"]);
  assert.deepEqual(w.packages, ["@cinatra-ai/trigger-agent"]);
  assert.deepEqual(w.routes, ["/api/agents/passthrough"]);
  assert.deepEqual(w.paths, ["packages/agents/src/a2a-actions.ts"]);
  assert.ok(hasDeclaredWatches(w));
});

test("parseWatches DUAL-READ: legacy top-level cinatra-watches still works (fallback)", () => {
  // Unchanged legacy behavior: no `metadata:` wrapper.
  const w = parseWatches([
    "---", "name: x",
    "cinatra-watches:",
    "  primitives: [agent_run]",
    "---", "body",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run"]);
  assert.ok(hasDeclaredWatches(w));
});

test("parseWatches DUAL-READ FAIL-LOUD: declaring the block in BOTH locations is ambiguous and throws", () => {
  // codex convergence: rather than silently preferring one (which would let a
  // malformed legacy block slip past), a co-present declaration fails loud.
  assert.throws(() => parseWatches([
    "---", "name: x",
    "metadata:",
    "  cinatra-watches:",
    "    primitives: [agent_run]",
    "cinatra-watches:",
    "  primitives: [legacy_primitive]",
    "---", "body",
  ].join("\n")), (e) => e instanceof WatchParseError && /BOTH/.test(e.message));
  // A malformed legacy block alongside a valid metadata block ALSO fails loud
  // (the legacy inline-value guard still runs).
  assert.throws(() => parseWatches([
    "---", "name: x",
    "metadata:",
    "  cinatra-watches:",
    "    primitives: [agent_run]",
    "cinatra-watches: agent_run",
    "---", "body",
  ].join("\n")), WatchParseError);
});

test("parseWatches DUAL-READ: a metadata block with a trailing comment + comment lines parses", () => {
  // `metadata: # ...` must be recognized, and a comment-only line must not set
  // the metadata child indent nor be mistaken for a key.
  const w = parseWatches([
    "---", "name: x",
    "metadata: # skill metadata",
    "  # the watches the gate enforces",
    "  cinatra-watches:",
    "    primitives: [agent_run]",
    "---", "body",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run"]);
});

test("parseWatches DUAL-READ: a comment-only value on metadata.cinatra-watches is a block (symmetry with legacy)", () => {
  // codex r2: `cinatra-watches: # note` (comment-only value) must be read as a
  // block in the metadata location exactly as the legacy top-level location does
  // — NOT mistaken for an inline value.
  const meta = parseWatches([
    "---", "name: x", "metadata:", "  cinatra-watches: # the watched surfaces",
    "    primitives: [agent_run]", "---", "body",
  ].join("\n"));
  assert.deepEqual(meta.primitives, ["agent_run"]);
  // Legacy top-level accepts the same shape.
  const legacy = parseWatches([
    "---", "name: x", "cinatra-watches: # the watched surfaces",
    "  primitives: [agent_run]", "---", "body",
  ].join("\n"));
  assert.deepEqual(legacy.primitives, ["agent_run"]);
});

test("parseWatches DUAL-READ: a metadata block without cinatra-watches falls back to legacy top-level", () => {
  // `metadata:` carries only unrelated keys, while a legacy top-level
  // cinatra-watches is still present — the gate must read the legacy block.
  const w = parseWatches([
    "---", "name: x",
    "metadata:",
    "  category: workflow",
    "cinatra-watches:",
    "  primitives: [agent_run]",
    "---", "body",
  ].join("\n"));
  assert.deepEqual(w.primitives, ["agent_run"]);
});

test("parseWatches DUAL-READ: no cinatra-watches in either location => null (undeclared)", () => {
  assert.equal(parseWatches("---\nname: x\nmetadata:\n  category: workflow\n---\nbody"), null);
});

test("parseWatches DUAL-READ FAIL-LOUD: an unknown key under metadata.cinatra-watches throws", () => {
  assert.throws(() => parseWatches([
    "---", "name: x", "metadata:", "  cinatra-watches:",
    "    primitives: [agent_run]", '    pakages: ["@cinatra-ai/typo"]',
    "---", "b",
  ].join("\n")), WatchParseError);
});

test("parseWatches DUAL-READ FAIL-LOUD: an inline metadata.cinatra-watches value throws", () => {
  assert.throws(() => parseWatches([
    "---", "name: x", "metadata:", "  cinatra-watches: agent_run",
    "---", "b",
  ].join("\n")), WatchParseError);
});

test("parseWatches DUAL-READ FAIL-LOUD: a present-but-EMPTY key under metadata throws", () => {
  assert.throws(() => parseWatches([
    "---", "name: x", "metadata:", "  cinatra-watches:",
    "    primitives: []", "---", "b",
  ].join("\n")), WatchParseError);
});

// --- Pure: path globs --------------------------------------------------------

test("globToRegExp: * stays within a segment; ** crosses segments", () => {
  assert.ok(globToRegExp("packages/agents/src/*.ts").test("packages/agents/src/a2a-actions.ts"));
  assert.ok(!globToRegExp("packages/agents/src/*.ts").test("packages/agents/src/nested/x.ts"));
  assert.ok(globToRegExp("packages/workflows/src/**").test("packages/workflows/src/a/b/c.ts"));
  assert.ok(globToRegExp("packages/workflows/src/**").test("packages/workflows/src/draft.ts"));
  assert.ok(globToRegExp("packages/**/route.ts").test("packages/a/b/route.ts"));
  assert.ok(globToRegExp("packages/**/route.ts").test("packages/route.ts"), "** must match zero segments too");
  assert.ok(!globToRegExp("packages/agents/src/a2a.ts").test("packages/agents/src/a2a-actions.ts"));
});

test("matchPathGlobs returns the globs that matched at least one touched path", () => {
  const hits = matchPathGlobs(
    ["packages/workflows/src/**", "packages/agents/src/a2a-actions.ts"],
    ["packages/workflows/src/draft.ts", "src/app/page.tsx"],
  );
  assert.deepEqual([...hits].sort(), ["packages/workflows/src/**"]);
});

// --- Pure: watch index + intersect ------------------------------------------

test("buildWatchIndex indexes declared skills only; declaredSkills lists them", () => {
  const { watchIndex, declaredSkills } = buildWatchIndex(SKILLS);
  assert.deepEqual([...declaredSkills], ["skill-watched/SKILL.md"]);
  assert.ok(watchIndex.primitives.has("workflow_draft_create"));
  assert.ok(watchIndex.packages.has("@cinatra-ai/blog-pipeline-agent"));
  assert.ok(watchIndex.routes.has("/api/workflows/preview"));
  assert.ok(watchIndex.paths.has("packages/workflows/src/**"));
});

test("buildWatchIndex FAIL-LOUD: a malformed watch block throws with the skill path", () => {
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-badkey")), (e) =>
    e instanceof WatchParseError && /skill-x\/SKILL\.md/.test(e.message));
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-scalar")), WatchParseError);
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-empty")), WatchParseError);
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-structured")), WatchParseError);
  // codex r2 HIGH: a watch value the extractor can never produce must fail loud.
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-badvalue")), (e) =>
    e instanceof WatchParseError && /skill-v\/SKILL\.md/.test(e.message) && /never match/.test(e.message));
});

test("buildWatchIndex DUAL-READ: a skill declaring watches under metadata is indexed", () => {
  const { watchIndex, declaredSkills } = buildWatchIndex(path.join(FIX, "skills-watch-metadata"));
  assert.deepEqual([...declaredSkills], ["skill-m/SKILL.md"]);
  assert.ok(watchIndex.primitives.has("workflow_draft_create"));
  assert.ok(watchIndex.packages.has("@cinatra-ai/blog-pipeline-agent"));
  assert.ok(watchIndex.routes.has("/api/workflows/preview"));
  assert.ok(watchIndex.paths.has("packages/workflows/src/**"));
});

test("buildWatchIndex DUAL-READ FAIL-LOUD: a malformed metadata.cinatra-watches block throws with the skill path", () => {
  assert.throws(() => buildWatchIndex(path.join(FIX, "skills-watch-metadata-badkey")), (e) =>
    e instanceof WatchParseError && /skill-mb\/SKILL\.md/.test(e.message));
});

test("validateWatchSurface: round-trips a watch value through the extractor grammar (codex r2 HIGH)", () => {
  // Valid surfaces pass.
  validateWatchSurface("primitives", "agent_run", "s");
  validateWatchSurface("packages", "@cinatra-ai/trigger-agent", "s");
  validateWatchSurface("routes", "/api/agents/passthrough", "s");
  // Surfaces the extractor can NEVER produce must throw (would silently never match).
  assert.throws(() => validateWatchSurface("primitives", "agent-run", "s"), WatchParseError);   // hyphen, not snake_case
  assert.throws(() => validateWatchSurface("primitives", "agentrun", "s"), WatchParseError);    // no underscore
  assert.throws(() => validateWatchSurface("packages", "cinatra-ai/foo", "s"), WatchParseError); // missing @ scope
  assert.throws(() => validateWatchSurface("routes", "api/foo", "s"), WatchParseError);          // missing leading /
  assert.throws(() => validateWatchSurface("primitives", "agent_run extra", "s"), WatchParseError); // not a single token
});

test("validateWatchSurface: a primitive that a configured stopword suppresses FAILS validation (codex r3 MED)", () => {
  // If config adds `agent_run` as a primitiveStopword, the diff extractor can
  // never emit it — so a watch naming it must fail validation (else the skill
  // would be declared, suppress heuristic, and never match).
  const opts = { primitiveStopwords: new Set(["agent_run"]) };
  assert.throws(() => validateWatchSurface("primitives", "agent_run", "s", opts), WatchParseError);
  // Without the stopword it is valid.
  validateWatchSurface("primitives", "agent_run", "s", {});
});

test("buildWatchIndex threads extractOpts: a stopword'd primitive watch fails loud", () => {
  // skill-watched declares primitives: [workflow_draft_create, ...]. If config
  // stopwords that primitive, buildWatchIndex must fail loud (not silently
  // declare-and-suppress).
  assert.throws(() => buildWatchIndex(SKILLS, { primitiveStopwords: new Set(["workflow_draft_create"]) }), WatchParseError);
});

test("findingSatisfied: covers union across multiple Skills-PR lines clears a multi-skill finding (MED-2)", () => {
  const multi = { class: "primitive", identifier: "agent_run", skills: ["skill-a/SKILL.md", "skill-b/SKILL.md"], source: "watch" };
  const acks = parseAcks("Skills-PR: #1 covers: skill-a\nSkills-PR: #2 covers: skill-b");
  assert.equal(findingSatisfied(multi, acks), true);
});

test("intersectWatches: a changed DECLARED primitive flags only the declaring skill", () => {
  const { watchIndex } = buildWatchIndex(SKILLS);
  const diffIds = extractIdentifiers("renamed workflow_draft_create to workflow_draft_new");
  const findings = intersectWatches(diffIds, [], watchIndex);
  const hit = findings.find((f) => f.identifier === "workflow_draft_create");
  assert.ok(hit);
  assert.equal(hit.source, "watch");
  assert.deepEqual(hit.skills, ["skill-watched/SKILL.md"]);
});

test("intersectWatches PATH FINDING: a watched source path edited with NO watched string flags the skill", () => {
  // The KEY v2 value-add (issue false-negative): a param-shape change touches a
  // watched FILE but leaves the watched STRING untouched. The `path` class catches it.
  const { watchIndex } = buildWatchIndex(SKILLS);
  const diffIds = extractIdentifiers("// some unrelated change, no watched identifier at all");
  const touched = ["packages/workflows/src/draft-actions.ts"];
  const findings = intersectWatches(diffIds, touched, watchIndex);
  const pathHit = findings.find((f) => f.class === "path");
  assert.ok(pathHit, `expected a path finding; got ${JSON.stringify(findings)}`);
  assert.deepEqual(pathHit.skills, ["skill-watched/SKILL.md"]);
});

// --- CLI: watches-first end-to-end ------------------------------------------

test("CLI: declared watches SUPPRESS the heuristic for the declaring skill", () => {
  // skill-watched's prose mentions agent_run_get, but it is DECLARED — so a diff
  // touching agent_run_get flags skill-a (heuristic) and NOT skill-watched.
  const dir = repoWithDiff("// initial\n", "renamed agent_run_get here\n");
  try {
    const res = runGate(dir, ["--diff-base", "main", "--mode", "warn"]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    const impacted = out.impactedSkills.map((s) => s.skill);
    assert.ok(impacted.includes("skill-a/SKILL.md"));
    assert.ok(!impacted.includes("skill-watched/SKILL.md"),
      `declared skill must not be flagged by a heuristic identifier in its prose; got ${JSON.stringify(impacted)}`);
  } finally { rm(dir); }
});

test("CLI FAIL-LOUD (exit 2): a present-but-EMPTY watch key breaks the gate (codex HIGH-1)", () => {
  // skill-z declares `primitives: []`. An empty watch key must fail loud, not
  // silently fall back to the heuristic (a path-only watch collapsing to empty
  // would be an undetectable false-negative).
  const dir = repoWithDiff("// a\n", "// b\n");
  try {
    for (const mode of ["warn", "enforce"]) {
      const res = spawnSync("node", [GATE, "--skills-dir", path.join(FIX, "skills-watch-empty"), "--format", "json", "--diff-base", "main", "--mode", mode], {
        cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" },
      });
      assert.equal(res.status, 2, `empty watch key must fail loud in ${mode}; stderr: ${res.stderr}`);
    }
  } finally { rm(dir); }
});

test("CLI FAIL-LOUD (exit 2): a malformed cinatra-watches block breaks the gate in any mode", () => {
  const dir = repoWithDiff("// a\n", "// b\n");
  try {
    for (const mode of ["warn", "enforce"]) {
      const res = spawnSync("node", [GATE, "--skills-dir", path.join(FIX, "skills-watch-badkey"), "--format", "json", "--diff-base", "main", "--mode", mode], {
        cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" },
      });
      assert.equal(res.status, 2, `malformed watch must fail loud in ${mode}; stderr: ${res.stderr}`);
      assert.match(res.stderr, /malformed cinatra-watches/);
    }
  } finally { rm(dir); }
});

test("CLI: a declared PATH watch flags via a real source-file edit (param-shape change)", () => {
  // Edit packages/workflows/src/draft-actions.ts with no watched STRING — the
  // path watch must still flag skill-watched. Exercises touchedPaths in the CLI.
  const dir = tmpDir();
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    fs.mkdirSync(path.join(dir, "packages/workflows/src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages/workflows/src/draft-actions.ts"), "export function draft(a) { return a; }\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "feature");
    // Add a param — NO watched identifier string changes.
    fs.writeFileSync(path.join(dir, "packages/workflows/src/draft-actions.ts"), "export function draft(a, b) { return a + b; }\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add param");

    const res = runGate(dir, ["--diff-base", "main", "--mode", "enforce"]);
    assert.equal(res.status, 1, `unacknowledged path watch must gate enforce; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.ok(out.watchFindings.some((f) => f.class === "path" && f.skills.includes("skill-watched/SKILL.md")),
      `expected a path watch finding; got ${JSON.stringify(out.watchFindings)}`);
  } finally { rm(dir); }
});
