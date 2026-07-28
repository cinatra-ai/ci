// Regression tests for scripts/materialize-skills-union.sh — the multi-repo
// skills-union materializer the reusable gate workflow invokes
// (cinatra#2090 S3: the watch-bearing SKILL.mds are spread across the
// successor skill repos). Same convention as collect-skills-acks: the test
// runs THE shipped script against local fixture git repos, so the shipped
// behaviour and the tested behaviour can never drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "materialize-skills-union.sh");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Create a bare-usable fixture repo `<base>/<owner>/<name>` with skills/<slug>/SKILL.md bundles. */
function makeSkillRepo(base, owner, name, slugs, opts = {}) {
  const dir = path.join(base, owner, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "fixture");
  // Local-transport SHA fetch needs the server-side opt-in GitHub already has.
  git(dir, "config", "uploadpack.allowReachableSHA1InWant", "true");
  if (!opts.noSkillsDir) {
    for (const slug of slugs) {
      mkdirSync(path.join(dir, "skills", slug), { recursive: true });
      writeFileSync(
        path.join(dir, "skills", slug, "SKILL.md"),
        `---\nname: ${slug}\n---\n# ${slug}\n`,
      );
      mkdirSync(path.join(dir, "skills", slug, "references"), { recursive: true });
      writeFileSync(path.join(dir, "skills", slug, "references", "extra.md"), `ref for ${slug}\n`);
    }
  } else {
    writeFileSync(path.join(dir, "README.md"), "no skills dir\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

function runUnion(env) {
  return execFileSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function expectFail(env, needle) {
  try {
    execFileSync("bash", [SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  } catch (err) {
    assert.match(String(err.stderr), needle);
    return;
  }
  assert.fail("expected the materializer to fail loud");
}

test("materializes the union of several pinned repos into one skills/ tree (references included)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = makeSkillRepo(base, "acme", "core-skill", ["chat-core"]);
  const b = makeSkillRepo(base, "acme", "authoring-skill", ["chat-authoring", "chat-other"]);
  const out = path.join(base, "union");

  const stdout = runUnion({
    SKILLS_REPOS: `acme/core-skill@${a.sha}\nacme/authoring-skill@${b.sha}`,
    UNION_DIR: out,
    GIT_BASE_URL: base,
  });

  assert.match(stdout, /union 3 bundle\(s\) from 2 repo\(s\)/);
  assert.ok(existsSync(path.join(out, "skills", "chat-core", "SKILL.md")));
  assert.ok(existsSync(path.join(out, "skills", "chat-authoring", "SKILL.md")));
  assert.ok(existsSync(path.join(out, "skills", "chat-other", "SKILL.md")));
  // The full bundle rides along, not just the SKILL.md (one-hop references).
  assert.equal(readFileSync(path.join(out, "skills", "chat-core", "references", "extra.md"), "utf8"), "ref for chat-core\n");
});

test("comma-separated entries work (workflow input convenience)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = makeSkillRepo(base, "acme", "one-skill", ["one"]);
  const b = makeSkillRepo(base, "acme", "two-skill", ["two"]);
  const out = path.join(base, "union");
  const stdout = runUnion({
    SKILLS_REPOS: `acme/one-skill@${a.sha},acme/two-skill@${b.sha}`,
    UNION_DIR: out,
    GIT_BASE_URL: base,
  });
  assert.match(stdout, /union 2 bundle\(s\) from 2 repo\(s\)/);
});

test("fails loud on an empty repo list (a pinned gate must never default)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  expectFail({ SKILLS_REPOS: "", UNION_DIR: path.join(base, "u") }, /SKILLS_REPOS is empty/);
});

test("fails loud on a branch pin / malformed entry (only 40-hex SHAs)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  expectFail(
    { SKILLS_REPOS: "acme/one-skill@main", UNION_DIR: path.join(base, "u"), GIT_BASE_URL: base },
    /invalid entry/,
  );
  expectFail(
    { SKILLS_REPOS: "acme/one-skill@deadbeef; rm -rf /", UNION_DIR: path.join(base, "u2"), GIT_BASE_URL: base },
    /invalid entry/,
  );
});

test("fails loud when a pinned repo ships no skills/ dir (no silent surface shrink)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bad = makeSkillRepo(base, "acme", "empty-skill", [], { noSkillsDir: true });
  expectFail(
    { SKILLS_REPOS: `acme/empty-skill@${bad.sha}`, UNION_DIR: path.join(base, "u"), GIT_BASE_URL: base },
    /no skills\/ dir/,
  );
});

test("fails loud on a duplicate bundle slug across repos (no ambiguous union)", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = makeSkillRepo(base, "acme", "left-skill", ["same-slug"]);
  const b = makeSkillRepo(base, "acme", "right-skill", ["same-slug"]);
  expectFail(
    {
      SKILLS_REPOS: `acme/left-skill@${a.sha} acme/right-skill@${b.sha}`,
      UNION_DIR: path.join(base, "u"),
      GIT_BASE_URL: base,
    },
    /appears in more than one repo/,
  );
});

test("fails loud on an unfetchable pin", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-union-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  makeSkillRepo(base, "acme", "real-skill", ["x"]);
  expectFail(
    {
      SKILLS_REPOS: "acme/real-skill@0123456789abcdef0123456789abcdef01234567",
      UNION_DIR: path.join(base, "u"),
      GIT_BASE_URL: base,
    },
    /could not fetch/,
  );
});
