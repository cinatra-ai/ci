// ---------------------------------------------------------------------------
// html-text — extract the PROSE of an HTML page as a flat string, together with
// a per-character map back to the SOURCE byte offsets (cinatra-ai/docs#160).
//
// WHY THIS EXISTS. The meta-commentary gate's pattern list is written against
// prose. Run naively over HTML source it would both miss real violations (a
// phrase split by an inline tag, or written with an entity) and invent fake ones
// (a class name, a URL fragment, a minified script). This module defines ONE
// explicit, documented extraction contract so the gate's HTML behaviour is
// specified rather than improvised, and so a reported violation always points at
// a real SOURCE line a human can open and fix.
//
// THE CONTRACT, per construct (docs#160 AC1). Each is a deliberate decision, not
// an accident of the parser:
//
//   VISIBLE TEXT NODES — IN SCOPE. This is the published prose; it is the whole
//     point of the gate.
//
//   HTML COMMENTS (`<!-- … -->`) — IN SCOPE. A comment is not rendered, but it
//     ships in the published bytes, is trivially readable with "view source",
//     and is exactly where authoring annotations accumulate. Treating them as
//     out of scope would leave the largest class of in-page annotation
//     unenforced. Comments carrying a CI DIRECTIVE (`<!-- source-leak-allow -->`
//     and the like) are ordinary text to this module: they are short machine
//     tokens that no meta-commentary pattern matches, so scanning them costs
//     nothing and removing them silently would change what another check
//     enforces.
//
//   TAG ATTRIBUTES — OUT OF SCOPE, except the small set that renders or is
//     announced as human-readable text: `title`, `alt`, `aria-label`,
//     `aria-description`, `placeholder`, `summary`, and `content` on a
//     `<meta name="description">`. Everything else (`href`, `src`, `class`,
//     `id`, `style`, `data-*`, …) is machine addressing, not prose: a URL
//     fragment or a CSS class that happens to contain a pattern's letters is not
//     a published claim about anything.
//
//   `<script>` AND `<style>` CONTENT — OUT OF SCOPE, entirely. Both are code.
//     A comment inside a script is a code comment, and CSS content strings are
//     styling. Neither is prose a reader can be misled by.
//
//   HTML ENTITIES — DECODED BEFORE MATCHING. `generated&nbsp;from`,
//     `canonical&#32;source` and `&#x72;uling` are the same claims as their
//     plain spellings, so an author could otherwise evade a pattern by
//     accident (an editor that entity-escapes) or on purpose. Named entities
//     come from a small table; numeric decimal/hex entities are decoded
//     generally. `&nbsp;` (and its numeric spellings) decode to a PLAIN SPACE
//     rather than U+00A0: the pattern list's gaps are `[ \t]` runs, and a
//     no-break space would silently defeat every one of them. An unknown entity
//     is left literal.
//
//   MATCHES ACROSS A TAG BOUNDARY — INLINE tags are TRANSPARENT: they emit
//     nothing, so `this page is <b>generated</b> from …` extracts as one
//     sentence and matches exactly as its unmarked twin does. BLOCK-level tags
//     are a HARD SEPARATOR: they emit TWO newlines. Every pattern in the list
//     tolerates at most ONE hard wrap inside a gap, so a double newline makes it
//     structurally impossible to join prose from two different blocks — the HTML
//     analogue of the Markdown wrap guard that refuses to join adjacent list
//     items, headings, quotes and table rows.
//
//   MATCHES ACROSS A HARD WRAP — text nodes keep their own whitespace verbatim,
//     newlines included, so a phrase an author wrapped mid-sentence behaves
//     exactly as it does in Markdown (the patterns' one-wrap tolerance applies).
//
// REPORTING STAYS ON THE SOURCE. `map[i]` is the source index the extracted
// character came from, so a match at extracted index i reports
// `sourceLine(map[i])` and pins the allowlist to the full SOURCE line. Decoded
// entities map every produced character to the entity's opening `&`; synthesized
// separators map to the tag that produced them. There is therefore no extracted
// position without a source position.
//
// NOT A CONFORMANT HTML PARSER, deliberately. This is a single-pass scanner over
// well-formed authored pages: no tree building, no error recovery, no implied
// end tags, no template/foreign-content rules. It is the same "cheap on purpose"
// posture as the pattern list itself — the failure mode of a mis-scan is a
// missed or extra match on one page, not a wrong claim about the source.
//
// Node builtins only; no runtime dependencies.
// ---------------------------------------------------------------------------

// Elements whose content is raw text, not markup, and which are OUT of scope.
const RAW_TEXT_SKIP = new Set(["script", "style"]);

// INLINE elements: transparent, emit nothing, so a phrase split across one is
// rejoined. Anything not listed here is treated as BLOCK (a hard separator) —
// failing toward "do not join", which can only ever cost a missed match, never
// invent one that spans unrelated blocks.
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "data", "del", "dfn",
  "em", "font", "i", "ins", "kbd", "mark", "meter", "nobr", "output", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strike", "strong",
  "sub", "sup", "time", "tt", "u", "var", "wbr",
]);

// Attributes that carry human-readable text (rendered, or announced by a screen
// reader). Everything else is machine addressing and is not scanned.
const TEXT_ATTRS = new Set([
  "title", "alt", "aria-label", "aria-description", "placeholder", "summary",
]);

// The named entities that actually occur in authored prose. An unknown entity is
// left literal — silently dropping it would corrupt the text and shift nothing
// but our own accuracy.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // U+00A0 deliberately normalized to a plain space (see the header note).
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", bull: "•", middot: "·",
  times: "×", divide: "÷", deg: "°", sect: "§",
  para: "¶", dagger: "†", copy: "©", reg: "®",
  trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
  larr: "←", rarr: "→", harr: "↔", darr: "↓", uarr: "↑",
  le: "≤", ge: "≥", ne: "≠", minus: "−", plusmn: "±",
};

// A no-break space produced by a NUMERIC entity gets the same normalization as
// `&nbsp;`, for the same reason.
function normalizeChar(ch) {
  return ch === " " ? " " : ch;
}

// An accumulating (text, map) pair. `map[i]` is the source index that produced
// extracted character i.
class Extracted {
  constructor() {
    this.chunks = [];
    this.map = [];
    this.length = 0;
  }

  // Append `str`, attributing every character to source index `srcIndex`
  // (used for decoded entities and synthesized separators).
  pushAt(str, srcIndex) {
    if (str.length === 0) return;
    this.chunks.push(str);
    for (let i = 0; i < str.length; i++) this.map.push(srcIndex);
    this.length += str.length;
  }

  // Append a verbatim source run [start, end), attributing each character to its
  // own source index.
  pushRun(source, start, end) {
    if (end <= start) return;
    this.chunks.push(source.slice(start, end));
    for (let i = start; i < end; i++) this.map.push(i);
    this.length += end - start;
  }

  finish() {
    return { text: this.chunks.join(""), map: this.map };
  }
}

// Decodes entities in source[start,end) into `out`, keeping the source mapping.
function pushDecoded(out, source, start, end) {
  let run = start;
  let i = start;
  while (i < end) {
    if (source.charCodeAt(i) !== 38 /* & */) {
      i++;
      continue;
    }
    const semi = source.indexOf(";", i + 1);
    // An entity reference is short; a distant ";" is punctuation, not a
    // terminator. 12 covers every name in the table plus a hex code point.
    if (semi === -1 || semi >= end || semi - i > 12) {
      i++;
      continue;
    }
    const body = source.slice(i + 1, semi);
    let decoded = null;
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits.length > 0 && (hex ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits)) {
        const code = parseInt(digits, hex ? 16 : 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            decoded = normalizeChar(String.fromCodePoint(code));
          } catch {
            decoded = null; // lone surrogate / out of range: leave literal
          }
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      decoded = NAMED_ENTITIES[body];
    }
    if (decoded === null) {
      i++;
      continue;
    }
    out.pushRun(source, run, i);
    out.pushAt(decoded, i);
    i = semi + 1;
    run = i;
  }
  out.pushRun(source, run, end);
}

// Parses a start/end tag beginning at `<` (source[start] === "<"). Returns
// { name, isEnd, attrs: [{name, valueStart, valueEnd}], end } where `end` is the
// index just past the closing ">", or null when this is not a tag.
function readTag(source, start) {
  let i = start + 1;
  let isEnd = false;
  if (source[i] === "/") {
    isEnd = true;
    i++;
  }
  const nameStart = i;
  while (i < source.length && /[A-Za-z0-9:-]/.test(source[i])) i++;
  if (i === nameStart) return null; // "<" in prose, e.g. "a < b"
  const name = source.slice(nameStart, i).toLowerCase();
  const attrs = [];
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;
    const c = source[i];
    if (c === ">") return { name, isEnd, attrs, end: i + 1 };
    if (c === "/" && source[i + 1] === ">") return { name, isEnd, attrs, end: i + 2 };
    const aStart = i;
    while (i < source.length && !/[\s=>/]/.test(source[i])) i++;
    if (i === aStart) {
      i++; // stray character: skip it rather than spin
      continue;
    }
    const aName = source.slice(aStart, i).toLowerCase();
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== "=") {
      attrs.push({ name: aName, valueStart: -1, valueEnd: -1 });
      continue;
    }
    i++; // "="
    while (i < source.length && /\s/.test(source[i])) i++;
    const quote = source[i];
    let vStart;
    let vEnd;
    if (quote === '"' || quote === "'") {
      vStart = i + 1;
      vEnd = source.indexOf(quote, vStart);
      if (vEnd === -1) return null; // unterminated: treat "<" as prose
      i = vEnd + 1;
    } else {
      vStart = i;
      while (i < source.length && !/[\s>]/.test(source[i])) i++;
      vEnd = i;
    }
    attrs.push({ name: aName, valueStart: vStart, valueEnd: vEnd });
  }
  return null; // unterminated tag
}

/**
 * Extracts the prose of an HTML document per the contract documented above.
 *
 * @param {string} source raw file content
 * @returns {{ text: string, map: number[] }} extracted prose and, for every
 *   extracted character, the source index it came from.
 */
export function extractHtmlText(source) {
  const out = new Extracted();
  let i = 0;
  let run = 0; // start of the pending verbatim text run

  const flushText = (until) => {
    if (until > run) pushDecoded(out, source, run, until);
  };

  while (i < source.length) {
    if (source.charCodeAt(i) !== 60 /* < */) {
      i++;
      continue;
    }

    // Comment: IN SCOPE, scanned as text.
    if (source.startsWith("<!--", i)) {
      flushText(i);
      const close = source.indexOf("-->", i + 4);
      const bodyEnd = close === -1 ? source.length : close;
      // Block separators around it: a comment is its own block, never spliced
      // into the prose on either side.
      out.pushAt("\n\n", i);
      pushDecoded(out, source, i + 4, bodyEnd);
      out.pushAt("\n\n", bodyEnd);
      i = close === -1 ? source.length : close + 3;
      run = i;
      continue;
    }

    // Doctype / CDATA / other declaration: not prose.
    if (source.startsWith("<!", i)) {
      flushText(i);
      const close = source.indexOf(">", i + 2);
      out.pushAt("\n\n", i);
      i = close === -1 ? source.length : close + 1;
      run = i;
      continue;
    }

    // Processing instruction.
    if (source.startsWith("<?", i)) {
      flushText(i);
      const close = source.indexOf(">", i + 2);
      out.pushAt("\n\n", i);
      i = close === -1 ? source.length : close + 1;
      run = i;
      continue;
    }

    const tag = readTag(source, i);
    if (!tag) {
      i++; // a literal "<" in prose
      continue;
    }

    flushText(i);

    // <script> / <style>: skip the whole element, content included.
    if (!tag.isEnd && RAW_TEXT_SKIP.has(tag.name)) {
      const closeRe = new RegExp(`</${tag.name}\\s*>`, "i");
      const rest = source.slice(tag.end);
      const m = closeRe.exec(rest);
      out.pushAt("\n\n", i);
      i = m ? tag.end + m.index + m[0].length : source.length;
      run = i;
      continue;
    }

    // Separator: inline tags are transparent; everything else is a hard break.
    out.pushAt(INLINE_TAGS.has(tag.name) ? "" : "\n\n", i);

    // Human-readable attribute values are prose and are scanned; each is its own
    // block so an attribute can never splice into surrounding text.
    if (!tag.isEnd) {
      const isMeta = tag.name === "meta";
      let metaName = "";
      if (isMeta) {
        const nameAttr = tag.attrs.find((a) => a.name === "name" && a.valueStart >= 0);
        if (nameAttr) metaName = source.slice(nameAttr.valueStart, nameAttr.valueEnd).toLowerCase();
      }
      for (const attr of tag.attrs) {
        if (attr.valueStart < 0) continue;
        const scanned =
          TEXT_ATTRS.has(attr.name) ||
          (isMeta && attr.name === "content" && (metaName === "description" || metaName === "keywords"));
        if (!scanned) continue;
        out.pushAt("\n\n", attr.valueStart);
        pushDecoded(out, source, attr.valueStart, attr.valueEnd);
        out.pushAt("\n\n", attr.valueEnd);
      }
    }

    i = tag.end;
    run = i;
  }
  flushText(source.length);
  return out.finish();
}

export const HTML_EXTENSIONS = [".html", ".htm"];

export function isHtmlPath(p) {
  const lower = p.toLowerCase();
  return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
