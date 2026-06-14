// ---------------------------------------------------------------------------
// extension-ioc-rules — the SELF-CONTAINED, host-tree-INDEPENDENT extension→host
// IoC conformance rule library (cinatra-engineering#156).
//
// This is the generalization of the cinatra MONOREPO's per-package audit gates
// (`scripts/audit/extension-{import-ban,host-peer-value-import-ban,deps-gate,
// readme-gate,license-gate}.mjs` + the manifest schema in
// `packages/sdk-extensions/src/manifest.ts`) into a form that validates ONE
// extension package directory in isolation — Node builtins only, ZERO registry
// dependency, no host tree, no baselines, no `SCANNER_EPOCH`, no generated-file
// lists. It is the substrate the reusable `extension-ioc-gate.yml` workflow runs
// in any of the ~90 extension repos.
//
// WHY a separate library (and not the monorepo gates): the monorepo gates scan
// the WHOLE `extensions/` tree with host-derived inventory (`buildInventory()`),
// against PINNED-EMPTY baselines and a host-owned generated-manifest exempt set.
// Those are host-monorepo machinery by construction. The RULE each gate pins —
// "an extension must reach the host only through `register(ctx)`/`@cinatra-ai/*`,
// never via `@/`, another extension, or a non-SDK first-party package; its
// serverEntry graph keeps SDK imports type-only; its manifest is well-shaped;
// its README/license/kind conform" — is per-package and host-tree-independent.
// This library pins exactly that rule, per package, with no host substrate.
//
// SCOPE (issue #156): the EXTENSION→host direction ONLY. The core→extension
// direction (instance-coupling ban, core-import-ban, dispatcher-bypass,
// cover-gate equality, generated-map byte-pinning) is host-monorepo-specific
// (baselines / SCANNER_EPOCH / generated-file lists / lock equality) and stays
// in `cinatra/scripts/audit`, documented as host-side. Exporting it would export
// the migration machinery, not the rule.
//
// CONSUMES (does not duplicate) the #163 SDK validator substrate: the manifest
// port grammar is checked against `TEST_HOST_PORT_NAMES` imported from the
// byte-identical vendored `./vendor/test-host-context.mjs` (parity-guarded), and
// the optional `--register-probe` runs `createTestHostContext` from that same
// module so a clean local register here behaves the same way in production.
//
// KNOWN LIMITATION (matches the cinatra source of truth, NOT a divergence): like
// `inventory.scanSdkOnlyImportsInText` / `host-peer-value-import-ban`, this scans
// LITERAL specifiers. A computed/aliased specifier — `import("@" + "/lib/x")`, a
// package.json `imports` `#alias`, or an `npm:`-aliased dependency — is not
// statically resolved by EITHER the host gates or this one; that surface is
// covered by the host's runtime loader/install-time checks, not the lexical gate.
// ---------------------------------------------------------------------------

import { TEST_HOST_PORT_NAMES } from "./vendor/test-host-context.mjs";

// ---------------------------------------------------------------------------
// Shared contract constants (kept aligned with the monorepo source of truth;
// the cross-repo parity test fails if any of these drift from cinatra).

/** The 5 extension kinds (manifest.ts CinatraManifest["kind"]). */
export const VALID_KINDS = ["agent", "connector", "artifact", "skill", "workflow"];

/**
 * The canonical host-port names a manifest's `requestedHostPorts` is validated
 * against. SOURCE OF TRUTH is the #163 substrate (TEST_HOST_PORT_NAMES, which
 * mirrors host-context.HOST_PORT_NAMES) — imported, never re-listed, so we
 * cannot drift from the SDK.
 */
export const HOST_PORT_NAMES = [...TEST_HOST_PORT_NAMES];

/** The permitted first-party packages an extension may depend on / import — the
 * cinatra inventory `SDK_PACKAGES` allowlist (subpaths allowed). PINNED to the
 * cinatra source of truth and parity-guarded. */
export const SDK_PACKAGES = new Set(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui"]);
/** The primary SDK package (the #163 substrate lives here). */
export const SDK_PACKAGE = "@cinatra-ai/sdk-extensions";
/** The host-peer packages whose VALUE imports are banned over the serverEntry
 * graph (must stay type-only) — the cinatra `HOST_PEERS` set. Note `mcp-client`
 * is a host peer but NOT in SDK_PACKAGES, so a non-type import of it is also an
 * import-ban first-party violation. */
export const HOST_PEERS = new Set(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui", "@cinatra-ai/mcp-client"]);

/** The host-published per-concern service namespace (resolved at runtime, never imported). */
export const HOST_SERVICE_SCOPE = "@cinatra-ai/host";

/** The org scope under which first-party packages live (extension + host + SDK). */
export const FIRST_PARTY_SCOPE = "@cinatra-ai";

/** Valid dependency edge types / requirements / version-constraint kinds — the
 * canonical SDK `ExtensionDependency` contract (packages/sdk-extensions/src/
 * dependencies.ts; validated identically by inventory.isValidExtensionDependency).
 * These are PINNED to the cinatra source of truth and parity-guarded. */
export const EDGE_TYPES = ["runtime", "install-time", "peer"];
export const REQUIREMENTS = ["required", "optional"];
export const VERSION_CONSTRAINT_KINDS = ["semver-range", "exact", "git-ref"];

/** README marketplace-card contract (extension-readme-gate.mjs). */
export const README_MIN_BYTES = 250;
export const README_MAX_BYTES = 2500;
export const ALLOWED_H2 = ["Works with", "Capabilities"];
export const REQUIRED_H2 = ["Capabilities"];

/** sdkAbiRange grammar — a semver range using only the operators the loader's
 * ABI gate understands (caret/tilde/comparators, space-separated comparator
 * conjunctions, hyphen ranges, `x`/`*` wildcards, `||` unions). Deliberately a
 * STRUCTURAL grammar check, not a full semver parse: the host re-validates at
 * install; here we reject obvious junk so a malformed pin is caught at submit,
 * not at activation. */
// One version: a partial semver with optional v-prefix, x/* wildcards, prerelease.
const ABI_VERSION = String.raw`v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?`;
// One comparator term: optional operator + a version, OR a bare `*`/`x` wildcard.
const ABI_TERM = String.raw`(?:(?:\^|~|>=?|<=?|=)?\s*${ABI_VERSION}|[*xX])`;
// One range alternative: a hyphen range, OR a space-separated comparator conjunction.
const ABI_HYPHEN = String.raw`${ABI_VERSION}\s+-\s+${ABI_VERSION}`;
const ABI_ALT = String.raw`(?:${ABI_HYPHEN}|${ABI_TERM}(?:\s+${ABI_TERM})*)`;
const ABI_RANGE_RE = new RegExp(String.raw`^\s*${ABI_ALT}(?:\s*\|\|\s*${ABI_ALT})*\s*$`);

export function isValidSdkAbiRange(value) {
  return typeof value === "string" && value.trim().length > 0 && ABI_RANGE_RE.test(value);
}

// ---------------------------------------------------------------------------
// Import extraction — a self-contained, lexer-light scanner mirroring the
// monorepo `inventory.mjs` import-edge derivation: it catches static `import`/
// `export … from`, dynamic `import()`, `require()` and backtick `import(\`…\`)`
// forms, in BOTH value and `import type` positions, after stripping comments and
// strings so a specifier inside a COMMENT is not counted.
//
// Comment stripping is a single-pass, STRING-AWARE lexer (the monorepo's
// `strip-comments.mjs` discipline): a `//` or `/*` INSIDE a string/template
// literal is NOT treated as a comment (so it cannot hide following code), and a
// `/*` inside a line comment cannot swallow following code. String CONTENTS are
// PRESERVED — an import specifier IS a string literal, so deleting strings would
// delete every specifier; instead we only neutralize template interpolations so
// a `${…}` cannot fabricate or hide a specifier.

// A single, sentinel-pinned skeleton index. The sentinel marker is U+2400
// (SYMBOL FOR NULL) — printable, valid in source, and never used in real code;
// `tokenizeSource` ALSO strips any pre-existing occurrence from the input so the
// marker is guaranteed unique. A `SENTINEL N SENTINEL` token unambiguously
// stands for the N-th string literal, so a string-LOOKING fragment INSIDE a
// string literal (e.g. `"require('x')"`) becomes part of that ONE outer string's
// content and is never re-lexed — it can never be mistaken for an import.
const SENTINEL = "\u2400";

/**
 * Lexer pass: strip comments, and replace every top-level string/template
 * literal with an indexed sentinel `N`, returning { skeleton,
 * strings } where strings[N] is the literal's RAW inner content. Template
 * interpolations are dropped from the captured content (a `${…}` cannot inject a
 * specifier). String-aware so a `//`/`/*` inside a string is not a comment.
 */
// Decode a backslash escape at src[p] (p points at the char AFTER the backslash)
// so an obfuscated specifier — `\x40cinatra-ai/...` / `@…` / `\u{40}…` —
// resolves to its real text and is still scanned (codex MUST-FIX). Returns
// { text, next }: the decoded character(s) and the index past the escape.
function decodeEscape(src, p) {
  const c = src[p];
  if (c === undefined) return { text: "", next: p };
  // LineContinuation: `\` + a line terminator evaluates to EMPTY (codex round-12),
  // so `"@\<LF>/lib/x"` is the string `@/lib/x`. Delete it (incl. CRLF, LS, PS).
  if (c === "\n" || c === "\u2028" || c === "\u2029") return { text: "", next: p + 1 };
  if (c === "\r") return { text: "", next: src[p + 1] === "\n" ? p + 2 : p + 1 };
  if (c === "x") {
    const hex = src.slice(p + 1, p + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), next: p + 3 };
  } else if (c === "u") {
    if (src[p + 1] === "{") {
      const end = src.indexOf("}", p + 2);
      const hex = end > 0 ? src.slice(p + 2, end) : "";
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) return { text: String.fromCodePoint(parseInt(hex, 16)), next: end + 1 };
    } else {
      const hex = src.slice(p + 1, p + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), next: p + 5 };
    }
  }
  // Legacy octal escape `\NNN` (1-3 octal digits) → its code point (`\100` = `@`).
  if (c >= "0" && c <= "7") {
    const oct = (src.slice(p, p + 3).match(/^[0-7]{1,3}/) || [c])[0];
    return { text: String.fromCharCode(parseInt(oct, 8) & 0xff), next: p + oct.length };
  }
  // Standard single-char escapes (\n, \t, \\, \", \', \`, …) → keep the literal
  // char (NOT its control meaning — we only care that the visible specifier text
  // is preserved; a control char inside a specifier is not a real package name).
  const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
  return { text: simple[c] ?? c, next: p + 1 };
}

export function tokenizeSource(src) {
  // Guarantee the sentinel marker is absent from the input so a crafted source
  // cannot inject a fake `SENTINEL N SENTINEL` token.
  if (src.includes(SENTINEL)) src = src.split(SENTINEL).join("");
  let skeleton = "";
  const strings = [];
  let i = 0;
  const n = src.length;
  // Brace-mode stack: each template-literal interpolation `${` pushes "expr" so
  // its body is lexed AS CODE (an import()/require() inside `${...}` is caught);
  // the matching `}` resumes the enclosing template. A plain `{` pushes "block"
  // so it is not mistaken for an interpolation close. The lexer thus handles
  // nested templates + interpolated calls (codex MUST-FIX).
  const modeStack = [];

  const emitString = (content) => {
    skeleton += SENTINEL + strings.length + SENTINEL;
    strings.push(content);
  };

  // Regex-vs-division (codex MUST-FIX): a `/` starts a regex literal only where a
  // value is expected. Approximate by the last non-space skeleton char: an
  // identifier/literal char or a closer means division; else regex. A misread
  // only changes whether following text is scanned as code; the import patterns
  // are keyword-anchored, so a slip cannot fabricate an import.
  // Keywords after which a `/` begins a regex even though they end in an
  // identifier char (`return /re/`, `typeof /re/`, …).
  const REGEX_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do",
    "else", "yield", "await", "case", "throw",
  ]);
  // Tri-state: "regex" | "division" | "ambiguous" — the caller resolves the
  // ambiguous (`)`/`]`-preceded) case by the next token after `/`.
  const regexAllowed = () => {
    let k = skeleton.length - 1;
    while (k >= 0 && (skeleton[k] === " " || skeleton[k] === "\t" || skeleton[k] === "\n" || skeleton[k] === "\r")) k--;
    if (k < 0) return "regex"; // start of file → a `/` is a regex
    const ch = skeleton[k];
    // After a VALUE-producing token a `/` is DIVISION: a string/template literal
    // (now a SENTINEL char), or a postfix `++`/`--` (codex round-15).
    if (ch === SENTINEL) return "division";
    if ((ch === "+" || ch === "-") && skeleton[k - 1] === ch) return "division";
    if (!/[A-Za-z0-9_$)\]}]/.test(ch)) return "regex"; // after operator/`(`/`,`/`=` etc.
    if (ch === ")" || ch === "]") return "ambiguous"; // `if(...)/re/` vs `f() / x`
    // identifier/`}`-like: a regex-context KEYWORD means regex; else division.
    if (/[A-Za-z_$]/.test(ch)) {
      let w = k;
      while (w >= 0 && /[A-Za-z0-9_$]/.test(skeleton[w])) w--;
      const word = skeleton.slice(w + 1, k + 1);
      if (REGEX_KEYWORDS.has(word)) return "regex";
    }
    return "division";
  };

  // Read a quoted string from p (past the open quote). Returns index past the
  // close quote; emits the captured content as a sentinel.
  const readString = (q, p) => {
    let content = "";
    while (p < n) {
      const c = src[p];
      if (c === "\\") { const d = decodeEscape(src, p + 1); content += d.text; p = d.next; continue; }
      if (c === q) { p += 1; break; }
      content += c; p += 1;
    }
    emitString(content);
    return p;
  };

  // Read a regex literal from p (past the opening `/`). A char class suspends the
  // terminator; an unterminated regex bails at newline.
  const readRegex = (p) => {
    const startBody = p;
    let inClass = false;
    let closed = false;
    while (p < n) {
      const c = src[p];
      if (c === "\\") { p += 2; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) { p += 1; closed = true; break; }
      else if (c === "\n") break; // a regex literal cannot span a newline
      p += 1;
    }
    if (!closed) return { ok: false, end: startBody, body: "" };
    const body = src.slice(startBody, p - 1);
    while (p < n && /[a-z]/i.test(src[p])) p += 1; // flags
    return { ok: true, end: p, body };
  };

  // Read template CONTENT from p until the closing backtick or a `${`. On `${`,
  // emit the chunk, push an "expr" frame, and RETURN so the main loop lexes the
  // interpolation body as code; the matching `}` resumes here.
  const readTemplate = (p) => {
    let content = "";
    while (p < n) {
      const c = src[p];
      if (c === "\\") { const d = decodeEscape(src, p + 1); content += d.text; p = d.next; continue; }
      if (c === "`") { emitString(content); return p + 1; }
      if (c === "$" && src[p + 1] === "{") { emitString(content); modeStack.push("expr"); return p + 2; }
      content += c; p += 1;
    }
    emitString(content);
    return p;
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") { skeleton += " "; while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { skeleton += " "; i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") skeleton += "\n"; i++; } i += 2; continue; }
    if (c === "'" || c === '"') { i = readString(c, i + 1); continue; }
    if (c === "`") { i = readTemplate(i + 1); continue; }
    if (c === "{") { modeStack.push("block"); skeleton += c; i++; continue; }
    if (c === "}") {
      const top = modeStack.pop();
      if (top === "expr") { i = readTemplate(i + 1); continue; }
      skeleton += c; i++; continue;
    }
    if (c === "/") {
      const verdict = regexAllowed();
      if (verdict === "division") { skeleton += " "; i++; continue; } // `/` operator
      if (verdict === "ambiguous") {
        // `)` / `]` before `/` is genuinely undecidable without a TS parser
        // (`if (...) /re/` regex vs `f() / x` division). A GATE must never have a
        // FALSE-NEGATIVE on its trust boundary (a hidden `f() / (await import(…))`
        // would let a real coupling slip), so we resolve ambiguity toward
        // DIVISION: emit a space for `/` and keep scanning the rest AS CODE. The
        // only cost is a vanishingly-rare FALSE-POSITIVE — a regex literal whose
        // body is a literal `import … from "pkg"` / `require("pkg")` statement
        // right after a `)`/`]` (essentially never real code; an author hitting it
        // rewrites the regex). Erring toward catching real imports is correct for
        // a conformance gate (codex round-11).
        skeleton += " "; i++; continue;
      }
      // verdict === "regex": after an operator/keyword — a regex literal. Emit a
      // SENTINEL (value-producing) so a following `/` is read as DIVISION.
      const rx = readRegex(i + 1);
      skeleton += rx.ok ? SENTINEL : " ";
      i = rx.ok ? rx.end : i + 1;
      continue;
    }
    skeleton += c; i++;
  }
  return { skeleton, strings };
}

// Import forms anchored on a trailing string SENTINEL. The captured group is the
// sentinel index; the real specifier is strings[index].
const SENTINEL_TOKEN = `${SENTINEL}(\\d+)${SENTINEL}`;
const IMPORT_PATTERNS = [
  new RegExp(`\\bimport\\s+type\\s[^;]*?\\bfrom\\s*${SENTINEL_TOKEN}`, "g"),
  new RegExp(`\\bimport\\b[^;]*?\\bfrom\\s*${SENTINEL_TOKEN}`, "g"),
  new RegExp(`\\bexport\\b[^;]*?\\bfrom\\s*${SENTINEL_TOKEN}`, "g"),
  new RegExp(`\\bimport\\s*\\??\\.?\\s*\\(\\s*${SENTINEL_TOKEN}`, "g"), // import( / import?.(
  new RegExp(`(?:\\.\\s*)?\\brequire\\s*\\??\\.?\\s*\\(\\s*${SENTINEL_TOKEN}`, "g"), // require( / module.require( / require?.(
  new RegExp(`\\bimport\\s*${SENTINEL_TOKEN}`, "g"), // bare side-effect import"x"
];

/** Extract every imported module specifier from one source file's text. */
export function extractImports(src) {
  const { skeleton, strings } = tokenizeSource(src);
  const out = new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(skeleton)) !== null) {
      const spec = strings[Number(m[1])];
      if (typeof spec === "string" && spec.length > 0) out.add(spec);
    }
  }
  return [...out];
}

/** Collapse a specifier to its base package name (`@scope/pkg/sub` → `@scope/pkg`). */
export function basePackage(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

const RELATIVE_RE = /^\.{1,2}\//;

/** Classify a single specifier from the perspective of the package `selfName`.
 * Returns one of: "self" | "relative" | "host-alias" |
 * "sdk" | "cross-extension" | "non-sdk-first-party" | "third-party" | "node". */
export function classifySpecifier(specifier, selfName) {
  if (RELATIVE_RE.test(specifier) || specifier === "." || specifier === "..") return "relative";
  if (specifier.startsWith("node:")) return "node";
  // host `@/` path alias — the import-ban's primary forbidden form.
  if (specifier.startsWith("@/")) return "host-alias";
  const base = basePackage(specifier);
  if (selfName && (base === selfName || specifier === selfName)) return "self";
  if (SDK_PACKAGES.has(base)) return "sdk";
  // The host `@cinatra-ai/host` / `@cinatra-ai/host:*` services are resolved at
  // RUNTIME (via the connector's deps slot — a namespaced globalThis Symbol),
  // NEVER imported. A literal IMPORT of the host scope is a coupling violation,
  // exactly as cinatra's import-ban flags it (basePackageOf is not in SDK_PACKAGES
  // so isSdkOnlyViolation is true) — it falls through to the first-party branch
  // below (codex round-16: do NOT exempt host-scope imports).
  if (specifier.startsWith(`${FIRST_PARTY_SCOPE}/`) || specifier === FIRST_PARTY_SCOPE) {
    // A first-party @cinatra-ai/* package that is NOT an SDK package — another
    // extension, a non-SDK first-party lib, or the host service scope. Per-package
    // we cannot distinguish them — all are forbidden by the same SDK-only rule.
    return "non-sdk-first-party";
  }
  return "third-party";
}

// ---------------------------------------------------------------------------
// Per-statement SDK value-vs-type classification for the host-peer
// value-import ban. The serverEntry graph must keep SDK (`@cinatra-ai/sdk-
// extensions`) imports TYPE-ONLY — a VALUE import of the SDK breaks the
// compile-against-an-older-host contract (the SDK is a host PEER, present only
// at runtime in the host). ONLY a DECLARATION `import type …` / `export type …`
// is erased (type-only). An `import { type X } from "host-peer"` STILL loads the
// module at runtime (verbatimModuleSyntax / Node type-stripping), so it is a VALUE
// edge — as is any default/namespace/value import, `require()`, or runtime
// dynamic `import()`. Parity: cinatra parseModuleImports isValueEdge.

/** Is the resolved sentinel string an SDK specifier (base @cinatra-ai/sdk-extensions)? */
function isHostPeerSpecifier(spec) {
  return typeof spec === "string" && HOST_PEERS.has(basePackage(spec));
}

/** Find every SDK import STATEMENT in `src` and whether it is value-importing.
 * Operates on the sentinel skeleton so a specifier inside a comment/string is
 * never mistaken for an import. */
/** Index just past the `)` that closes the dynamic import whose arg0 ends at
 * `from` (balances nested parens), or skeleton.length if unbalanced. */
function closeParenAfter(skeleton, from) {
  let depth = 1; // we are inside the import(...) call
  for (let i = from; i < skeleton.length; i++) {
    const c = skeleton[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i + 1; }
  }
  return skeleton.length;
}

export function sdkValueImports(src) {
  const { skeleton, strings } = tokenizeSource(src);
  const findings = [];
  // static `import <clause> from <sentinel>` — clause decides value vs type-only.
  const importRe = new RegExp(`\\bimport\\b([^;]*?)\\bfrom\\s*${SENTINEL_TOKEN}`, "g");
  let m;
  while ((m = importRe.exec(skeleton)) !== null) {
    const clause = m[1];
    const spec = strings[Number(m[2])];
    if (!isHostPeerSpecifier(spec)) continue;
    // ONLY a DECLARATION `import type …` erases the runtime module edge. An
    // `import { type X } from "host-peer"` (inline type specifier) STILL loads the
    // module at runtime under verbatimModuleSyntax / Node type-stripping, so it is
    // a VALUE edge (parity with cinatra parseModuleImports: isValueEdge=true
    // unless clause.isTypeOnly). Flag everything that is not a leading `type`.
    if (/^\s*type\b/.test(clause)) continue; // declaration `import type …` — erased
    findings.push({ form: "static-import", specifier: spec });
  }
  // `export <clause> from <sentinel>` re-exports are runtime VALUE edges unless
  // the whole clause is type-only (`export type { … }` / `export { type X }`)
  // (codex MUST-FIX: these slipped through entirely before).
  const exportRe = new RegExp(`\\bexport\\b([^;]*?)\\bfrom\\s*${SENTINEL_TOKEN}`, "g");
  while ((m = exportRe.exec(skeleton)) !== null) {
    const clause = m[1];
    const spec = strings[Number(m[2])];
    if (!isHostPeerSpecifier(spec)) continue;
    // ONLY a DECLARATION `export type { … } from` erases the edge; an
    // `export { type X } from "host-peer"` still re-exports at runtime (value edge).
    if (/^\s*type\b/.test(clause)) continue; // declaration `export type …` — erased
    findings.push({ form: "export-from", specifier: spec });
  }
  // bare side-effect `import "@cinatra-ai/sdk-extensions";` is a runtime VALUE edge
  // (cinatra parseModuleImports: kind "bare", isValueEdge=true) — codex round-13.
  const bareRe = new RegExp(`\\bimport\\s*${SENTINEL_TOKEN}`, "g");
  while ((m = bareRe.exec(skeleton)) !== null) {
    const spec = strings[Number(m[1])];
    if (isHostPeerSpecifier(spec)) findings.push({ form: "bare-import", specifier: spec });
  }
  // dynamic import() / require() of the SDK are runtime VALUE forms — EXCEPT a TS
  // `import("…")` TYPE QUERY, which is type-only (erased at compile) and must NOT
  // be flagged (codex MUST-FIX). A type query is recognized by (a) a type-position
  // token immediately before `import`, or (b) the `import(…)` being used as a
  // member type `import("…").Foo` with no following call.
  // Match arg0 only — do NOT require `)` right after the specifier, so import
  // attributes / extra args / trailing comma (`import("x", { with: {} })`,
  // `require("x",)`) are still caught (codex round-19). The `kw`-call position is
  // m.index; the type-query check finds the close paren itself.
  const dynRe = new RegExp(`(?:\\.\\s*)?\\b(import|require)\\s*\\??\\.?\\s*\\(\\s*${SENTINEL_TOKEN}`, "g");
  while ((m = dynRe.exec(skeleton)) !== null) {
    const kw = m[1];
    const spec = strings[Number(m[2])];
    if (!isHostPeerSpecifier(spec)) continue;
    if (kw === "import" && isTypeQueryAt(skeleton, m.index, closeParenAfter(skeleton, dynRe.lastIndex))) continue;
    findings.push({ form: "dynamic-import", specifier: spec });
  }
  return findings;
}

/** True iff the dynamic `import(...)` spanning [start,end) in `skeleton` is a TS
 * TYPE QUERY (type-only). Type-vs-value `import()` is undecidable without a TS
 * parser, so a GATE errs toward VALUE (codex round-5). We exempt ONLY two forms
 * that are BOTH (a) in a type-ish position AND (b) followed by a `.Member`
 * (the TS module-type-pick form `import("…").Foo` — a VALUE `import()` in a
 * ternary/object/label has no such member):
 *   • `type X = import("…").Foo`  (a `type` alias), and
 *   • `<binding|)|]>: import("…").Foo`  (a type annotation, not a `?:` ternary).
 * Everything else (extends/keyof/typeof/as/</|/&, ternary, object value, label,
 * bare `import("…")`) is treated as a VALUE import — a real host-peer value
 * import must never slip; for a type-only SDK type, use `import type`. */
function isTypeQueryAt(skeleton, start, end) {
  // (b) require a `.Member` immediately after `)` with no following call.
  const after = skeleton.slice(end).match(/^\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*([([.]?)/);
  if (!after || after[1] === "(") return false;
  // (a) a type-ish position before `import`.
  let k = start - 1;
  while (k >= 0 && /\s/.test(skeleton[k])) k--;
  if (k < 0) return false;
  const ch = skeleton[k];
  if (ch === "=") {
    const before = skeleton.slice(0, k);
    const stmt = before.slice(Math.max(0, before.search(/[;{}]\s*[^;{}]*$/) + 1));
    return /(^|[;{}\s])type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(<[^=;]*>)?\s*$/.test(stmt);
  }
  if (ch === ":") {
    let j = k - 1;
    while (j >= 0 && /\s/.test(skeleton[j])) j--;
    if (j < 0) return false;
    if (skeleton[j] === "?") return false; // `?:` ternary
    if (!/[A-Za-z0-9_$)\]]/.test(skeleton[j])) return false;
    // Reject a ternary `cond ? a : import(...)` (unmatched `?` before the `:`).
    if (hasUnmatchedTernaryQuestion(skeleton, k)) return false;
    // A TYPE annotation `name: T` / `): T` lives in a PARAMETER LIST or a
    // declaration — its enclosing unclosed bracket is `(` (or it is a top-level
    // `let/const/var name:`). An object-literal `{ m: … }` colon is enclosed by
    // `{`, and a `label:` is at a statement boundary — both are VALUES (codex
    // round-6). Decide by the nearest enclosing unclosed bracket.
    return annotationContext(skeleton, k);
  }
  return false;
}

/** True iff the `:` at `colon` is a TYPE-annotation colon (param/return/decl),
 * not an object-literal value colon or a label colon. Walks back tracking
 * bracket depth: the first UNCLOSED `(`/`[` ⇒ param/index annotation (OK); an
 * unclosed `{` ⇒ object literal (value); reaching a statement boundary with no
 * unclosed bracket ⇒ either a top-level `let/const/var name:` annotation (OK) or
 * a label (value) — disambiguated by a leading declaration keyword. */
function annotationContext(skeleton, colon) {
  let round = 0, square = 0, curly = 0;
  let i = colon - 1;
  for (; i >= 0; i--) {
    const c = skeleton[i];
    if (c === ")") round++;
    else if (c === "(") { if (round === 0) return true; round--; }
    else if (c === "]") square++;
    else if (c === "[") { if (square === 0) return true; square--; }
    else if (c === "}") curly++;
    else if (c === "{") { if (curly === 0) return false; curly--; } // object literal
    else if (c === ";") break; // statement boundary at top level
  }
  // Top level (no enclosing bracket): a `let/const/var name:` is an annotation; a
  // bare `name:` at statement start is a LABEL (value).
  const head = skeleton.slice(Math.max(0, i + 1), colon);
  return /(^|[;{}])\s*(let|const|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:?\s*$/.test(head);
}

/** True iff there is an unmatched ternary `?` before index `colon` within the
 * current statement (so the `:` at `colon` is a ternary branch, not an
 * annotation). Skips `?.`/`??` and balances nested `?:`. */
function hasUnmatchedTernaryQuestion(skeleton, colon) {
  let depth = 0;
  for (let i = colon - 1; i >= 0; i--) {
    const c = skeleton[i];
    if (c === ";" || c === "{" || c === "}") break; // statement boundary
    if (c === ":") { depth++; continue; }
    if (c === "?") {
      if (skeleton[i + 1] === "." || skeleton[i + 1] === "?") continue; // `?.` / `??`
      if (skeleton[i - 1] === "?") continue; // `??` left half
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dependency-edge well-formedness (manifest.ts ExtensionDependency). Per-package
// shape only — the monorepo deps-gate ALSO re-derives confident structural edges
// from the whole tree and requires they be DECLARED; that derivation is
// host-tree-dependent (it needs every other package's kind), so the per-package
// gate validates the SHAPE of each declared edge, not whole-tree completeness.

/** The canonical VersionConstraint object shape (dependencies.ts). */
export function isValidVersionConstraint(vc) {
  if (!vc || typeof vc !== "object") return false;
  if (vc.kind === "semver-range") return typeof vc.range === "string" && vc.range.length > 0;
  if (vc.kind === "exact") return typeof vc.version === "string" && vc.version.length > 0;
  if (vc.kind === "git-ref") return typeof vc.ref === "string" && vc.ref.length > 0;
  return false;
}

/** Well-formed `cinatra.dependencies[]` edge — the FULL ExtensionDependency
 * shape (per-package; whole-tree completeness + kind-match is host-side). */
export function isWellFormedDependencyEdge(dep) {
  if (dep == null || typeof dep !== "object" || Array.isArray(dep)) return false;
  if (typeof dep.packageName !== "string" || dep.packageName.length === 0) return false;
  if (!EDGE_TYPES.includes(dep.edgeType)) return false;
  if (!REQUIREMENTS.includes(dep.requirement)) return false;
  if (!isValidVersionConstraint(dep.versionConstraint)) return false;
  if (dep.kind !== undefined && !VALID_KINDS.includes(dep.kind)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Each rule returns { id, level, message }[] (level: "error"). A package PASSES
// the gate iff every enabled rule returns []. Rules are pure functions of the
// loaded package (manifest + a {relPath -> text} source map), so they are
// trivially testable and run identically in the parity test against cinatra.

/** The `cinatra` manifest block shape gate. */
export function checkManifestShape(pkg) {
  const errs = [];
  const cin = pkg && pkg.cinatra;
  if (cin == null || typeof cin !== "object") {
    return [{ id: "manifest-shape", level: "error", message: `package.json has no \`cinatra\` manifest block.` }];
  }
  // kind
  if (!VALID_KINDS.includes(cin.kind)) {
    errs.push({ id: "manifest-kind", level: "error", message: `cinatra.kind=${JSON.stringify(cin.kind ?? null)} is not one of ${VALID_KINDS.join("|")}.` });
  }
  // requestedHostPorts ⊆ HOST_PORT_NAMES
  if (cin.requestedHostPorts !== undefined) {
    if (!Array.isArray(cin.requestedHostPorts)) {
      errs.push({ id: "manifest-ports", level: "error", message: `cinatra.requestedHostPorts must be an array of host-port names.` });
    } else {
      const bad = cin.requestedHostPorts.filter((p) => !HOST_PORT_NAMES.includes(p));
      if (bad.length) {
        errs.push({ id: "manifest-ports", level: "error", message: `cinatra.requestedHostPorts has unknown port(s) ${bad.map((b) => JSON.stringify(b)).join(", ")} — must be a subset of ${HOST_PORT_NAMES.join(", ")}.` });
      }
    }
  }
  // sdkAbiRange grammar (when present)
  if (cin.sdkAbiRange !== undefined && !isValidSdkAbiRange(cin.sdkAbiRange)) {
    errs.push({ id: "manifest-abi", level: "error", message: `cinatra.sdkAbiRange=${JSON.stringify(cin.sdkAbiRange)} is not a valid SDK ABI range.` });
  }
  // dependency edge well-formedness (when present)
  if (cin.dependencies !== undefined) {
    if (!Array.isArray(cin.dependencies)) {
      errs.push({ id: "manifest-deps", level: "error", message: `cinatra.dependencies must be an array (use [] when none).` });
    } else {
      cin.dependencies.forEach((dep, i) => {
        if (!isWellFormedDependencyEdge(dep)) {
          errs.push({ id: "manifest-deps", level: "error", message: `cinatra.dependencies[${i}] is malformed: need {packageName, edgeType(${EDGE_TYPES.join("|")}), versionConstraint:{kind(${VERSION_CONSTRAINT_KINDS.join("|")}),…}, requirement(${REQUIREMENTS.join("|")})[, kind(${VALID_KINDS.join("|")})]}.` });
        }
      });
    }
  }
  // serverEntry, when declared, must be a package-relative path (no escape).
  // Accept "./register" or "register"; reject absolute / parent-escape.
  if (cin.serverEntry !== undefined) {
    if (typeof cin.serverEntry !== "string" || cin.serverEntry.startsWith("/") || hasParentEscape(cin.serverEntry)) {
      errs.push({ id: "manifest-serverentry", level: "error", message: `cinatra.serverEntry=${JSON.stringify(cin.serverEntry)} must be a package-relative path (no absolute / parent-escape).` });
    }
  }
  return errs;
}

/** Import-ban: no `@/` host-alias, no cross-extension / non-SDK first-party
 * imports. Scans EVERY source file in the package (tests included, type imports
 * included). Returns one finding per (file, offending base). */
export function checkImportBan(pkg, sources) {
  const selfName = pkg && pkg.name;
  const errs = [];
  for (const [relPath, text] of Object.entries(sources)) {
    if (!isSourceFile(relPath)) continue;
    for (const spec of extractImports(text)) {
      const cls = classifySpecifier(spec, selfName);
      if (cls === "host-alias") {
        errs.push({ id: "import-ban-host-alias", level: "error", message: `${relPath}: forbidden host \`@/\` import "${spec}" — reach the host only through register(ctx) ports / @cinatra-ai/host:* services.` });
      } else if (cls === "non-sdk-first-party") {
        errs.push({ id: "import-ban-first-party", level: "error", message: `${relPath}: forbidden first-party import "${spec}" (base ${basePackage(spec)}) — an extension may only import ${[...SDK_PACKAGES].join(" / ")} among @cinatra-ai/* packages (no cross-extension, no non-SDK first-party).` });
      }
    }
  }
  return errs;
}

/** Host-peer value-import ban: over the serverEntry graph the SDK must be
 * imported TYPE-ONLY. With no host tree we approximate the "serverEntry graph"
 * as every non-test source file (the serverEntry transitively imports them);
 * test files are excluded (they legitimately value-import the SDK harness). */
/** Resolve a RELATIVE import specifier from `fromRel` to a repo-relative source
 * path present in `sources` (tries the literal, then common source extensions and
 * an `/index`), or null. Bounded to files inside the package. */
function resolveRelativeInSources(fromRel, spec, sources) {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) return null;
  const fromDir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = (fromDir ? fromDir.split("/") : []);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { if (parts.length) parts.pop(); else return null; continue; }
    parts.push(seg);
  }
  const base = parts.join("/");
  const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];
  const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
  for (const c of cands) if (Object.prototype.hasOwnProperty.call(sources, c)) return c;
  return null;
}

/** The set of source files REACHABLE from `serverEntryRel` via relative imports
 * (the serverEntry graph). Mirrors the cinatra host-peer-value-import-ban graph
 * trace so a `.test.`-named helper pulled in by the serverEntry is still scanned. */
export function serverEntryGraph(serverEntryRel, sources, pkg = null) {
  const reachable = new Set();
  if (!serverEntryRel || !Object.prototype.hasOwnProperty.call(sources, serverEntryRel)) return reachable;
  const selfName = pkg && pkg.name;
  const exportsMap = pkg && pkg.exports;
  const stack = [serverEntryRel];
  while (stack.length) {
    const rel = stack.pop();
    if (reachable.has(rel)) continue;
    reachable.add(rel);
    for (const spec of extractImports(sources[rel] ?? "")) {
      let next = resolveRelativeInSources(rel, spec, sources);
      // Self-package subpath (`@scope/ext/helper`) resolves via the exports map to
      // a repo-relative file (Node self-resolves the package's own name) — follow
      // it too (codex round-16), so a serverEntry pulling in a self-subpath helper
      // that is `.test.`-named is still scanned.
      if (!next && selfName && (basePackage(spec) === selfName)) {
        const subpath = spec === selfName ? "." : "." + spec.slice(selfName.length);
        const target = resolveExportSubpath(exportsMap, subpath);
        if (target) {
          const cand = target.replace(/^\.\//, "");
          const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];
          const probes = [cand, ...EXTS.map((e) => cand + e), ...EXTS.map((e) => `${cand}/index${e}`)];
          for (const pc of probes) { if (Object.prototype.hasOwnProperty.call(sources, pc)) { next = pc; break; } }
        }
      }
      if (next && !reachable.has(next)) stack.push(next);
    }
  }
  return reachable;
}

export function checkHostPeerValueImportBan(pkg, sources, serverEntryRel = null) {
  const errs = [];
  // Files reachable from the serverEntry via relative imports are ALWAYS scanned
  // (the serverEntry graph), even when `.test.`-named — a host-peer value import
  // anywhere in that graph ships to production (codex round-15).
  const graph = serverEntryGraph(serverEntryRel, sources, pkg);
  for (const [relPath, text] of Object.entries(sources)) {
    if (!isSourceFile(relPath)) continue;
    // Test files legitimately value-import the SDK harness, so they are excluded —
    // EXCEPT files in the serverEntry graph (the root + its relative-import
    // closure), which always ship and must be scanned (codex rounds 13+15).
    if (isTestPath(relPath) && !graph.has(relPath)) continue;
    for (const f of sdkValueImports(text)) {
      errs.push({ id: "host-peer-value-import", level: "error", message: `${relPath}: VALUE import of host-peer "${f.specifier}" (${f.form}) — serverEntry-graph SDK imports must be type-only (\`import type\`), the SDK is a host peer present only at runtime.` });
    }
  }
  return errs;
}

/** SDK-only first-party deps: package.json dependencies/peerDependencies may not
 * name any @cinatra-ai/* package other than the SDK (and the host scope, which
 * is never a real dependency — resolved at runtime). */
export function checkDepsSdkOnly(pkg) {
  const errs = [];
  const fields = ["dependencies", "peerDependencies", "optionalDependencies"];
  for (const field of fields) {
    const deps = pkg && pkg[field];
    if (deps == null || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith(`${FIRST_PARTY_SCOPE}/`)) continue;
      if (SDK_PACKAGES.has(name)) continue;
      if (name === HOST_SERVICE_SCOPE || name.startsWith(`${HOST_SERVICE_SCOPE}:`)) {
        errs.push({ id: "deps-host-scope", level: "error", message: `${field}["${name}"]: the @cinatra-ai/host:* service scope is resolved at runtime, never a package dependency — remove it.` });
        continue;
      }
      errs.push({ id: "deps-sdk-only", level: "error", message: `${field}["${name}"]: only ${[...SDK_PACKAGES].join(" / ")} are permitted @cinatra-ai/* dependencies (no cross-extension, no non-SDK first-party).` });
    }
  }
  return errs;
}

/** Strip fenced code blocks + inline code spans so README structure scanning is
 * not confused by code examples (mirrors extension-readme-gate.stripCodeFences). */
export function stripCodeFences(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null) {
      const m = trimmed.match(/^(```+|~~~+)/);
      if (m) { fence = m[1][0].repeat(m[1].length); continue; }
      out.push(line.replace(/`[^`\n]*`/g, ""));
    } else {
      const m = trimmed.match(/^(```+|~~~+)\s*$/);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
  }
  return out.join("\n");
}

/** README/license/kind conformance (the small marketplace-card contract). */
export function checkReadme(pkg, sources, readmeText) {
  const errs = [];
  if (readmeText == null) {
    return [{ id: "readme-missing", level: "error", message: `no README.md in the package root.` }];
  }
  const bytes = Buffer.byteLength(readmeText, "utf8");
  if (bytes < README_MIN_BYTES) {
    errs.push({ id: "readme-too-short", level: "error", message: `README.md is ${bytes} bytes (< ${README_MIN_BYTES} minimum) — add a short marketplace description + a Capabilities list.` });
  }
  if (bytes > README_MAX_BYTES) {
    errs.push({ id: "readme-too-long", level: "error", message: `README.md is ${bytes} bytes (> ${README_MAX_BYTES} maximum) — the card contract is a small description, an optional "Works with" list, and a Capabilities list. Nothing else.` });
  }
  const stripped = stripCodeFences(readmeText);
  const h2s = [...stripped.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
  for (const h of h2s) {
    if (!ALLOWED_H2.some((a) => a.toLowerCase() === h.toLowerCase())) {
      errs.push({ id: "readme-h2", level: "error", message: `README.md has a non-contract H2 "## ${h}" — only ${ALLOWED_H2.map((a) => `"${a}"`).join(", ")} are allowed.` });
    }
  }
  for (const req of REQUIRED_H2) {
    if (!h2s.some((h) => h.toLowerCase() === req.toLowerCase())) {
      errs.push({ id: "readme-required-h2", level: "error", message: `README.md is missing the required "## ${req}" section.` });
    }
  }
  return errs;
}

/** License conformance: an extension manifest must carry an SPDX license id
 * (the monorepo pins Apache-2.0 for cinatra-ai extensions and GPL-2.0-or-later
 * for GPL-derived ones — that POLICY is host-side; per-package we require a
 * non-empty, plausible SPDX license string so a release can never ship blank). */
const SPDX_RE = /^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;
export function checkLicense(pkg) {
  const lic = pkg && pkg.license;
  if (typeof lic !== "string" || lic.trim().length === 0) {
    return [{ id: "license-missing", level: "error", message: `package.json has no \`license\` field — extensions must carry an SPDX license id.` }];
  }
  if (!SPDX_RE.test(lic.trim())) {
    return [{ id: "license-shape", level: "error", message: `package.json license=${JSON.stringify(lic)} is not a plausible SPDX expression.` }];
  }
  return [];
}

/** serverEntry / built-artifact preflight: if the manifest declares a
 * serverEntry, the package's exports must expose it AND the built artifact must
 * exist (so the loader's dynamic import resolves at activation). */
export function checkServerEntryPreflight(pkg, files) {
  const cin = pkg && pkg.cinatra;
  if (cin == null || typeof cin !== "object" || cin.serverEntry == null) return [];
  const errs = [];
  const entry = String(cin.serverEntry);
  const subpath = entry.startsWith("./") ? entry : `./${entry}`;
  const exportsMap = pkg.exports;
  const resolved = resolveExportSubpath(exportsMap, subpath) ?? resolveExportSubpath(exportsMap, entry);
  if (exportsMap == null) {
    errs.push({ id: "serverentry-exports", level: "error", message: `cinatra.serverEntry="${entry}" but package.json has no \`exports\` map to resolve it.` });
    return errs;
  }
  if (resolved == null) {
    errs.push({ id: "serverentry-exports", level: "error", message: `cinatra.serverEntry="${entry}" is not present in package.json \`exports\` (the loader resolves the entry via exports).` });
    return errs;
  }
  // the resolved built artifact must exist on disk.
  const rel = resolved.replace(/^\.\//, "");
  if (!files.has(rel)) {
    errs.push({ id: "serverentry-artifact", level: "error", message: `cinatra.serverEntry="${entry}" resolves to "${resolved}" but that built artifact is missing — build the package before submit.` });
  }
  return errs;
}

/** Resolve an exports subpath to its (import|default) string target — a minimal
 * mirror of the Node exports resolution the loader uses (no conditions beyond
 * import/default; rejects parent-escape / absolute targets). */
/** True iff a posix-ish path contains a parent-directory `..` SEGMENT (not merely
 * embedded dots like `foo..bar.mjs`). */
export function hasParentEscape(p) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(String(p));
}

export function resolveExportSubpath(exportsMap, key) {
  if (exportsMap == null) return null;
  let val;
  if (typeof exportsMap === "string") {
    val = key === "." ? exportsMap : undefined;
  } else if (typeof exportsMap === "object") {
    val = exportsMap[key];
  }
  if (val == null) return null;
  const target = pickConditionalTarget(val);
  if (typeof target !== "string") return null;
  if (target.startsWith("/") || hasParentEscape(target)) return null;
  return target.startsWith("./") ? target : `./${target}`;
}

function pickConditionalTarget(val) {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    for (const v of val) { const t = pickConditionalTarget(v); if (typeof t === "string") return t; }
    return null;
  }
  if (val && typeof val === "object") {
    if (typeof val.import === "string") return val.import;
    if (typeof val.default === "string") return val.default;
    if (typeof val.require === "string") return val.require;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File classification helpers.

const SOURCE_EXT_RE = /\.([cm]?[tj]sx?)$/; // .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs (parity: cinatra SOURCE_EXTENSIONS)
export function isSourceFile(relPath) {
  return SOURCE_EXT_RE.test(relPath) && !/(^|\/)node_modules\//.test(relPath);
}
export function isTestPath(relPath) {
  return /(^|\/)(__tests__|__mocks__|tests?)\//.test(relPath) || /\.(test|spec)\.[mc]?[tj]sx?$/.test(relPath);
}

// ---------------------------------------------------------------------------
// The full per-package conformance check. `loaded` = {
//   pkg: parsed package.json, sources: {relPath->text}, files: Set<relPath>,
//   readme: string|null }. Returns { ok, findings, ruleCounts }.

export const ALL_RULE_IDS = [
  "manifest-shape", "manifest-kind", "manifest-ports", "manifest-abi",
  "manifest-deps", "manifest-serverentry",
  "import-ban-host-alias", "import-ban-first-party",
  "host-peer-value-import",
  "deps-sdk-only", "deps-host-scope",
  "readme-missing", "readme-too-short", "readme-too-long", "readme-h2", "readme-required-h2",
  "license-missing", "license-shape",
  "serverentry-exports", "serverentry-artifact",
];

export function conformExtensionPackage(loaded) {
  const { pkg, sources = {}, files = new Set(), readme = null } = loaded;
  // Resolve the serverEntry artifact's repo-relative path so the host-peer scan
  // never skips it even when it is `.test.`-named (codex round-13).
  const cin = pkg && pkg.cinatra;
  let serverEntryRel = null;
  if (cin && typeof cin.serverEntry === "string") {
    const entry = cin.serverEntry;
    const subpath = entry.startsWith("./") ? entry : `./${entry}`;
    const resolved = resolveExportSubpath(pkg.exports, subpath) ?? resolveExportSubpath(pkg.exports, entry);
    if (resolved) serverEntryRel = resolved.replace(/^\.\//, "");
  }
  const findings = [
    ...checkManifestShape(pkg),
    ...checkImportBan(pkg, sources),
    ...checkHostPeerValueImportBan(pkg, sources, serverEntryRel),
    ...checkDepsSdkOnly(pkg),
    ...checkReadme(pkg, sources, readme),
    ...checkLicense(pkg),
    ...checkServerEntryPreflight(pkg, files),
  ];
  return { ok: findings.length === 0, findings };
}
