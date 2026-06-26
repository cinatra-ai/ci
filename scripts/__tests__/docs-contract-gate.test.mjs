// Tests for the reusable integration docs-contract validator
// (cinatra-ai/ci#39): the rule library (pure functions) + the CLI driver against
// good/bad docs-tree fixtures. Node builtins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as rules from "../lib/docs-contract-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "scripts", "docs-contract-gate.mjs");
const FIX = join(__dirname, "..", "__fixtures__", "docs-contract");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function runJson(fixture, slug = "wordpress") {
  let out;
  try {
    out = execFileSync("node", [CLI, "--docs", join(FIX, fixture), "--slug", slug, "--format", "json"], { encoding: "utf8" });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    const stdout = e.stdout ?? "";
    return { code: e.status ?? 1, json: JSON.parse(stdout) };
  }
}

function findingIds(json) {
  return new Set((json.findings ?? []).map((f) => f.id));
}

// ---------------------------------------------------------------------------
// Contract constants — the spec twin must agree with docs#51.

test("the contract is the fixed 6-page set in the canonical order", () => {
  assert.deepEqual(rules.REQUIRED_PAGES, [
    "overview.md", "quick-start.md", "use-it.md",
    "settings-and-permissions.md", "troubleshooting.md", "advanced-and-reference.md",
  ]);
});

test("the required frontmatter schema matches the issue", () => {
  assert.deepEqual(rules.REQUIRED_FRONTMATTER, [
    "slug", "title", "description", "navOrder", "tier", "lifecycle",
    "cinatraCompat", "integrationVersion", "sourceRepo", "supportUrl", "marketplaceUrl",
  ]);
});

test("tier domain is first-party only; lifecycle is the four states", () => {
  assert.deepEqual([...rules.TIER_VALUES], ["first-party"]);
  assert.deepEqual([...rules.LIFECYCLE_VALUES].sort(), ["active", "deprecated", "draft", "retired"]);
});

// ---------------------------------------------------------------------------
// Frontmatter parser.

test("splitFrontmatter extracts the leading block and body", () => {
  const { frontmatter, body } = rules.splitFrontmatter("---\nslug: wp\n---\n# H1\ntext");
  assert.ok(frontmatter.includes("slug: wp"));
  assert.ok(body.startsWith("# H1"));
});

test("parseFrontmatter reads scalars, quoted strings, integers; rejects nesting/lists", () => {
  const fm = rules.parseFrontmatter('slug: wp\nnavOrder: 2\ntitle: "Quoted"\ncompat: \'>=1\'');
  assert.equal(fm.slug, "wp");
  assert.equal(fm.navOrder, 2);
  assert.equal(fm.title, "Quoted");
  assert.equal(fm.compat, ">=1");
  assert.throws(() => rules.parseFrontmatter("a:\n  b: 1"), /indented|nested/);
  assert.throws(() => rules.parseFrontmatter("a: [1,2]"), /lists, maps/);
});

// ---------------------------------------------------------------------------
// Content policy (MDX / code-exec ban) — code fences must NOT trip it.

test("checkContentPolicy flags import/export/JSX/expr outside code fences", () => {
  assert.ok(rules.checkContentPolicy('import x from "y"\n').length >= 1);
  assert.ok(rules.checkContentPolicy("export const a = 1\n").length >= 1);
  assert.ok(rules.checkContentPolicy("<Component />").length >= 1);
  assert.ok(rules.checkContentPolicy("value {expr}").length >= 1);
});

test("checkContentPolicy ignores import/JSX INSIDE a fenced code block", () => {
  const body = "before\n\n```js\nimport x from 'y';\nexport const z = <C/>;\n```\n\nafter";
  assert.deepEqual(rules.checkContentPolicy(body), []);
});

// --- adversarial MDX-ban bypasses (codex MUST-FIX round) ---

test("checkContentPolicy catches a MULTILINE import (from on a later line)", () => {
  const body = "import {\n  a,\n  b\n} from 'pkg'";
  assert.ok(rules.checkContentPolicy(body).length >= 1);
});

test("checkContentPolicy catches `export *` and a dotted JSX tag and a closing tag", () => {
  assert.ok(rules.checkContentPolicy("export * from 'x'").some((m) => /export/.test(m)));
  assert.ok(rules.checkContentPolicy("<Foo.Bar prop={1} />").some((m) => /JSX/.test(m)));
  assert.ok(rules.checkContentPolicy("</Component>").some((m) => /JSX/.test(m)));
});

test("checkContentPolicy catches a MULTILINE {…} expression", () => {
  assert.ok(rules.checkContentPolicy("text {\n  someExpr()\n} more").some((m) => /expression/.test(m)));
});

test("checkContentPolicy still fails closed on an UNCLOSED code fence hiding a later import", () => {
  // An attacker opens a fence to "hide" content; everything after stays hidden,
  // so they cannot reveal an import below it either — but an import BEFORE the
  // fence is still caught.
  const body = "import evil from 'x'\n\n```\nnot closed\nimport also from 'y'";
  assert.ok(rules.checkContentPolicy(body).some((m) => /import/.test(m)));
});

test("extractTargets finds reference-style defs and raw-HTML href/src", () => {
  const body = "[ref]: ../../escape.md\n\n<a href=\"file:///etc/passwd\">x</a>\n<img src=\"./assets/y.png\">";
  const { links } = rules.extractTargets(body);
  assert.ok(links.includes("../../escape.md"));
  assert.ok(links.includes("file:///etc/passwd"));
  assert.ok(links.includes("./assets/y.png"));
});

test("resolveRelative treats a backslash escape as an escape", () => {
  // `..\secret.md` normalizes to `../secret.md` from a root page → escapes.
  assert.equal(rules.resolveRelative("overview.md", "..\\secret.md"), null);
});

test("link regexes are linear on a wall of unmatched brackets (no quadratic blowup)", () => {
  const body = "[".repeat(200000);
  const t = Date.now();
  rules.extractTargets(body);
  rules.checkContentPolicy(body);
  assert.ok(Date.now() - t < 1500, "extraction took too long (possible ReDoS)");
});

test("parseFrontmatter rejects duplicate keys and YAML tags", () => {
  assert.throws(() => rules.parseFrontmatter("slug: a\nslug: b"), /duplicate/);
  assert.throws(() => rules.parseFrontmatter("x: !!str 1"), /YAML tags|unsupported/);
});

test("splitFrontmatter requires an EXACT `---` closing line", () => {
  // A `--- x` line is not a valid close → no frontmatter detected.
  const r = rules.splitFrontmatter("---\nslug: wp\n--- not a fence\n# body");
  assert.equal(r.frontmatter, null);
});

// --- round-2 adversarial bypasses (codex follow-up) ---

test("extractTargets finds a NESTED-label link and an UNQUOTED html href", () => {
  assert.deepEqual(rules.extractTargets("[see [advanced]](../outside.md)").links, ["../outside.md"]);
  assert.ok(rules.extractTargets("<a href=../outside.md>x</a>").links.includes("../outside.md"));
});

test("checkContentPolicy catches `<Foo_Bar/>` and a LONG `{…}` expression", () => {
  assert.ok(rules.checkContentPolicy("<Foo_Bar />").some((m) => /JSX/.test(m)));
  assert.ok(rules.checkContentPolicy("x {" + "a".repeat(5000) + "}").some((m) => /\{/.test(m) || /brace/.test(m)));
});

test("an escaped `\\{` literal brace is allowed (not flagged as MDX)", () => {
  assert.deepEqual(rules.checkContentPolicy("a literal \\{ brace"), []);
});

test("checkLinkTarget rejects a protocol-relative `//host` link", () => {
  const ctx = { localFiles: new Set(), pageRel: "overview.md", isImage: false };
  assert.match(rules.checkLinkTarget("//private.example/x", ctx), /protocol-relative/);
});

// --- round-3 adversarial bypasses (codex follow-up) ---

test("plain HTML <a>/<img> are allowed (not JSX components); lowercase-dotted/_/$ ARE banned", () => {
  assert.deepEqual(rules.checkContentPolicy('<a href="https://x">y</a>'), []);
  assert.deepEqual(rules.checkContentPolicy('<img src="./assets/x.png">'), []);
  assert.ok(rules.checkContentPolicy("<foo.Bar />").some((m) => /JSX/.test(m)));
  assert.ok(rules.checkContentPolicy("<_Foo />").some((m) => /JSX/.test(m)));
  assert.ok(rules.checkContentPolicy("<$Foo />").some((m) => /JSX/.test(m)));
});

test("http:// is rejected for both links and frontmatter URLs (https only)", () => {
  const ctx = { localFiles: new Set(), pageRel: "overview.md", isImage: false };
  assert.match(rules.checkLinkTarget("http://example.com/x", ctx), /scheme/);
  assert.equal(rules.checkLinkTarget("https://example.com/x", ctx), null);
  const findings = [];
  rules.validateFrontmatter("overview.md", {
    slug: "wordpress", title: "t", description: "d", navOrder: 1, tier: "first-party",
    lifecycle: "active", cinatraCompat: "1", integrationVersion: "1",
    sourceRepo: "http://example.com/repo", supportUrl: "https://x/s", marketplaceUrl: "https://x/m",
  }, "wordpress", (id, msg) => findings.push([id, msg]));
  assert.ok(findings.some(([id]) => id === "frontmatter-url"), "http sourceRepo should be flagged");
});

// ---------------------------------------------------------------------------
// Link policy.

test("checkLinkTarget allows fragments, https, root-absolute, in-docs relative", () => {
  const localFiles = new Set(["quick-start.md", "assets/x.png"]);
  const ctx = { localFiles, pageRel: "overview.md", isImage: false };
  assert.equal(rules.checkLinkTarget("#section", ctx), null);
  assert.equal(rules.checkLinkTarget("https://docs.cinatra.ai/guides/", ctx), null);
  assert.equal(rules.checkLinkTarget("/references/", ctx), null);
  assert.equal(rules.checkLinkTarget("./quick-start.md", ctx), null);
});

test("checkLinkTarget rejects ../ escape, non-https scheme, and dangling relative", () => {
  const localFiles = new Set(["overview.md"]);
  const ctx = { localFiles, pageRel: "overview.md", isImage: false };
  assert.match(rules.checkLinkTarget("../../guides/x.md", ctx), /escapes/);
  assert.match(rules.checkLinkTarget("file:///etc/passwd", ctx), /scheme/);
  assert.match(rules.checkLinkTarget("./nope.md", ctx), /does not resolve/);
});

test("resolveRelative returns null on docs-root escape", () => {
  assert.equal(rules.resolveRelative("overview.md", "../x.md"), null);
  assert.equal(rules.resolveRelative("overview.md", "./assets/x.png"), "assets/x.png");
});

// ---------------------------------------------------------------------------
// CLI end-to-end against fixtures.

test("CLI: good fixture conforms (exit 0)", () => {
  const r = runCli(["--docs", join(FIX, "good"), "--slug", "wordpress"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /conforms/);
});

test("CLI: missing-page fixture fails with missing-page", () => {
  const { code, json } = runJson("bad-missing-page");
  assert.equal(code, 1);
  assert.ok(findingIds(json).has("missing-page"));
});

test("CLI: bad-frontmatter fixture flags missing key, tier, lifecycle, navOrder, slug, url", () => {
  const { code, json } = runJson("bad-frontmatter");
  assert.equal(code, 1);
  const ids = findingIds(json);
  for (const id of ["frontmatter-missing", "frontmatter-tier", "frontmatter-lifecycle", "frontmatter-navorder", "frontmatter-slug-mismatch", "frontmatter-url"]) {
    assert.ok(ids.has(id), `expected finding ${id}, got ${[...ids].join(",")}`);
  }
});

test("CLI: bad-content fixture flags the MDX/code-exec policy", () => {
  const { code, json } = runJson("bad-content");
  assert.equal(code, 1);
  assert.ok(findingIds(json).has("content-policy"));
});

test("CLI: bad-links fixture flags escape + scheme + dangling", () => {
  const { code, json } = runJson("bad-links");
  assert.equal(code, 1);
  const msgs = (json.findings ?? []).filter((f) => f.id === "link").map((f) => f.message).join("\n");
  assert.match(msgs, /escapes/);
  assert.match(msgs, /scheme/);
  assert.match(msgs, /does not resolve/);
});

test("CLI: bad-assets fixture flags location + disallowed-type + too-large", () => {
  const { code, json } = runJson("bad-assets");
  assert.equal(code, 1);
  const ids = findingIds(json);
  assert.ok(ids.has("asset-location"));
  assert.ok(ids.has("disallowed-file"));
  assert.ok(ids.has("asset-too-large"));
});

test("CLI: slug mismatch is caught against the good tree with a different --slug", () => {
  const { code, json } = runJson("good", "drupal");
  assert.equal(code, 1);
  assert.ok(findingIds(json).has("frontmatter-slug-mismatch"));
});

test("CLI: missing --slug is a usage error (exit 2)", () => {
  const r = runCli(["--docs", join(FIX, "good")]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /--slug/);
});

test("CLI: missing docs dir is a usage error (exit 2)", () => {
  const r = runCli(["--docs", join(FIX, "does-not-exist"), "--slug", "wordpress"]);
  assert.equal(r.code, 2);
});
