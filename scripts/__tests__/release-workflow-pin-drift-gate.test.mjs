import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractReusablePin,
  auditPins,
  REUSABLE_WORKFLOW_PATH,
} from "../release-workflow-pin-drift-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "release-workflow-pin-drift-gate.mjs");

const GATED_SHA = "1e4448a75dc27b7be4d52ac3ce0734fa7c766957";
const UNGATED_SHA = "fea09b38e94c0a64f7fab3c02d34b0fe1ecf746d";

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rwpdg-")));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function runGate(extraArgs, opts = {}) {
  return spawnSync("node", [GATE, ...extraArgs], { encoding: "utf8", ...opts });
}

function releaseYml(ref, comment = "") {
  return [
    "name: release",
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  release:",
    "    permissions:",
    "      contents: write",
    `    uses: ${REUSABLE_WORKFLOW_PATH}@${ref}${comment ? ` # ${comment}` : ""}`,
    "    secrets: inherit",
    "",
  ].join("\n");
}

/* ------------------------------ extractReusablePin ------------------------------ */

test("extractReusablePin: SHA-pinned gated ref with a version comment", () => {
  const pin = extractReusablePin(releaseYml(GATED_SHA, "v0.1.1"));
  assert.equal(pin.found, true);
  assert.equal(pin.pinnedToSha, true);
  assert.equal(pin.sha, GATED_SHA);
});

test("extractReusablePin: SHA-pinned ungated ref", () => {
  const pin = extractReusablePin(releaseYml(UNGATED_SHA, "v0.1.0"));
  assert.equal(pin.found, true);
  assert.equal(pin.pinnedToSha, true);
  assert.equal(pin.sha, UNGATED_SHA);
});

test("extractReusablePin: a mutable tag ref is found but not SHA-pinned", () => {
  const pin = extractReusablePin(releaseYml("v0.1.1"));
  assert.equal(pin.found, true);
  assert.equal(pin.pinnedToSha, false);
  assert.equal(pin.sha, null);
});

test("extractReusablePin: quoted uses key + list-dash step is parsed", () => {
  const text = `jobs:\n  release:\n    - "uses": ${REUSABLE_WORKFLOW_PATH}@${GATED_SHA} # v0.1.1\n`;
  const pin = extractReusablePin(text);
  assert.equal(pin.found, true);
  assert.equal(pin.sha, GATED_SHA);
});

test("extractReusablePin: a release.yml that does NOT call the reusable workflow => not found", () => {
  const text = "jobs:\n  release:\n    steps:\n      - run: npm publish --access public\n";
  const pin = extractReusablePin(text);
  assert.equal(pin.found, false);
});

test("extractReusablePin: non-string input => not found (defensive)", () => {
  assert.equal(extractReusablePin(null).found, false);
  assert.equal(extractReusablePin(undefined).found, false);
});

/* -------------------------------- auditPins -------------------------------- */

test("auditPins: all repos gated => clean", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA],
    repos: {
      "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1"),
      "cinatra-ai/assistant-skills": releaseYml(GATED_SHA, "v0.1.1"),
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.audited.length, 2);
});

test("auditPins: an ungated pin fails closed with an ungated-ref finding", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA],
    repos: {
      "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1"),
      "cinatra-ai/nango-connector": releaseYml(UNGATED_SHA, "v0.1.0"),
    },
  });
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.repo === "cinatra-ai/nango-connector");
  assert.ok(f, "the ungated repo must be flagged");
  assert.equal(f.reason, "ungated-ref");
  assert.equal(f.ref, UNGATED_SHA);
});

test("auditPins: a mutable-tag pin fails closed (not-sha-pinned)", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA],
    repos: { "cinatra-ai/some-connector": releaseYml("v0.1.1") },
  });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].reason, "not-sha-pinned");
});

test("auditPins: a repo with no release.yml (null) is skipped, not drift", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA],
    repos: {
      "cinatra-ai/some-agent": null,
      "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1"),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.audited.length, 1, "only the release repo is audited");
});

test("auditPins: a release.yml that publishes elsewhere (no reusable call) is skipped", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA],
    repos: {
      "cinatra-ai/cinatra-cli": "jobs:\n  release:\n    steps:\n      - run: npm publish\n",
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.audited.length, 0);
});

test("auditPins: gated-ref match is case-insensitive on the SHA", () => {
  const r = auditPins({
    gatedRefs: [GATED_SHA.toUpperCase()],
    repos: { "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1") },
  });
  assert.equal(r.ok, true);
});

/* ------------------------------ CLI via --repos-json ------------------------------ */

function scaffold({ repos, gatedRefs = [GATED_SHA] }) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "release-workflow-gated-refs.json"),
    JSON.stringify({ gatedRefs })
  );
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify(repos));
  return root;
}

test("CLI --repos-json: clean when all repos gated (exit 0)", () => {
  const root = scaffold({ repos: { "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1") } });
  try {
    const res = runGate(["--root", root, "--repos-json", "repos.json", "--quiet"]);
    assert.equal(res.status, 0);
  } finally {
    rm(root);
  }
});

test("CLI --repos-json: an ungated pin fails closed (exit 1) and names the repo", () => {
  const root = scaffold({
    repos: {
      "cinatra-ai/openai-connector": releaseYml(GATED_SHA, "v0.1.1"),
      "cinatra-ai/nango-connector": releaseYml(UNGATED_SHA, "v0.1.0"),
    },
  });
  try {
    const res = runGate(["--root", root, "--repos-json", "repos.json"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /nango-connector/);
    assert.match(res.stderr, /release-approval/);
  } finally {
    rm(root);
  }
});

test("CLI --live: no token => GREEN SKIP (exit 0, notice)", () => {
  const root = scaffold({ repos: {} });
  try {
    const env = { ...process.env };
    delete env.RELEASE_PIN_DRIFT_READ_TOKEN;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const res = runGate(["--root", root, "--live", "--org", "cinatra-ai"], { env });
    assert.equal(res.status, 0, "an unconfigured token must skip green, not red");
    assert.match(res.stderr, /not configured/);
  } finally {
    rm(root);
  }
});

test("CLI: an empty gated-ref allowlist fails loud (exit 2)", () => {
  const root = scaffold({ repos: {}, gatedRefs: [] });
  try {
    const res = runGate(["--root", root, "--repos-json", "repos.json"]);
    assert.equal(res.status, 2);
  } finally {
    rm(root);
  }
});

test("CLI: a non-hex gated ref fails loud (exit 2)", () => {
  const root = tmpDir();
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "release-workflow-gated-refs.json"),
      JSON.stringify({ gatedRefs: ["v0.1.1"] })
    );
    fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({}));
    assert.equal(runGate(["--root", root, "--repos-json", "repos.json"]).status, 2);
  } finally {
    rm(root);
  }
});

test("CLI: neither --live nor --repos-json fails loud (exit 2)", () => {
  const root = scaffold({ repos: {} });
  try {
    assert.equal(runGate(["--root", root]).status, 2);
  } finally {
    rm(root);
  }
});

test("CLI: unknown flag fails loud (exit 2)", () => {
  assert.equal(runGate(["--bogus"]).status, 2);
});
