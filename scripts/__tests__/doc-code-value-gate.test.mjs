import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripCodeFences,
  extractValue,
  extractJsonValue,
  resolveSide,
  runAssertions,
  GATE_VERSION,
} from "../doc-code-value-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "doc-code-value-gate.mjs");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcvg-")));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function runGate(args, opts = {}) {
  return spawnSync("node", [GATE, ...args], { encoding: "utf8", ...opts });
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Pure helpers

test("stripCodeFences removes fenced blocks but keeps inline code spans", () => {
  const txt = "Live: `2.2.0`\n```\nexample 9.9.9\n```\nafter\n";
  const out = stripCodeFences(txt);
  assert.match(out, /Live: `2\.2\.0`/);
  assert.doesNotMatch(out, /9\.9\.9/);
  assert.match(out, /after/);
});

test("extractValue returns the single captured value", () => {
  const r = extractValue('x = "2.2.0";', 'x = "(\\d+\\.\\d+\\.\\d+)"', "code");
  assert.equal(r.value, "2.2.0");
});

test("extractValue fails-closed on zero matches (drift)", () => {
  const r = extractValue("nothing here", 'x = "(\\d+\\.\\d+\\.\\d+)"', "code");
  assert.ok(r.error);
  assert.match(r.error, /did not match/);
});

test("extractValue fails on ambiguous (>1) matches", () => {
  const txt = 'a = "1.0.0"\nb = "2.0.0"\n';
  const r = extractValue(txt, '"(\\d+\\.\\d+\\.\\d+)"', "code");
  assert.ok(r.error);
  assert.match(r.error, /matched 2 times/);
});

test("extractJsonValue reads a dot-path pointer", () => {
  const r = extractJsonValue('{"cinatra":{"sdkAbiVersion":"2.2.0"}}', "cinatra.sdkAbiVersion", "pkg");
  assert.equal(r.value, "2.2.0");
});

test("extractJsonValue fails on a missing pointer", () => {
  const r = extractJsonValue('{"a":1}', "a.b.c", "pkg");
  assert.ok(r.error);
  assert.match(r.error, /not found/);
});

test("extractJsonValue rejects a non-string leaf", () => {
  const r = extractJsonValue('{"n":2}', "n", "pkg");
  assert.ok(r.error);
  assert.match(r.error, /expected a string/);
});

// ---------------------------------------------------------------------------
// resolveSide / runAssertions

test("equal doc and code values pass", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "The ABI is **`2.2.0`** today.\n");
    write(dir, "code.ts", 'export const ABI = "2.2.0" as const;\n');
    const { ok, results } = runAssertions(dir, [
      {
        label: "abi",
        doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
        code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
      },
    ]);
    assert.equal(ok, true);
    assert.equal(results[0].docValue, "2.2.0");
    assert.equal(results[0].codeValue, "2.2.0");
  } finally {
    rm(dir);
  }
});

test("differing doc and code values fail", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "The ABI is **`2.0.0`** today.\n");
    write(dir, "code.ts", 'export const ABI = "2.2.0" as const;\n');
    const { ok, results } = runAssertions(dir, [
      {
        label: "abi",
        doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
        code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
      },
    ]);
    assert.equal(ok, false);
    assert.match(results[0].errors.join("\n"), /"2\.0\.0".*!=.*"2\.2\.0"/);
  } finally {
    rm(dir);
  }
});

test("doc fenced example does not shadow the canonical statement", () => {
  const dir = tmpDir();
  try {
    // The fenced example carries a DIFFERENT version; with fence-stripping the
    // canonical statement is the only thing the pattern can see, so it must pass.
    write(
      dir,
      "README.md",
      "The ABI is **`2.2.0`** today.\n\n```jsonc\n{ \"abiExample\": \"9.9.9\" }\n```\n",
    );
    write(dir, "code.ts", 'export const ABI = "2.2.0" as const;\n');
    const { ok } = runAssertions(dir, [
      {
        label: "abi",
        doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
        code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
      },
    ]);
    assert.equal(ok, true);
  } finally {
    rm(dir);
  }
});

test("a json side is parsed, not regex-scanned", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "The ABI is **`2.2.0`** today.\n");
    write(dir, "package.json", '{\n  "cinatra": { "sdkAbiVersion": "2.2.0" }\n}\n');
    const { ok } = runAssertions(dir, [
      {
        label: "abi-pkg",
        doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
        code: { file: "package.json", type: "json", pointer: "cinatra.sdkAbiVersion" },
      },
    ]);
    assert.equal(ok, true);
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------
// CLI / exit codes

test("CLI single-assertion flags pass (exit 0)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "ABI: 2.2.0\n");
    write(dir, "code.ts", 'const ABI = "2.2.0";\n');
    const r = runGate(
      [
        "--root", dir,
        "--label", "abi",
        "--doc-file", "README.md",
        "--doc-pattern", "ABI: (\\d+\\.\\d+\\.\\d+)",
        "--code-file", "code.ts",
        "--code-pattern", 'ABI = "(\\d+\\.\\d+\\.\\d+)"',
      ],
    );
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rm(dir);
  }
});

test("CLI drift fails (exit 1)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "ABI: 2.0.0\n");
    write(dir, "code.ts", 'const ABI = "2.2.0";\n');
    const r = runGate([
      "--root", dir,
      "--doc-file", "README.md",
      "--doc-pattern", "ABI: (\\d+\\.\\d+\\.\\d+)",
      "--code-file", "code.ts",
      "--code-pattern", 'ABI = "(\\d+\\.\\d+\\.\\d+)"',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /!=/);
  } finally {
    rm(dir);
  }
});

test("CLI missing match fails-closed (exit 1)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "no version here\n");
    write(dir, "code.ts", 'const ABI = "2.2.0";\n');
    const r = runGate([
      "--root", dir,
      "--doc-file", "README.md",
      "--doc-pattern", "ABI: (\\d+\\.\\d+\\.\\d+)",
      "--code-file", "code.ts",
      "--code-pattern", 'ABI = "(\\d+\\.\\d+\\.\\d+)"',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /did not match/);
  } finally {
    rm(dir);
  }
});

test("multi-assertion config (exit 0)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "The ABI is **`2.2.0`** today.\n");
    write(dir, "code.ts", 'export const ABI = "2.2.0" as const;\n');
    write(dir, "package.json", '{ "cinatra": { "sdkAbiVersion": "2.2.0" } }\n');
    write(
      dir,
      "gate.config.json",
      JSON.stringify({
        assertions: [
          {
            label: "readme==code",
            doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
            code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
          },
          {
            label: "readme==pkg",
            doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
            code: { file: "package.json", type: "json", pointer: "cinatra.sdkAbiVersion" },
          },
        ],
      }),
    );
    const r = runGate(["--root", dir, "--config", "gate.config.json"]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rm(dir);
  }
});

test("multi-assertion config fails when one assertion drifts (exit 1)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "The ABI is **`2.2.0`** today.\n");
    write(dir, "code.ts", 'export const ABI = "2.2.0" as const;\n');
    write(dir, "package.json", '{ "cinatra": { "sdkAbiVersion": "2.0.0" } }\n');
    write(
      dir,
      "gate.config.json",
      JSON.stringify([
        {
          label: "readme==code",
          doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
          code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
        },
        {
          label: "readme==pkg",
          doc: { file: "README.md", pattern: "ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
          code: { file: "package.json", type: "json", pointer: "cinatra.sdkAbiVersion" },
        },
      ]),
    );
    const r = runGate(["--root", dir, "--config", "gate.config.json"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /readme==pkg/);
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------
// Usage errors — loud, never a silently weaker run

test("usage errors fail loud (exit 2)", () => {
  const dir = tmpDir();
  try {
    write(dir, "README.md", "ABI: 2.2.0\n");
    assert.equal(runGate(["--root", dir, "--frob", "x"]).status, 2, "unknown flag");
    assert.equal(runGate(["--root"]).status, 2, "bare --root");
    assert.equal(runGate(["--root="]).status, 2, "empty --root");
    assert.equal(runGate(["--root", dir]).status, 2, "no assertion + no --config");
    assert.equal(runGate(["--root", dir, "--config", "nope.json"]).status, 2, "missing config file");
    assert.equal(runGate(["--no-strip-fences=1", "--root", dir]).status, 2, "value on a boolean flag");
    assert.equal(runGate([dir]).status, 2, "positional argument");
  } finally {
    rm(dir);
  }
});

test("ambiguous code pattern fails-closed (exit 1)", () => {
  const dir = tmpDir();
  try {
    // Two version-shaped tokens; an unanchored pattern is ambiguous → fail.
    write(dir, "README.md", "ABI: 2.2.0\n");
    write(dir, "code.ts", 'const A = "2.2.0";\nconst B = "2.1.0";\n');
    const r = runGate([
      "--root", dir,
      "--doc-file", "README.md",
      "--doc-pattern", "ABI: (\\d+\\.\\d+\\.\\d+)",
      "--code-file", "code.ts",
      "--code-pattern", '"(\\d+\\.\\d+\\.\\d+)"',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ambiguous/);
  } finally {
    rm(dir);
  }
});

test("a multi-capture-group pattern is rejected (no vacuous partial-capture pass)", () => {
  // Both files differ (2.0.0 vs 2.2.0) but a 2-group pattern would capture only
  // the MAJOR ("2") on each side and pass vacuously — the gate must refuse it.
  const dir = tmpDir();
  try {
    write(dir, "README.md", "ABI: 2.0.0\n");
    write(dir, "code.ts", 'const ABI = "2.2.0";\n');
    const r = runGate([
      "--root", dir,
      "--doc-file", "README.md",
      "--doc-pattern", "ABI: (\\d+)\\.(\\d+\\.\\d+)",
      "--code-file", "code.ts",
      "--code-pattern", 'ABI = "(\\d+)\\.(\\d+\\.\\d+)"',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /EXACTLY ONE/);
  } finally {
    rm(dir);
  }
});

test("a zero-capture-group pattern is rejected", () => {
  const r = extractValue("ABI: 2.2.0\n", "ABI: \\d+\\.\\d+\\.\\d+", "code");
  assert.ok(r.error);
  assert.match(r.error, /0 capture group/);
});

test("an absolute file path is rejected (confined to root)", () => {
  const dir = tmpDir();
  try {
    write(dir, "code.ts", 'const ABI = "2.2.0";\n');
    const r = runAssertions(dir, [
      {
        label: "x",
        doc: { file: "/etc/hostname", pattern: "(\\S+)" },
        code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.results[0].errors.join("\n"), /must be a repo-relative path/);
  } finally {
    rm(dir);
  }
});

test("a `..` path that escapes the root is rejected", () => {
  const dir = tmpDir();
  try {
    write(dir, "sub/code.ts", 'const ABI = "2.2.0";\n');
    const subRoot = path.join(dir, "sub");
    const r = runAssertions(subRoot, [
      {
        label: "x",
        doc: { file: "../code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
        code: { file: "code.ts", pattern: 'ABI = "(\\d+\\.\\d+\\.\\d+)"' },
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.results[0].errors.join("\n"), /escapes the repo root/);
  } finally {
    rm(dir);
  }
});

test("gate version is exported", () => {
  assert.ok(GATE_VERSION);
});
