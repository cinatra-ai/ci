// ---------------------------------------------------------------------------
// docs-contract-rules — the host-tree-INDEPENDENT rule library for the
// integration docs-contract gate (cinatra-ai/ci#39). Pure functions, Node
// builtins only, zero registry dependency. Validates ONE integration `docs/`
// directory against the docs contract authored in cinatra-ai/docs (docs#51) and
// compiled by the docs publish path (ops#378):
//
//   - the fixed 6-page set (exact slugs/filenames),
//   - the required frontmatter schema + enumerated value domains,
//   - slug == registry slug (the page slug must equal the integration's
//     registry slug; passed in via --slug; every page must share it),
//   - allowed content: Markdown + static assets only — NO MDX, no arbitrary
//     imports, no code execution (untrusted-repo content crosses into a trusted
//     build, so MDX/JSX/import/export are rejected for v1 per the design),
//   - link policy: relative links resolve INSIDE the integration's own docs;
//     cross-chapter links MUST be absolute canonical (https://docs.cinatra.ai/…
//     or a root-absolute /guides|/references path) — never a relative `../`
//     escape out of the integration, and never a private-repo / file:// link,
//   - asset path/size rules + stable filenames.
//
// The gate NEVER fetches anything and NEVER reads outside the docs dir — all
// checks are static and offline (no private-repo access), exactly as ci#39 asks.
// ---------------------------------------------------------------------------

// The fixed 6-page set. Order is the canonical reader flow (Overview first); the
// `navOrder` frontmatter must agree with this order (1-based).
export const REQUIRED_PAGES = [
  "overview.md",
  "quick-start.md",
  "use-it.md",
  "settings-and-permissions.md",
  "troubleshooting.md",
  "advanced-and-reference.md",
];

// navOrder canonical index per filename (1-based, matches REQUIRED_PAGES order).
export const NAV_ORDER = Object.fromEntries(REQUIRED_PAGES.map((f, i) => [f, i + 1]));

// Required frontmatter keys (every page). Mirrors docs#51 / the issue exactly.
export const REQUIRED_FRONTMATTER = [
  "slug",
  "title",
  "description",
  "navOrder",
  "tier",
  "lifecycle",
  "cinatraCompat",
  "integrationVersion",
  "sourceRepo",
  "supportUrl",
  "marketplaceUrl",
];

// Enumerated value domains. tier ∈ {first-party} only — third-party never
// compiles into the hub (design §1). lifecycle ∈ the four states; only `active`
// renders, but draft/deprecated/retired are still VALID frontmatter values
// (the publish path filters by lifecycle, the gate only validates the domain).
export const TIER_VALUES = new Set(["first-party"]);
export const LIFECYCLE_VALUES = new Set(["draft", "active", "deprecated", "retired"]);

// A registry slug: lowercase kebab, the same grammar as a URL path segment, so
// `/integrations/<slug>/` is stable and collision-free.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Static-asset extensions allowed alongside the Markdown pages. No executables,
// no scripts, no html (html could carry inline script) — images + a few inert
// doc assets only.
export const ALLOWED_ASSET_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
]);

// Per-asset byte ceiling (1 MiB) and total-asset ceiling (8 MiB) — keeps the
// flattened public/ bundle bounded (design gap #5: namespace + bound assets).
export const MAX_ASSET_BYTES = 1_048_576;
export const MAX_TOTAL_ASSET_BYTES = 8 * 1_048_576;

// A page body over this size is implausible real docs content → fail closed
// (parity with the ioc gate's oversize guard).
export const MAX_PAGE_BYTES = 1_000_000;

// Stable-filename grammar for any file under docs/ (pages + assets + nested
// asset dirs): lowercase, kebab, no spaces/uppercase → stable URLs.
export const STABLE_NAME_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

// Absolute links + frontmatter URLs MUST be https (not http) — the contract is
// secure canonical links only (codex MUST-FIX).
const HTTPS_ABS_RE = /^https:\/\//i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// ---------------------------------------------------------------------------
// Frontmatter parsing — a deliberately small, dependency-free YAML-subset
// parser. The contract frontmatter is flat scalar key: value pairs (strings,
// integers); we do NOT accept nested maps/sequences/anchors/multi-doc — anything
// richer is rejected as malformed, which is correct for this fixed schema.

/** Split a Markdown file into { frontmatter: rawText|null, body }. Frontmatter
 * is a leading `---\n … \n---` block (the very first bytes of the file). */
export function splitFrontmatter(text) {
  // Normalize CRLF so the fence regex is newline-style agnostic.
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { frontmatter: null, body: norm };
  // The closing fence must be a line that is EXACTLY `---` (a `--- x` line or a
  // `----` line is not a closing fence) — find the first such line after the
  // open fence (codex MUST-FIX: exact-match closing fence).
  const lines = norm.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { closeIdx = i; break; }
  }
  if (closeIdx === -1) return { frontmatter: null, body: norm };
  const raw = lines.slice(1, closeIdx).join("\n") + "\n";
  const body = lines.slice(closeIdx + 1).join("\n");
  return { frontmatter: raw, body };
}

/** Parse the flat scalar frontmatter block to an object, or throw on a shape we
 * refuse to interpret. Values: bare scalar, single- or double-quoted string,
 * integer. No nesting, no lists, no block scalars. */
export function parseFrontmatter(raw) {
  const obj = {};
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      throw new Error(`indented/nested frontmatter is not allowed (line ${i + 1}: "${line.trim()}")`);
    }
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!m) throw new Error(`malformed frontmatter line ${i + 1}: "${line.trim()}"`);
    const key = m[1];
    // Reject duplicate keys outright — a duplicate could shadow a validated
    // value with an unvalidated one (codex MUST-FIX).
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`duplicate frontmatter key "${key}" (line ${i + 1})`);
    }
    let val = m[2].trim();
    if (val === "" ) { obj[key] = ""; continue; }
    // Reject YAML tags (`!!str`, `!Foo`) + the structural sigils we don't
    // interpret (lists, maps, block scalars, anchors/aliases, merge keys).
    if (val.startsWith("!") || val.startsWith("[") || val.startsWith("{") || val.startsWith("|") || val.startsWith(">") || val.startsWith("&") || val.startsWith("*")) {
      throw new Error(`unsupported frontmatter value for "${key}" (YAML tags, lists, maps, block scalars and anchors are not allowed)`);
    }
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    } else if (/^-?\d+$/.test(val)) {
      val = Number(val);
    }
    obj[key] = val;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Content-policy + link checks (per-page body).

// Inline-code spans use a bounded char class (no DoS); fenced blocks are removed
// LINE-WISE (below) rather than by a backtracking `[\s\S]*?` regex.
const INLINE_CODE_RE = /`[^`\n]{0,2000}`/g;

/** Strip fenced + inline code so we don't flag `import` inside a code sample or
 * a link-looking token inside a snippet. Fenced blocks (``` or ~~~, any indent,
 * any info string) are removed line-wise so an UNCLOSED fence still suppresses
 * everything after it (fail-closed: an attacker can't "open" a fence to hide
 * the ban, because an unclosed fence hides nothing real after it either). */
function stripCode(body) {
  const lines = body.split("\n");
  const out = [];
  let fence = null; // the active fence marker (``` or ~~~) or null
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // inside a fence: a line whose marker matches/extends the opener closes it
      if (m && line.trim().startsWith(fence[0]) && m[1][0] === fence[0]) fence = null;
      continue; // drop the line (it is code or the closing fence)
    }
    if (m) { fence = m[1]; continue; } // opening fence; drop it
    out.push(line);
  }
  return out.join("\n").replace(INLINE_CODE_RE, "");
}

// MDX / JS surface that must NOT appear in v1 docs (outside code fences). ESM
// import/export, JSX component tags, and `{expression}` braces are all build-time
// code surface in MDX — ALL banned so untrusted content can't execute in the
// trusted build (design delta: MDX disallowed for v1). These are deliberately
// BROAD / fail-closed: we'd rather reject an unusual-but-innocent construct than
// miss a smuggled one. The `m` flag + start-of-line anchors catch indented forms
// and the `s`-free patterns avoid runaway matching.
const ESM_IMPORT_RE = /^[ \t]*import\b/m;       // any leading `import` (from/bare/multiline)
const ESM_EXPORT_RE = /^[ \t]*export\b/m;       // any leading `export` (incl `export *`)
// JSX component tag (open or close). A tag is a JSX COMPONENT (banned) — vs a
// plain HTML element like `<a>`/`<img>` (allowed Markdown-embedded HTML, whose
// URLs the link scanner handles) — when its name:
//   • starts with an uppercase letter, `_`, or `$`  (`<Foo>`, `<_Foo>`, `<$Foo>`)
//   • OR is a dotted MEMBER expression                (`<foo.Bar>`, `<Foo.Bar>`)
// Both forms are JSX-only and never valid plain HTML.
const JSX_IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const JSX_TAG_RE = new RegExp(
  `<\\/?(?:` +
    `[A-Z_$][A-Za-z0-9_$]*(?:\\.${JSX_IDENT})*` + // capitalized/_/$ leader, opt. members
    `|${JSX_IDENT}(?:\\.${JSX_IDENT})+` +          // OR any dotted member expression
  `)[\\s/>]`,
);
// `{…}` MDX expression: we do NOT bound the inner length (a long expr must not
// bypass). An UNESCAPED `{` is the banned signal — Markdown almost never needs a
// literal brace and can escape it as `\{`. We detect a `{` that is not preceded
// by a backslash (linear scan, no backtracking). The matching `}` is irrelevant
// to the ban (an open brace alone is already MDX surface / fail-closed).
const MDX_BRACE_RE = /(^|[^\\])\{/;

/** Return the set of MDX/code-execution findings for a page body. */
export function checkContentPolicy(body) {
  const findings = [];
  const code = stripCode(body);
  if (ESM_IMPORT_RE.test(code)) {
    findings.push("contains an `import` statement (MDX/JS is not allowed; Markdown + static assets only)");
  }
  if (ESM_EXPORT_RE.test(code)) {
    findings.push("contains an `export` statement (MDX/JS is not allowed)");
  }
  if (JSX_TAG_RE.test(code)) {
    findings.push("contains a JSX/MDX component tag (`<Capitalized …>`; only Markdown is allowed)");
  }
  if (MDX_BRACE_RE.test(code)) {
    findings.push("contains an unescaped `{` (MDX expression surface; escape it as `\\{` if you need a literal brace)");
  }
  return findings;
}

/** Classify and validate a single link/image target found in a page body.
 * `target` is the raw URL inside `(…)`. Returns null if OK, else a message.
 * `localFiles` is the Set of docs-relative paths that exist (for relative-link
 * resolution); `pageRel` is the docs-relative path of the page being checked. */
export function checkLinkTarget(target, { localFiles, pageRel, isImage }) {
  const t = target.trim();
  if (t === "") return "empty link target";

  // Fragment-only or mailto/tel — allowed, no resolution needed.
  if (t.startsWith("#")) return null;
  if (/^(mailto:|tel:)/i.test(t)) return null;

  // Absolute https: allowed for OUTBOUND references (support pages, source repo)
  // and for canonical cross-chapter links (docs.cinatra.ai). https ONLY.
  if (HTTPS_ABS_RE.test(t)) return null;
  if (ANY_SCHEME_RE.test(t)) {
    // any other scheme (http:, file:, ftp:, data:, javascript:, etc.)
    return `disallowed link scheme: "${t}" (use an https URL or a relative in-docs link; plain http is not allowed)`;
  }

  // Protocol-relative `//host/x` is NOT a root-absolute site path — it points at
  // an arbitrary (possibly private) host with the inherited scheme. Reject it
  // (codex MUST-FIX); a real external link must be explicit `https://`.
  if (t.startsWith("//")) {
    return `protocol-relative link "${t}" is not allowed (use an explicit https URL or a root-absolute /path)`;
  }
  // Root-absolute site path (/guides/…, /references/…, /integrations/…) — the
  // canonical cross-chapter form. Allowed.
  if (t.startsWith("/")) return null;

  // Otherwise it is a RELATIVE link. It must resolve to a file INSIDE the docs
  // dir (no `../` escape out of the integration's own docs).
  const [pathPart] = t.split("#");
  if (pathPart === "") return null; // pure fragment after split
  const resolved = resolveRelative(pageRel, pathPart);
  if (resolved === null) {
    return `relative link "${t}" escapes the integration docs directory (cross-chapter links must be absolute canonical)`;
  }
  // A relative .md link must target one of the 6 pages; an image/asset link must
  // target an existing asset file.
  if (!localFiles.has(resolved)) {
    return `relative ${isImage ? "image" : "link"} "${t}" does not resolve to a file inside docs/ (got "${resolved}")`;
  }
  return null;
}

/** Resolve a relative path from a page (docs-relative) against the docs root.
 * Returns the docs-relative resolved path, or null if it escapes docs/. */
export function resolveRelative(pageRel, rel) {
  const baseParts = pageRel.split("/").slice(0, -1); // dir of the page
  // Treat backslashes as separators too, so a `..\x` Windows-style escape is
  // resolved (and rejected) rather than passing through as a literal segment.
  const parts = rel.replace(/\\/g, "/").split("/");
  const out = baseParts.slice();
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null; // escaped above docs root
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

// Link/image extraction. The `\]` and `\)` bracket-content classes are BOUNDED
// (codex MUST-FIX: an unbounded `[^\]]*` is quadratic on a wall of `[`); the URL
// group stops at whitespace/`)`. The optional title accepts both "…" and '…'.
// Label class allows ONE level of nested `[...]` (e.g. `[see [advanced]](url)`)
// while staying bounded/linear. `(?:[^\[\]\n]|\[[^\[\]\n]{0,200}\]){0,500}`.
const LABEL = "(?:[^\\[\\]\\n]|\\[[^\\[\\]\\n]{0,200}\\]){0,500}";
const MD_IMAGE_RE = new RegExp(`!\\[${LABEL}\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+["'][^"'\\n]{0,300}["'])?\\s*\\)`, "g");
const MD_LINK_RE = new RegExp(`\\[${LABEL}\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+["'][^"'\\n]{0,300}["'])?\\s*\\)`, "g");
// Reference-style link DEFINITION: `[label]: url "title"` at line start.
const MD_REFDEF_RE = /^\s{0,3}\[[^\]\n]{0,500}\]:\s*<?([^\s>]+)>?/gm;
// Raw HTML href/src attributes (quoted OR unquoted): `<a href="x">`, `<a href='x'>`,
// `<a href=x>`. Lowercase tags aren't JSX components so the content-policy JSX
// check won't catch them — scan their URLs for the link policy.
const HTML_URL_RE = /\b(?:href|src)\s*=\s*(?:"([^"\n]{0,2000})"|'([^'\n]{0,2000})'|([^\s"'<>`]{1,2000}))/gi;

/** Extract every link + image target from a page body (code stripped). Covers
 * inline links/images, reference definitions, and raw-HTML href/src. */
export function extractTargets(body) {
  const code = stripCode(body);
  const links = [];
  const images = [];
  let m;
  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(code)) !== null) images.push(m[1]);
  // Remove image syntax before scanning links so `![](…)` isn't double-counted.
  const noImages = code.replace(MD_IMAGE_RE, "");
  for (const re of [MD_LINK_RE, MD_REFDEF_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(noImages)) !== null) links.push(m[1]);
  }
  // HTML href/src has three alternative capture groups (dq, sq, unquoted).
  HTML_URL_RE.lastIndex = 0;
  while ((m = HTML_URL_RE.exec(noImages)) !== null) links.push(m[1] ?? m[2] ?? m[3]);
  return { links, images };
}

// ---------------------------------------------------------------------------
// The whole-docs conformance entry point.

/**
 * Validate a loaded docs tree against the contract.
 * @param {object} loaded - { files:Set<rel>, pages:{rel->text}, assets:{rel->size}, oversize:string[] }
 * @param {object} opts   - { slug } the registry slug every page must declare.
 * @returns {{ findings: Array<{id,level,message}> }}
 */
export function conformDocsTree(loaded, opts = {}) {
  const findings = [];
  const add = (id, message) => findings.push({ id, level: "error", message });
  const slug = opts.slug;

  if (slug != null && !SLUG_RE.test(String(slug))) {
    add("slug-grammar", `--slug "${slug}" is not a valid registry slug (lowercase kebab, e.g. "wordpress").`);
  }

  // 1. The 6-page set: every required page present, no stray top-level .md pages.
  const presentPages = new Set();
  for (const f of REQUIRED_PAGES) {
    if (loaded.pages[f] != null) presentPages.add(f);
    else add("missing-page", `required page "${f}" is missing from docs/.`);
  }
  for (const rel of Object.keys(loaded.pages)) {
    if (rel.includes("/")) {
      add("stray-markdown", `Markdown file "${rel}" is not allowed; the only pages are the 6 contract pages at the docs/ root.`);
    } else if (!REQUIRED_PAGES.includes(rel)) {
      add("stray-markdown", `unexpected Markdown page "${rel}"; only the 6 contract pages are allowed.`);
    }
  }

  // 2. Stable filenames + allowed file kinds for every file under docs/.
  let totalAssetBytes = 0;
  for (const rel of loaded.files) {
    const segs = rel.split("/");
    const base = segs[segs.length - 1];
    const dot = base.lastIndexOf(".");
    const ext = dot === -1 ? "" : base.slice(dot).toLowerCase();
    for (const seg of segs) {
      if (!STABLE_NAME_RE.test(seg)) {
        add("unstable-filename", `"${rel}" has a non-stable path segment "${seg}" (use lowercase-kebab, no spaces/uppercase).`);
        break;
      }
    }
    if (ext === ".md") continue; // pages handled above
    if (ALLOWED_ASSET_EXT.has(ext)) {
      const size = loaded.assets[rel] ?? 0;
      totalAssetBytes += size;
      if (size > MAX_ASSET_BYTES) {
        add("asset-too-large", `asset "${rel}" is ${size} bytes (> ${MAX_ASSET_BYTES} byte limit).`);
      }
      // Assets must live under docs/assets/ to namespace them per integration.
      if (!rel.startsWith("assets/")) {
        add("asset-location", `asset "${rel}" must live under docs/assets/ (namespaced per integration).`);
      }
    } else {
      add("disallowed-file", `file "${rel}" has a disallowed type "${ext || "(none)"}"; only Markdown pages and ${[...ALLOWED_ASSET_EXT].join(", ")} assets are allowed.`);
    }
  }
  if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
    add("assets-too-large", `total asset size ${totalAssetBytes} bytes exceeds the ${MAX_TOTAL_ASSET_BYTES} byte budget.`);
  }
  for (const rel of loaded.oversize ?? []) {
    add("page-too-large", `"${rel}" exceeds ${MAX_PAGE_BYTES} bytes and cannot be validated.`);
  }

  const localFiles = loaded.files; // Set of docs-relative paths

  // 3. Per-page: frontmatter + content policy + links.
  for (const rel of REQUIRED_PAGES) {
    const text = loaded.pages[rel];
    if (text == null) continue; // already reported missing
    const { frontmatter, body } = splitFrontmatter(text);
    if (frontmatter == null) {
      add("no-frontmatter", `"${rel}" is missing the leading \`---\` frontmatter block.`);
    } else {
      let fm;
      try {
        fm = parseFrontmatter(frontmatter);
      } catch (e) {
        add("frontmatter-malformed", `"${rel}": ${e.message}`);
        fm = null;
      }
      if (fm) validateFrontmatter(rel, fm, slug, add);
    }
    // content policy (MDX/code-exec ban)
    for (const msg of checkContentPolicy(body)) {
      add("content-policy", `"${rel}" ${msg}.`);
    }
    // links + images
    const { links, images } = extractTargets(body);
    for (const target of links) {
      const msg = checkLinkTarget(target, { localFiles, pageRel: rel, isImage: false });
      if (msg) add("link", `"${rel}": ${msg}`);
    }
    for (const target of images) {
      const msg = checkLinkTarget(target, { localFiles, pageRel: rel, isImage: true });
      if (msg) add("link", `"${rel}": ${msg}`);
    }
  }

  return { findings };
}

/** Validate one page's parsed frontmatter object against the schema. */
export function validateFrontmatter(rel, fm, slug, add) {
  for (const key of REQUIRED_FRONTMATTER) {
    if (!(key in fm) || fm[key] === "" || fm[key] == null) {
      add("frontmatter-missing", `"${rel}" frontmatter is missing required key "${key}".`);
    }
  }
  if ("tier" in fm && !TIER_VALUES.has(String(fm.tier))) {
    add("frontmatter-tier", `"${rel}" tier "${fm.tier}" is invalid (only "first-party" compiles into the hub).`);
  }
  if ("lifecycle" in fm && !LIFECYCLE_VALUES.has(String(fm.lifecycle))) {
    add("frontmatter-lifecycle", `"${rel}" lifecycle "${fm.lifecycle}" is invalid (one of ${[...LIFECYCLE_VALUES].join(", ")}).`);
  }
  if ("navOrder" in fm) {
    const expected = NAV_ORDER[rel];
    if (typeof fm.navOrder !== "number" || fm.navOrder !== expected) {
      add("frontmatter-navorder", `"${rel}" navOrder must be ${expected} (was ${JSON.stringify(fm.navOrder)}).`);
    }
  }
  if ("slug" in fm && fm.slug !== "" && fm.slug != null) {
    if (!SLUG_RE.test(String(fm.slug))) {
      add("frontmatter-slug-grammar", `"${rel}" slug "${fm.slug}" is not a valid registry slug.`);
    }
    if (slug != null && String(fm.slug) !== String(slug)) {
      add("frontmatter-slug-mismatch", `"${rel}" slug "${fm.slug}" does not equal the registry slug "${slug}".`);
    }
  }
  // sourceRepo + marketplaceUrl + supportUrl must be absolute URLs (no leaking a
  // local/private path); integrationVersion + cinatraCompat must be non-empty.
  for (const k of ["sourceRepo", "supportUrl", "marketplaceUrl"]) {
    if (k in fm && fm[k] !== "" && fm[k] != null && !HTTPS_ABS_RE.test(String(fm[k]))) {
      add("frontmatter-url", `"${rel}" ${k} "${fm[k]}" must be an absolute https URL.`);
    }
  }
}
