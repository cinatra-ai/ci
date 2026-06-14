// Tests for the reusable extension→host IoC conformance gate
// (cinatra-engineering#156): the rule library + the CLI + the REAL cross-repo
// parity guard against the cinatra monorepo source of truth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as rules from "../lib/extension-ioc-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "scripts", "extension-ioc-gate.mjs");
const FIX = join(__dirname, "..", "__fixtures__", "extension-ioc");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// ---------------------------------------------------------------------------
// Lexer: import extraction + comment/string robustness.

test("extractImports finds static, dynamic, require, export-from, bare forms", () => {
  const src = `
    import a from "pkg-a";
    import { b } from "pkg-b";
    import type { T } from "pkg-c";
    export { x } from "pkg-d";
    const m = await import("pkg-e");
    const r = require("pkg-f");
    import "pkg-g";
    const dyn = await import(\`pkg-h\`);
  `;
  const got = new Set(rules.extractImports(src));
  for (const p of ["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e", "pkg-f", "pkg-g", "pkg-h"]) {
    assert.ok(got.has(p), `expected ${p}`);
  }
});

test("a specifier inside a comment is NOT counted", () => {
  const src = `// import x from "@/lib/secret"\n/* require("@cinatra-ai/objects") */\nimport ok from "real-pkg";`;
  const got = rules.extractImports(src);
  assert.deepEqual(got, ["real-pkg"]);
});

test("a specifier inside a string literal is NOT counted (the false-positive guard)", () => {
  const src = `const note = "require('@cinatra-ai/objects')"; const j = 'import x from "@/evil"'; import ok from "real-pkg";`;
  const got = rules.extractImports(src);
  assert.deepEqual(got, ["real-pkg"]);
});

test("a // inside a string does not start a comment that hides following code", () => {
  const src = `const u = "http://example.com"; import ok from "real-pkg";`;
  assert.deepEqual(rules.extractImports(src), ["real-pkg"]);
});

test("a /* inside a line comment does not swallow following imports", () => {
  const src = `// a /* not a block start\nimport ok from "real-pkg";`;
  assert.deepEqual(rules.extractImports(src), ["real-pkg"]);
});

// ---------------------------------------------------------------------------
// classifySpecifier.

test("classifySpecifier buckets host-alias, sdk, first-party, third-party, self, relative", () => {
  const self = "@cinatra-ai/my-ext";
  assert.equal(rules.classifySpecifier("@/lib/x", self), "host-alias");
  assert.equal(rules.classifySpecifier("@cinatra-ai/sdk-extensions", self), "sdk");
  assert.equal(rules.classifySpecifier("@cinatra-ai/sdk-extensions/test-host-context", self), "sdk");
  // sdk-ui is ALSO a permitted SDK package (codex MUST-FIX) — incl. subpaths.
  assert.equal(rules.classifySpecifier("@cinatra-ai/sdk-ui", self), "sdk");
  assert.equal(rules.classifySpecifier("@cinatra-ai/sdk-ui/marketplace", self), "sdk");
  // host-scope IMPORTS are coupling violations (resolved at runtime, never
  // imported) — flagged like cinatra's import-ban (codex round-16).
  assert.equal(rules.classifySpecifier("@cinatra-ai/host", self), "non-sdk-first-party");
  assert.equal(rules.classifySpecifier("@cinatra-ai/host:nango", self), "non-sdk-first-party");
  assert.equal(rules.classifySpecifier("@cinatra-ai/objects", self), "non-sdk-first-party");
  assert.equal(rules.classifySpecifier("@cinatra-ai/other-ext", self), "non-sdk-first-party");
  // mcp-client is a host PEER but NOT an SDK package → import-ban first-party.
  assert.equal(rules.classifySpecifier("@cinatra-ai/mcp-client", self), "non-sdk-first-party");
  assert.equal(rules.classifySpecifier("react", self), "third-party");
  assert.equal(rules.classifySpecifier("node:fs", self), "node");
  assert.equal(rules.classifySpecifier("@cinatra-ai/my-ext", self), "self");
  assert.equal(rules.classifySpecifier("./local", self), "relative");
});

test("a literal IMPORT of the host scope is a coupling violation (codex round-16)", () => {
  assert.equal(rules.checkImportBan({ name: "@cinatra-ai/x" }, { "src/a.ts": `import { n } from "@cinatra-ai/host:nango";` }).length, 1);
  assert.equal(rules.checkImportBan({ name: "@cinatra-ai/x" }, { "src/a.ts": `import { h } from "@cinatra-ai/host";` }).length, 1);
});

test("sdk-ui is an allowed dep; mcp-client host-peer value import is banned", () => {
  // sdk-ui as a package.json dep is allowed.
  assert.equal(rules.checkDepsSdkOnly({ dependencies: { "@cinatra-ai/sdk-ui": "^1" } }).length, 0);
  // host-peer value imports cover all THREE HOST_PEERS.
  assert.equal(rules.sdkValueImports(`import { x } from "@cinatra-ai/sdk-ui";`).length, 1);
  assert.equal(rules.sdkValueImports(`import { x } from "@cinatra-ai/mcp-client";`).length, 1);
  assert.equal(rules.sdkValueImports(`import type { T } from "@cinatra-ai/sdk-ui";`).length, 0);
});

test("require member / optional-call forms are caught (codex round-17 MUST-FIX)", () => {
  const SDK = "@cinatra-ai/sdk-extensions";
  assert.equal(rules.sdkValueImports(`const x = module.require("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`const y = require?.("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`const z = module.require?.("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`const w = await import?.("${SDK}");`).length, 1);
  assert.ok(rules.checkImportBan({ name: "@cinatra-ai/x" }, { "src/a.ts": `const x = module.require("@cinatra-ai/objects");` }).length >= 1);
});

test("dynamic import/require with import-attributes / extra args / trailing comma is caught (codex round-19 MUST-FIX)", () => {
  const SDK = "@cinatra-ai/sdk-extensions";
  assert.equal(rules.sdkValueImports(`await import("${SDK}", { with: {} })`).length, 1);
  assert.equal(rules.sdkValueImports(`require("${SDK}",)`).length, 1);
  assert.equal(rules.sdkValueImports(`module.require("${SDK}", undefined)`).length, 1);
  // type-query (member after the close paren) is still exempt even with no extra args
  assert.equal(rules.sdkValueImports(`type T = import("${SDK}").Foo;`).length, 0);
});

test("bare side-effect host-peer import is a value edge, with or without a semicolon (codex rounds 13-14)", () => {
  assert.equal(rules.sdkValueImports(`import "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`import "@cinatra-ai/sdk-ui";`).length, 1);
  assert.equal(rules.sdkValueImports(`import "@cinatra-ai/mcp-client";`).length, 1);
  assert.equal(rules.sdkValueImports(`import "react";`).length, 0);
  // no trailing semicolon (ASI)
  assert.equal(rules.sdkValueImports(`import "@cinatra-ai/sdk-extensions"\nexport function register(){}`).length, 1);
});

test("a comment between `from`/`import` and the specifier does not hide the edge (codex round-14 MUST-FIX)", () => {
  assert.ok(rules.extractImports(`import { x } from/**/"@cinatra-ai/objects";`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`import/**/"@cinatra-ai/sdk-extensions";`).includes("@cinatra-ai/sdk-extensions"));
  assert.equal(rules.sdkValueImports(`import { x } from/**/"@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`export { x } from/**/"@cinatra-ai/sdk-ui";`).length, 1);
});

test("no-whitespace import/export forms are caught (codex round-15 MUST-FIX)", () => {
  assert.ok(rules.extractImports(`import{x}from"@cinatra-ai/objects"`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`import"@cinatra-ai/sdk-extensions"`).includes("@cinatra-ai/sdk-extensions"));
  assert.ok(rules.extractImports(`export{x}from"@cinatra-ai/sdk-ui"`).includes("@cinatra-ai/sdk-ui"));
  assert.equal(rules.sdkValueImports(`import{x}from"@cinatra-ai/sdk-extensions"`).length, 1);
  assert.equal(rules.sdkValueImports(`import"@cinatra-ai/sdk-ui"`).length, 1);
});

test("division after a string/template/regex/postfix does not hide a dynamic import (codex round-15 MUST-FIX)", () => {
  assert.ok(rules.extractImports(`"a" / await import("@cinatra-ai/objects")`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports("`a` / await import(\"@cinatra-ai/objects\")").includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`i++ / await import("@cinatra-ai/objects")`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`x-- / require("@cinatra-ai/objects")`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`/a/ / await import("@cinatra-ai/objects")`).includes("@cinatra-ai/objects"));
});

test("serverEntry graph trace: a `.test.`-named helper reached from serverEntry is scanned (codex round-15 MUST-FIX)", () => {
  const readme = "x".repeat(300) + "\n\n## Capabilities\n- a\n- b\n";
  const a = rules.conformExtensionPackage({
    pkg: { name: "@cinatra-ai/x", license: "Apache-2.0", cinatra: { kind: "connector", serverEntry: "./register" }, exports: { "./register": "./src/register.mjs" } },
    sources: { "src/register.mjs": `import "./helper.test.mjs"; export function register(){}`, "src/helper.test.mjs": `import { foo } from "@cinatra-ai/sdk-extensions";` },
    files: new Set(["src/register.mjs", "src/helper.test.mjs"]),
    readme,
  });
  assert.ok(a.findings.some((f) => f.id === "host-peer-value-import"));
  // an UNRELATED test file (not in the serverEntry graph) is still allowed
  const b = rules.conformExtensionPackage({
    pkg: { name: "@cinatra-ai/x", license: "Apache-2.0", cinatra: { kind: "connector", serverEntry: "./register" }, exports: { "./register": "./src/register.mjs" } },
    sources: { "src/register.mjs": `import type { T } from "@cinatra-ai/sdk-extensions"; export function register(){}`, "src/__tests__/unrelated.test.mjs": `import { foo } from "@cinatra-ai/sdk-extensions";` },
    files: new Set(["src/register.mjs"]),
    readme,
  });
  assert.equal(b.findings.filter((f) => f.id === "host-peer-value-import").length, 0);
});

test("isSourceFile covers .cts / .mts (parity: cinatra SOURCE_EXTENSIONS, codex round-13)", () => {
  for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
    assert.ok(rules.isSourceFile(`src/${f}`), `expected source: ${f}`);
  }
  assert.ok(!rules.isSourceFile("src/a.json"));
});

test("the serverEntry artifact is host-peer-scanned even when `.test.`-named; normal test files are not (codex round-13)", () => {
  const readme = "x".repeat(300) + "\n\n## Capabilities\n- a\n- b\n";
  // serverEntry resolves to a `.test.`-named artifact that value-imports the SDK → caught.
  const a = rules.conformExtensionPackage({
    pkg: { name: "@cinatra-ai/x", license: "Apache-2.0", cinatra: { kind: "connector", serverEntry: "./register" }, exports: { "./register": "./compiled/register.test.mjs" } },
    sources: { "compiled/register.test.mjs": `import { foo } from "@cinatra-ai/sdk-extensions"; export function register(){}` },
    files: new Set(["compiled/register.test.mjs"]),
    readme,
  });
  assert.ok(a.findings.some((f) => f.id === "host-peer-value-import"));
  // a NORMAL test file value-importing the SDK harness is still allowed.
  const b = rules.conformExtensionPackage({
    pkg: { name: "@cinatra-ai/x", license: "Apache-2.0", cinatra: { kind: "connector", serverEntry: "./register" }, exports: { "./register": "./src/register.mjs" } },
    sources: { "src/register.mjs": `import type { T } from "@cinatra-ai/sdk-extensions"; export function register(){}`, "src/__tests__/a.test.mjs": `import { x } from "@cinatra-ai/sdk-extensions";` },
    files: new Set(["src/register.mjs"]),
    readme,
  });
  assert.equal(b.findings.filter((f) => f.id === "host-peer-value-import").length, 0);
});

test("escaped specifiers are decoded and still caught (codex MUST-FIX)", () => {
  assert.ok(rules.extractImports(`const r = require("\\x40cinatra-ai/objects");`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`import x from "\\u0040cinatra-ai/objects";`).includes("@cinatra-ai/objects"));
});

test("legacy octal escapes are decoded so an obfuscated specifier is still caught (codex round-20 MUST-FIX)", () => {
  // \100 = '@'
  assert.ok(rules.extractImports(`require("\\100cinatra-ai/sdk-extensions")`).includes("@cinatra-ai/sdk-extensions"));
  assert.equal(rules.sdkValueImports(`require("\\100cinatra-ai/sdk-extensions")`).length, 1);
});

test("string LINE CONTINUATIONS are decoded so an obfuscated specifier is still caught (codex round-12 MUST-FIX)", () => {
  const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
  assert.ok(rules.extractImports(`import x from "@\\${LF}/lib/x";`).includes("@/lib/x"));
  assert.ok(rules.extractImports(`import y from "@cinatra-ai\\${LF}/objects";`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`import z from "@cinatra-ai\\${CR}${LF}/sdk-extensions";`).includes("@cinatra-ai/sdk-extensions"));
  assert.equal(rules.sdkValueImports(`import { foo } from "@cinatra-ai\\${LF}/sdk-extensions";`).length, 1);
});

test("regex literal after a keyword is not mistaken for code (codex MUST-FIX)", () => {
  const src = `function f() { return /import x from "@cinatra-ai\\/objects"/; }\nimport ok from "real";`;
  assert.deepEqual(rules.extractImports(src), ["real"]);
});

test("realistic regex literals after `)` / `]` do not fabricate imports; division is fine", () => {
  // Common real regexes (no import-STATEMENT body) after `)`/`]` are not fabricated.
  assert.deepEqual(rules.extractImports(`if (s.match(/from "x"/)) {}\nimport ok from "real";`), ["real"]);
  assert.deepEqual(rules.extractImports(`const m = arr[0].replace(/[a-z]/g, "");\nimport ok from "real";`), ["real"]);
  assert.deepEqual(rules.extractImports(`const y = a / b;\nimport ok from "real";`), ["real"]); // division
  // DOCUMENTED ACCEPTED TRADEOFF (codex rounds 3+11): a regex literal whose BODY is
  // a literal `import … from "pkg"` STATEMENT, written right after `)`/`]`, is the
  // one rare FALSE-POSITIVE — the gate resolves the undecidable `)`-then-`/`
  // ambiguity toward DIVISION so it can NEVER HIDE a real `f() / (await import(…))`
  // (a trust-boundary false-negative is worse than a fixable false-positive).
  assert.ok(rules.extractImports(`if (ok) /import x from "@x\\/y"/.test(s);`).includes("@x/y"));
});

test("division after `)` / `]` does NOT hide a real dynamic import — incl. wrapped/parenthesized (codex rounds 10-11 MUST-FIX)", () => {
  assert.ok(rules.extractImports(`const x = f() / await import("@cinatra-ai/objects");`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`const y = arr[0] / require("@cinatra-ai/objects");`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`const q = f() / import("@cinatra-ai/objects");`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`f() / (await import("@cinatra-ai/objects"))`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`arr[0] / (require("@cinatra-ai/objects"))`).includes("@cinatra-ai/objects"));
  assert.ok(rules.extractImports(`f() / foo(import("@cinatra-ai/sdk-extensions"))`).includes("@cinatra-ai/sdk-extensions"));
  // a genuine regex after an operator/keyword still does not fabricate
  assert.deepEqual(rules.extractImports(`return /import y from "z"/;\nimport ok from "real";`), ["real"]);
  assert.deepEqual(rules.extractImports(`const re = /["@\\/lib]/g;\nimport ok from "real";`), ["real"]);
});

test("TS `import()` type query is NOT a host-peer value import; ambiguous/value positions ARE (codex rounds 3-5)", () => {
  const SDK = "@cinatra-ai/sdk-extensions";
  // unambiguous TS type positions with a `.Member` pick → exempt
  assert.equal(rules.sdkValueImports(`type T = import("${SDK}").ExtensionHostContext;`).length, 0);
  assert.equal(rules.sdkValueImports(`let x: import("${SDK}").Foo;`).length, 0);
  assert.equal(rules.sdkValueImports(`function f(a: import("${SDK}").Foo){}`).length, 0);
  // value positions (and anything ambiguous) → flagged (a gate errs toward value)
  assert.equal(rules.sdkValueImports(`const m = await import("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`import("${SDK}").then((x) => x);`).length, 1);
  assert.equal(rules.sdkValueImports(`const t = import("${SDK}").then;`).length, 1);
  assert.equal(rules.sdkValueImports(`const x = cond ? null : import("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`const x = cond ? a : import("${SDK}").then;`).length, 1);
  assert.equal(rules.sdkValueImports(`const x = { m: import("${SDK}") };`).length, 1);
  assert.equal(rules.sdkValueImports(`const t = typeof import("${SDK}");`).length, 1);
  assert.equal(rules.sdkValueImports(`class C extends import("${SDK}") {}`).length, 1);
});

// ---------------------------------------------------------------------------
// host-peer value-import ban.

test("sdkValueImports: only a DECLARATION `import type` is erased; inline `type` keeps the runtime edge (verbatim parity, codex round-10)", () => {
  assert.equal(rules.sdkValueImports(`import type { T } from "@cinatra-ai/sdk-extensions";`).length, 0); // declaration import type → erased
  // inline `type` specifiers STILL load the module at runtime under verbatim/Node
  // type-stripping → VALUE edge (cinatra parseModuleImports isValueEdge=true).
  assert.equal(rules.sdkValueImports(`import { type A, type B } from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`import {} from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`import { foo } from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`import def from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`import * as ns from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`const m = await import("@cinatra-ai/sdk-extensions");`).length, 1);
  assert.equal(rules.sdkValueImports(`const m = require("@cinatra-ai/sdk-extensions");`).length, 1);
  assert.equal(rules.sdkValueImports(`import x from "react";`).length, 0); // non-peer
});

test("sdkValueImports flags `export … from SDK`; only DECLARATION `export type` is erased (codex round-10)", () => {
  assert.equal(rules.sdkValueImports(`export { foo } from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`export * from "@cinatra-ai/sdk-extensions";`).length, 1);
  assert.equal(rules.sdkValueImports(`export type { T } from "@cinatra-ai/sdk-extensions";`).length, 0); // declaration → erased
  assert.equal(rules.sdkValueImports(`export { type T } from "@cinatra-ai/sdk-extensions";`).length, 1); // inline type → value edge
});

test("lexer: regex literals + interpolated imports (codex MUST-FIX)", () => {
  // a regex literal containing quotes does not hide a following real import
  assert.deepEqual(rules.extractImports(`const re = /["'\`]/g;\nimport ok from "real";`), ["real"]);
  // regex text that LOOKS like an import is not flagged
  assert.deepEqual(rules.extractImports(`const re = /import x from "@cinatra-ai\\/objects"/;\nimport ok from "real";`), ["real"]);
  // an import() inside a template interpolation IS caught
  assert.ok(rules.extractImports("const x = `a ${await import(\"@cinatra-ai/objects\")} b`;").includes("@cinatra-ai/objects"));
  // division is not mistaken for a regex
  assert.deepEqual(rules.extractImports(`const y = a / b / c;\nimport ok from "real";`), ["real"]);
});

test("hasParentEscape: blocks `..` segments, allows embedded dots (codex NIT)", () => {
  assert.ok(rules.hasParentEscape("../x"));
  assert.ok(rules.hasParentEscape("a/../b"));
  assert.ok(!rules.hasParentEscape("foo..bar.mjs"));
  assert.equal(rules.resolveExportSubpath({ "./x": "./foo..bar.mjs" }, "./x"), "./foo..bar.mjs");
  assert.equal(rules.resolveExportSubpath({ "./x": "../evil.mjs" }, "./x"), null);
});

// ---------------------------------------------------------------------------
// manifest / deps / license / readme / serverEntry unit rules.

test("checkManifestShape rejects bad kind/ports/abi/deps/serverEntry", () => {
  const errs = rules.checkManifestShape({
    cinatra: {
      kind: "frob",
      requestedHostPorts: ["nango", "nope"],
      sdkAbiRange: "garbage!!",
      dependencies: [{ packageName: "x" }],
      serverEntry: "/abs/escape",
    },
  });
  const ids = new Set(errs.map((e) => e.id));
  for (const id of ["manifest-kind", "manifest-ports", "manifest-abi", "manifest-deps", "manifest-serverentry"]) {
    assert.ok(ids.has(id), `expected ${id}`);
  }
});

test("checkManifestShape accepts a well-formed manifest", () => {
  const errs = rules.checkManifestShape({
    cinatra: {
      kind: "connector",
      requestedHostPorts: ["nango", "capabilities"],
      sdkAbiRange: "^2.2.0",
      serverEntry: "./register",
      dependencies: [
        { packageName: "@cinatra-ai/email-connector", kind: "connector", edgeType: "runtime", requirement: "required", versionConstraint: { kind: "semver-range", range: "^1.0.0" } },
      ],
    },
  });
  assert.deepEqual(errs, []);
});

test("isValidSdkAbiRange accepts ranges, rejects junk", () => {
  for (const ok of ["^2.2.0", "~1.0", ">=2.0.0 <3.0.0", "2.0.0 - 2.5.0", "1.x", "2.0 || 3.0", "*"]) {
    assert.ok(rules.isValidSdkAbiRange(ok), `expected valid: ${ok}`);
  }
  for (const bad of ["", "garbage!!", "not a range", "1,2,3", "<<>>"]) {
    assert.ok(!rules.isValidSdkAbiRange(bad), `expected invalid: ${bad}`);
  }
});

test("checkDepsSdkOnly flags non-SDK first-party + host scope, allows SDK + third-party", () => {
  const errs = rules.checkDepsSdkOnly({
    dependencies: { "@cinatra-ai/sdk-extensions": "^2", "@cinatra-ai/objects": "^1", react: "^18" },
    peerDependencies: { "@cinatra-ai/host": "*" },
  });
  const ids = new Set(errs.map((e) => e.id));
  assert.ok(ids.has("deps-sdk-only"));
  assert.ok(ids.has("deps-host-scope"));
  assert.equal(errs.length, 2);
});

test("checkLicense requires a plausible SPDX id", () => {
  assert.equal(rules.checkLicense({ license: "Apache-2.0" }).length, 0);
  assert.equal(rules.checkLicense({ license: "GPL-2.0-or-later" }).length, 0);
  assert.equal(rules.checkLicense({ license: "Apache-2.0 OR MIT" }).length, 0);
  assert.equal(rules.checkLicense({}).length, 1);
  assert.equal(rules.checkLicense({ license: "" }).length, 1);
  assert.equal(rules.checkLicense({ license: "not a license !!" }).length, 1);
});

test("checkReadme enforces bytes, required + allowed H2", () => {
  assert.equal(rules.checkReadme({}, {}, null)[0].id, "readme-missing");
  const tooShort = "tiny";
  assert.ok(rules.checkReadme({}, {}, tooShort).some((e) => e.id === "readme-too-short"));
  const badH2 = "x".repeat(300) + "\n\n## Installation\n\n## Capabilities\n";
  assert.ok(rules.checkReadme({}, {}, badH2).some((e) => e.id === "readme-h2"));
  const missingReq = "x".repeat(300) + "\n\n## Works with\n";
  assert.ok(rules.checkReadme({}, {}, missingReq).some((e) => e.id === "readme-required-h2"));
});

test("checkServerEntryPreflight requires exports + the built artifact", () => {
  // missing exports
  let errs = rules.checkServerEntryPreflight({ cinatra: { serverEntry: "./register" } }, new Set());
  assert.ok(errs.some((e) => e.id === "serverentry-exports"));
  // exports present but artifact missing
  errs = rules.checkServerEntryPreflight(
    { cinatra: { serverEntry: "./register" }, exports: { "./register": "./dist/register.mjs" } },
    new Set(),
  );
  assert.ok(errs.some((e) => e.id === "serverentry-artifact"));
  // artifact present → clean
  errs = rules.checkServerEntryPreflight(
    { cinatra: { serverEntry: "./register" }, exports: { "./register": "./dist/register.mjs" } },
    new Set(["dist/register.mjs"]),
  );
  assert.deepEqual(errs, []);
});

// ---------------------------------------------------------------------------
// CLI end-to-end against the fixtures.

test("CLI passes the good-connector fixture (incl. register-probe)", () => {
  const r = runCli(["--package", join(FIX, "good-connector"), "--register-probe"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /conforms to the extension→host IoC contract/);
});

test("CLI passes the good-agent fixture (no false positives from comment/string)", () => {
  const r = runCli(["--package", join(FIX, "good-agent")]);
  assert.equal(r.code, 0, r.stdout);
});

test("CLI fails the bad-connector fixture with the expected finding ids", () => {
  const r = runCli(["--package", join(FIX, "bad-connector"), "--format", "json"]);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  const ids = new Set(parsed.findings.map((f) => f.id));
  for (const id of [
    "manifest-kind", "manifest-ports", "manifest-abi", "manifest-deps",
    "import-ban-host-alias", "import-ban-first-party", "host-peer-value-import",
    "deps-sdk-only", "readme-missing", "license-missing",
  ]) {
    assert.ok(ids.has(id), `expected finding ${id}`);
  }
});

test("CLI exits 2 on a missing package dir", () => {
  const r = runCli(["--package", join(FIX, "does-not-exist")]);
  assert.equal(r.code, 2);
});

test("register-probe: a register that THROWS fails via the exit-code verdict, even when forging a summary (codex MUST-FIX)", () => {
  const r = runCli(["--package", join(FIX, "evil-exit"), "--register-probe", "--format", "json"]);
  assert.equal(r.code, 1, r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.findings.some((f) => f.id === "register-probe"), "expected a register-probe finding");
});

test("register-probe: patching process.exit / builtins cannot forge a pass — worker uses the captured real exit (codex MUST-FIX)", () => {
  const r = runCli(["--package", join(FIX, "evil-forge"), "--register-probe", "--format", "json"]);
  assert.equal(r.code, 1, r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.findings.some((f) => f.id === "register-probe"), "a patched process.exit must not flip the exit-code verdict");
});

// ---------------------------------------------------------------------------
// THE REAL CROSS-REPO PARITY TEST (issue #156: "a REAL cross-repo parity test
// against the monorepo gates — not a comment").
//
// The reusable gate generalizes the cinatra monorepo's per-package IoC contract.
// Its pinned contract constants (host ports, kinds, dependency edge grammar,
// README card bounds) and its consumed substrate (the byte-identical vendored
// test-host-context.mjs) MUST track the cinatra source of truth — a divergence
// would let an extension pass the org-wide gate while failing the host. This
// test reads the cinatra source DIRECTLY (checked out at $CINATRA_REPO in CI by
// the parity job; skipped with a loud notice when absent locally) and asserts
// every pinned value matches. If either side changes a rule, this fails.
//
// This is the build-server-entry §4.1 lockstep-pin precedent: ONE shared truth,
// asserted across the repo boundary, not a daily detection-only diff.

// The files the parity test reads from the cinatra checkout. cinatraRoot() only
// returns a root where ALL of them exist, so a partial/sparse checkout missing a
// source file FAILS CLOSED (it does not silently resolve to "absent" and skip).
const CINATRA_REQUIRED_FILES = [
  "packages/sdk-extensions/src/test-host-context.mjs",
  "packages/sdk-extensions/src/host-context.ts",
  "packages/sdk-extensions/src/dependencies.ts",
  "scripts/audit/extension-readme-gate.mjs",
  "scripts/audit/host-peer-value-import-ban.mjs",
  "scripts/extensions/inventory.mjs",
];

function hasAllParitySources(root) {
  return root != null && CINATRA_REQUIRED_FILES.every((f) => existsSync(join(root, f)));
}

function cinatraRoot() {
  const env = process.env.CINATRA_REPO;
  if (env && hasAllParitySources(env)) return env;
  // Local-dev convenience: a sibling clone next to this worktree.
  const sibling = join(REPO_ROOT, "..", "sdk156-cinatra");
  if (hasAllParitySources(sibling)) return sibling;
  return null;
}

// In the dedicated parity CI job (which checks out cinatra) CINATRA_REQUIRED=1 is
// set so the test FAILS CLOSED if the source is unavailable, instead of skipping
// green (codex MUST-FIX). Locally, with no cinatra clone, it skips.
function paritySkipReason() {
  if (cinatraRoot()) return false;
  if (process.env.CINATRA_REQUIRED === "1") return false; // run → fail loudly below
  return "CINATRA_REPO not available (set in the parity CI job)";
}

/** Extract a string-array literal assigned to NAME — handles both
 * `const NAME = [ ... ]` and `const NAME = new Set([ ... ])`. */
function extractStringArrayConst(srcText, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[([\\s\\S]*?)\\]`, "m");
  const m = srcText.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
}

/** Extract the discriminant `kind: "…"` literals from the `VersionConstraint`
 * TS union type declaration in dependencies.ts. The union spans multiple lines
 * with `;` inside each member's braces, so capture through the TERMINATING `;`
 * (one at end-of-line), not the first inner `;`. */
function extractVersionConstraintKinds(srcText) {
  const m = srcText.match(/export type VersionConstraint\s*=([\s\S]*?;\s*$)/m);
  if (!m) return [];
  return [...new Set([...m[1].matchAll(/kind:\s*["']([^"']+)["']/g)].map((x) => x[1]))];
}

test("PARITY: ci gate constants + substrate match the cinatra source of truth", { skip: paritySkipReason() }, () => {
  const root = cinatraRoot();
  // Fail closed: when the job marks parity REQUIRED but the source is missing,
  // do NOT pass silently (codex MUST-FIX).
  assert.ok(root, "CINATRA_REQUIRED=1 but the cinatra parity sources are not all present — the checkout is incomplete");

  // 1. The vendored substrate is BYTE-IDENTICAL to the SDK source (#163).
  const vendored = readFileSync(join(REPO_ROOT, "scripts", "lib", "vendor", "test-host-context.mjs"));
  const sdkSrc = readFileSync(join(root, "packages", "sdk-extensions", "src", "test-host-context.mjs"));
  assert.ok(vendored.equals(sdkSrc), "vendored test-host-context.mjs has drifted from the SDK source — re-vendor it");

  // 2. HOST_PORT_NAMES — the SDK type-only host-context source of truth.
  const hostCtx = readFileSync(join(root, "packages", "sdk-extensions", "src", "host-context.ts"), "utf8");
  const cinatraPorts = extractStringArrayConst(hostCtx, "HOST_PORT_NAMES");
  assert.ok(cinatraPorts && cinatraPorts.length > 0, "could not read HOST_PORT_NAMES from cinatra");
  assert.deepEqual([...rules.HOST_PORT_NAMES].sort(), [...cinatraPorts].sort(), "HOST_PORT_NAMES drift vs cinatra host-context");

  // 3. Extension kinds.
  const deps = readFileSync(join(root, "packages", "sdk-extensions", "src", "dependencies.ts"), "utf8");
  const cinatraKinds = extractStringArrayConst(deps, "EXTENSION_KINDS");
  assert.deepEqual([...rules.VALID_KINDS].sort(), [...cinatraKinds].sort(), "VALID_KINDS drift vs cinatra EXTENSION_KINDS");

  // 3b. SDK package allowlist (inventory.SDK_PACKAGES) + host-peer set
  // (host-peer-value-import-ban.HOST_PEERS) — codex MUST-FIX: the gate must allow
  // EXACTLY what cinatra allows (sdk-extensions + sdk-ui), and ban value imports
  // of exactly the host peers (… + mcp-client).
  const invForSets = readFileSync(join(root, "scripts", "extensions", "inventory.mjs"), "utf8");
  const cinatraSdkPkgs = extractStringArrayConst(invForSets, "SDK_PACKAGES");
  assert.deepEqual([...rules.SDK_PACKAGES].sort(), [...cinatraSdkPkgs].sort(), "SDK_PACKAGES drift vs cinatra inventory.SDK_PACKAGES");
  const hostPeerGate = readFileSync(join(root, "scripts", "audit", "host-peer-value-import-ban.mjs"), "utf8");
  const cinatraHostPeers = extractStringArrayConst(hostPeerGate, "HOST_PEERS");
  assert.deepEqual([...rules.HOST_PEERS].sort(), [...cinatraHostPeers].sort(), "HOST_PEERS drift vs cinatra host-peer-value-import-ban.HOST_PEERS");

  // 4. Dependency edge grammar (edge types, requirements, version-constraint kinds).
  const cinatraEdgeTypes = extractStringArrayConst(deps, "DEPENDENCY_EDGE_TYPES");
  assert.deepEqual([...rules.EDGE_TYPES].sort(), [...cinatraEdgeTypes].sort(), "EDGE_TYPES drift vs cinatra DEPENDENCY_EDGE_TYPES");
  const cinatraReqs = extractStringArrayConst(deps, "DEPENDENCY_REQUIREMENTS");
  assert.deepEqual([...rules.REQUIREMENTS].sort(), [...cinatraReqs].sort(), "REQUIREMENTS drift vs cinatra DEPENDENCY_REQUIREMENTS");

  // 5. README marketplace-card contract — the cinatra readme gate source.
  const readmeGate = readFileSync(join(root, "scripts", "audit", "extension-readme-gate.mjs"), "utf8");
  const minM = readmeGate.match(/README_MIN_BYTES\s*=\s*(\d+)/);
  const maxM = readmeGate.match(/README_MAX_BYTES\s*=\s*(\d+)/);
  assert.ok(minM && maxM, "could not read README byte bounds from cinatra readme gate");
  assert.equal(rules.README_MIN_BYTES, Number(minM[1]), "README_MIN_BYTES drift vs cinatra");
  assert.equal(rules.README_MAX_BYTES, Number(maxM[1]), "README_MAX_BYTES drift vs cinatra");
  const cinatraAllowedH2 = extractStringArrayConst(readmeGate, "ALLOWED_H2");
  assert.deepEqual([...rules.ALLOWED_H2].sort(), [...cinatraAllowedH2].sort(), "ALLOWED_H2 drift vs cinatra readme gate");
  const cinatraRequiredH2 = extractStringArrayConst(readmeGate, "REQUIRED_H2");
  assert.deepEqual([...rules.REQUIRED_H2].sort(), [...cinatraRequiredH2].sort(), "REQUIRED_H2 drift vs cinatra readme gate");

  // 6. The dependency-validity LOGIC matches inventory.isValidExtensionDependency:
  // the same well-formed edge passes both, and the same malformed edge fails both.
  const inv = readFileSync(join(root, "scripts", "extensions", "inventory.mjs"), "utf8");
  const cinatraEdgeSet = extractStringArrayConst(inv, "VALID_DEPENDENCY_EDGE_TYPES");
  assert.deepEqual([...rules.EDGE_TYPES].sort(), [...cinatraEdgeSet].sort(), "EDGE_TYPES drift vs inventory.VALID_DEPENDENCY_EDGE_TYPES");
  // VersionConstraint is a TS union, not a const array — extract the `kind:`
  // discriminant literals from BOTH the type union (dependencies.ts) and the
  // runtime validator (inventory.isValidVersionConstraint's `vc.kind === "…"`
  // checks), and assert our pinned kinds EQUAL both (codex MUST-FIX: was a
  // hardcoded-fallback subset check that never actually asserted cross-repo).
  const vcTypeKinds = extractVersionConstraintKinds(deps);
  assert.ok(vcTypeKinds.length > 0, "could not read VersionConstraint kinds from dependencies.ts");
  assert.deepEqual([...rules.VERSION_CONSTRAINT_KINDS].sort(), [...vcTypeKinds].sort(), "VERSION_CONSTRAINT_KINDS drift vs cinatra VersionConstraint union");
  const vcRuntimeKinds = [...inv.matchAll(/vc\.kind\s*===\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(vcRuntimeKinds.length > 0, "could not read vc.kind checks from inventory.isValidVersionConstraint");
  assert.deepEqual([...rules.VERSION_CONSTRAINT_KINDS].sort(), [...new Set(vcRuntimeKinds)].sort(), "VERSION_CONSTRAINT_KINDS drift vs inventory.isValidVersionConstraint");

  // The well-formedness LOGIC matches: the canonical OBJECT shape passes, a
  // string versionConstraint (the old wrong shape) fails — same as inventory.
  assert.ok(rules.isWellFormedDependencyEdge({ packageName: "x", edgeType: "runtime", requirement: "required", versionConstraint: { kind: "semver-range", range: "^1" } }));
  assert.ok(!rules.isWellFormedDependencyEdge({ packageName: "x", edgeType: "runtime", requirement: "required", versionConstraint: "^1" }));
});
