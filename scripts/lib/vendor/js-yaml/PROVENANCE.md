# Vendored: js-yaml

`js-yaml.mjs` in this directory is an unmodified copy of the single-file ESM
build published in the `js-yaml` npm package. The gate engine
(`scripts/source-leak-gate.mjs`) imports it with a relative `import`, because the
engine runs inside consuming repositories' CI with no `npm install` step: it may
only import files committed under `scripts/`.

| field | value |
| --- | --- |
| package | `js-yaml` |
| version | `4.1.1` |
| licence | MIT (`LICENSE` beside this file) |
| registry tarball | `https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.1.tgz` |
| tarball `dist.integrity` | `sha512-qQKT4zQxXl8lLwBtHMWwaTcGfFOZviOJet3Oy/xmGk2gZH677CJM9EvtfdSkgWcATZhj/55JZ0rmy3myCT5lsA==` |
| vendored file | `js-yaml.mjs`, copied from `package/dist/js-yaml.mjs` inside that tarball |
| vendored file sha256 | `efbc45850bf15f0c8ee3434983f512be656002d7507dc292c7ade4449b5d57fa` |
| vendored on | 2026-08-29 |

## Why the version moved

4.1.0 protected `__proto__` on a directly written mapping key but not on the
MERGE path (`<<:`), so `destination[key] = source[key]` while merging a mapping
that carries a `__proto__` key set the merge target's prototype: the parsed
document then INHERITED whatever that payload declared. 4.1.1 routes both paths
through one `setProperty` helper that defines the property instead of assigning
it. The engine reads `jobs` off parsed documents to decide carve-outs and to
read live `uses:` pins, so an inherited `jobs` is a fabricated dispatch — a
carve-out and a pin the file never declares. The engine does not rely on the
parser alone: it reads OWN properties only, refuses any document carrying a
`__proto__` / `constructor` / `prototype` mapping key at any depth, and aborts
the run outright if a parse mutates a builtin prototype.

The sha256 above is the contract: `scripts/__tests__/source-leak-gate.test.mjs`
recomputes the digest of `js-yaml.mjs` and compares it with the value in this
file, so an edit to either side without the other fails the test suite.

## Refresh procedure

1. `npm pack js-yaml@<version>` in an empty directory, and confirm the tarball's
   sha512, base64-encoded, equals the `dist.integrity` that
   `npm view js-yaml@<version> dist.integrity` reports. Never take the file from
   a local cache without that comparison; fetching the tarball URL directly
   (`curl`) and confirming the same digest is the belt-and-braces form.
2. `tar xzf js-yaml-<version>.tgz` and compare `package/dist/js-yaml.mjs` with
   the committed `js-yaml.mjs` (`diff`), then copy it over together with
   `package/LICENSE`.
3. `shasum -a 256 scripts/lib/vendor/js-yaml/js-yaml.mjs`, and update the
   version, tarball URL, integrity, digest and date in the table above, plus the
   note above saying why the version moved.
4. `node --test scripts/__tests__/source-leak-gate.test.mjs` — the drift test
   named in the table must pass, and the gate's own YAML tests must stay green.

The copy is never edited in place. Anything the engine needs beyond the
published build belongs in the engine, not here.
