import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest, scanWorkflows, analyze, listWorkflowFiles, BUILTIN_SECRETS } from "../secrets-required-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "secrets-required-gate.mjs");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "srg-")));
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function runGate(extraArgs, opts = {}) {
  return spawnSync("node", [GATE, ...extraArgs], { encoding: "utf8", ...opts });
}

/**
 * Build a tmp repo root with a manifest body and a map of workflow file => body.
 */
function scaffold({ manifest, workflows }) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  if (manifest !== null && manifest !== undefined) {
    fs.writeFileSync(path.join(root, ".github", "secrets-required.txt"), manifest);
  }
  for (const [name, body] of Object.entries(workflows || {})) {
    fs.writeFileSync(path.join(root, ".github", "workflows", name), body);
  }
  return root;
}

/* ------------------------------- parseManifest ------------------------------- */

test("parseManifest: column-0 UPPER_SNAKE tokens are entries; prose + comments are not", () => {
  const text = [
    "# header comment",
    "",
    "CINATRA_RELEASE_DISPATCH_TOKEN",
    "  Purpose : something referencing DEV_LOCK_BUMP_TOKEN mid-sentence (NOT an entry)",
    "  Scope   : repo",
    "",
    "DEV_LOCK_BUMP_TOKEN",
    "  Wiring : only in dev-lock-auto-bump.yml",
  ].join("\n");
  const { entries, errors } = parseManifest(text);
  assert.deepEqual([...entries.keys()].sort(), ["CINATRA_RELEASE_DISPATCH_TOKEN", "DEV_LOCK_BUMP_TOKEN"]);
  assert.deepEqual(errors, []);
});

test("parseManifest: a single line can declare several names separated by ' / '", () => {
  const { entries, errors } = parseManifest("DOCKERHUB_USERNAME / DOCKERHUB_TOKEN\n  note\n");
  assert.deepEqual([...entries.keys()].sort(), ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"]);
  assert.deepEqual(errors, []);
});

test("parseManifest: duplicate declaration is an error", () => {
  const { errors } = parseManifest("FOO_TOKEN\nFOO_TOKEN\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate declaration of FOO_TOKEN/);
});

test("parseManifest: a column-0 line that is not UPPER_SNAKE is a parse error", () => {
  const { errors } = parseManifest("lowercase-not-a-secret\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unparseable entry token/);
});

/* ------------------------------- scanWorkflows ------------------------------- */

test("scanWorkflows: resolves secrets.NAME and quoted bracket forms (whitespace tolerant); ignores dynamic", () => {
  const root = scaffold({
    manifest: "",
    workflows: {
      "a.yml": "x: ${{ secrets.ALPHA }}\ny: ${{ secrets ['BETA'] }}\nz: ${{ secrets[ \"GAMMA\" ] }}\n",
      "b.yml": "k: ${{ secrets[matrix.name] }}\n",
    },
  });
  try {
    const files = listWorkflowFiles(path.join(root, ".github", "workflows"));
    const { refs, dynamic } = scanWorkflows(files);
    assert.deepEqual([...refs.keys()].sort(), ["ALPHA", "BETA", "GAMMA"]);
    assert.equal(dynamic.length, 1);
    assert.match(dynamic[0].file, /b\.yml$/);
  } finally { rm(root); }
});

test("scanWorkflows: a quoted bracket ref with whitespace is NOT also counted dynamic", () => {
  const root = scaffold({ manifest: "", workflows: { "a.yml": "y: ${{ secrets [ 'BETA' ] }}\n" } });
  try {
    const files = listWorkflowFiles(path.join(root, ".github", "workflows"));
    const { refs, dynamic } = scanWorkflows(files);
    assert.deepEqual([...refs.keys()], ["BETA"]);
    assert.equal(dynamic.length, 0, "a quoted (static) bracket ref must not be flagged dynamic");
  } finally { rm(root); }
});

test("analyze: `secrets: inherit` fails closed (un-auditable, forwards all secrets)", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\n",
    workflows: {
      "caller.yml": "jobs:\n  x:\n    uses: org/repo/.github/workflows/w.yml@sha\n    secrets: inherit\n",
      "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\n",
    },
  });
  try {
    const result = analyze({
      manifestText: fs.readFileSync(path.join(root, ".github", "secrets-required.txt"), "utf8"),
      workflowFiles: listWorkflowFiles(path.join(root, ".github", "workflows")),
      rootForDisplay: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.inheritReferences.length, 1);
    assert.match(result.inheritReferences[0].file, /caller\.yml$/);
    assert.equal(runGate(["--root", root, "--quiet"]).status, 1);
  } finally { rm(root); }
});

test("scanWorkflows: `secrets: inherit` with a trailing comment or quoting is still caught", () => {
  const root = scaffold({
    manifest: "",
    workflows: {
      "a.yml": "    secrets: inherit # forward everything\n",
      "b.yml": "    secrets: \"inherit\"\n",
      "c.yml": "    secrets: 'inherit'\n",
      "d.yml": "    secrets: inherit\n",
    },
  });
  try {
    const { inherit } = scanWorkflows(listWorkflowFiles(path.join(root, ".github", "workflows")));
    assert.equal(inherit.length, 4, "comment, double-quoted, single-quoted, and bare forms all match");
  } finally { rm(root); }
});

test("GITHUB_TOKEN is the built-in that is excluded from both sides", () => {
  assert.ok(BUILTIN_SECRETS.has("GITHUB_TOKEN"));
});

/* --------------------------------- analyze --------------------------------- */

test("analyze: in-lockstep manifest passes; GITHUB_TOKEN never needs declaring", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\nBETA_TOKEN\n",
    workflows: {
      "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\nb: ${{ secrets.BETA_TOKEN }}\ng: ${{ secrets.GITHUB_TOKEN }}\n",
    },
  });
  try {
    const result = analyze({
      manifestText: fs.readFileSync(path.join(root, ".github", "secrets-required.txt"), "utf8"),
      workflowFiles: listWorkflowFiles(path.join(root, ".github", "workflows")),
      rootForDisplay: root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.declaredCount, 2);
    assert.equal(result.referencedCount, 2);
    assert.equal(runGate(["--root", root, "--quiet"]).status, 0);
  } finally { rm(root); }
});

test("analyze: orphan reference (referenced, undeclared) fails — the #315 DEV_LOCK_BUMP_TOKEN class", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\n",
    workflows: {
      "dev-lock-auto-bump.yml": "a: ${{ secrets.ALPHA_TOKEN }}\nb: ${{ secrets.DEV_LOCK_BUMP_TOKEN }}\n",
    },
  });
  try {
    const result = analyze({
      manifestText: fs.readFileSync(path.join(root, ".github", "secrets-required.txt"), "utf8"),
      workflowFiles: listWorkflowFiles(path.join(root, ".github", "workflows")),
      rootForDisplay: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.orphanReferences.length, 1);
    assert.equal(result.orphanReferences[0].name, "DEV_LOCK_BUMP_TOKEN");
    assert.match(result.orphanReferences[0].files[0], /dev-lock-auto-bump\.yml$/);
    assert.equal(runGate(["--root", root, "--quiet"]).status, 1);
  } finally { rm(root); }
});

test("analyze: orphan declaration (declared, unreferenced) is a hard fail", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\nSTALE_TOKEN\n",
    workflows: { "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\n" },
  });
  try {
    const result = analyze({
      manifestText: fs.readFileSync(path.join(root, ".github", "secrets-required.txt"), "utf8"),
      workflowFiles: listWorkflowFiles(path.join(root, ".github", "workflows")),
      rootForDisplay: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.orphanDeclarations.length, 1);
    assert.equal(result.orphanDeclarations[0].name, "STALE_TOKEN");
    assert.equal(runGate(["--root", root, "--quiet"]).status, 1);
  } finally { rm(root); }
});

test("analyze: a dynamic secrets[...] reference fails closed (cannot be audited)", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\n",
    workflows: { "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\nd: ${{ secrets[matrix.key] }}\n" },
  });
  try {
    const result = analyze({
      manifestText: fs.readFileSync(path.join(root, ".github", "secrets-required.txt"), "utf8"),
      workflowFiles: listWorkflowFiles(path.join(root, ".github", "workflows")),
      rootForDisplay: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.dynamicReferences.length, 1);
    assert.equal(runGate(["--root", root, "--quiet"]).status, 1);
  } finally { rm(root); }
});

/* --------------------------------- CLI edges --------------------------------- */

test("missing manifest with referenced secrets fails loud (exit 2)", () => {
  const root = scaffold({ manifest: null, workflows: { "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\n" } });
  try {
    assert.equal(runGate(["--root", root, "--quiet"]).status, 2);
  } finally { rm(root); }
});

test("missing manifest with NO referenced secrets passes (nothing to declare)", () => {
  const root = scaffold({ manifest: null, workflows: { "w.yml": "a: ${{ secrets.GITHUB_TOKEN }}\n" } });
  try {
    assert.equal(runGate(["--root", root, "--quiet"]).status, 0);
  } finally { rm(root); }
});

test("json format reports the structured result", () => {
  const root = scaffold({
    manifest: "ALPHA_TOKEN\n",
    workflows: { "w.yml": "a: ${{ secrets.ALPHA_TOKEN }}\n" },
  });
  try {
    const res = runGate(["--root", root, "--format", "json"]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.ok(out.gateVersion);
    assert.equal(out.declaredCount, 1);
  } finally { rm(root); }
});

test("invalid usage fails loud (exit 2), never a silently weaker run", () => {
  const root = scaffold({ manifest: "A_TOKEN\n", workflows: { "w.yml": "a: ${{ secrets.A_TOKEN }}\n" } });
  try {
    assert.equal(runGate(["--root", root, "--format", "yaml"]).status, 2, "unknown --format");
    assert.equal(runGate(["--root", root, "--format"]).status, 2, "bare --format");
    assert.equal(runGate(["--root"]).status, 2, "bare --root");
    assert.equal(runGate(["--frmat", "json"]).status, 2, "unknown flag");
    assert.equal(runGate(["--quiet=1", "--root", root]).status, 2, "value on boolean flag");
    assert.equal(runGate([root]).status, 2, "positional argument");
  } finally { rm(root); }
});

test("nested workflow files (subdirectories) are scanned", () => {
  const root = scaffold({ manifest: "NESTED_TOKEN\n", workflows: {} });
  try {
    const sub = path.join(root, ".github", "workflows", "sub");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "n.yml"), "a: ${{ secrets.NESTED_TOKEN }}\n");
    assert.equal(runGate(["--root", root, "--quiet"]).status, 0);
  } finally { rm(root); }
});
