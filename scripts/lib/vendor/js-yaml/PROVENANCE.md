# Vendored: js-yaml

`js-yaml.mjs` in this directory is an unmodified copy of the single-file ESM
build published in the `js-yaml` npm package. The gate engine
(`scripts/source-leak-gate.mjs`) imports it with a relative `import`, because the
engine runs inside consuming repositories' CI with no `npm install` step: it may
only import files committed under `scripts/`.

| field | value |
| --- | --- |
| package | `js-yaml` |
| version | `4.1.0` |
| licence | MIT (`LICENSE` beside this file) |
| registry tarball | `https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz` |
| tarball `dist.integrity` | `sha512-wpxZs9NoxZaJESJGIZTyDEaYpl0FKSA+FB9aJiyemKhMwkxQg63h4T1KJgUGHpTqPDNRcmmYLugrRjJlBtWvRA==` |
| vendored file | `js-yaml.mjs`, copied from `package/dist/js-yaml.mjs` inside that tarball |
| vendored file sha256 | `16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91` |
| vendored on | 2026-08-29 |

The sha256 above is the contract: `scripts/__tests__/source-leak-gate.test.mjs`
recomputes the digest of `js-yaml.mjs` and compares it with the value in this
file, so an edit to either side without the other fails the test suite.

## Refresh procedure

1. `npm pack js-yaml@<version>` in an empty directory, and confirm the tarball's
   sha512, base64-encoded, equals the `dist.integrity` that
   `npm view js-yaml@<version> dist.integrity` reports.
2. `tar xzf js-yaml-<version>.tgz` and compare `package/dist/js-yaml.mjs` with
   the committed `js-yaml.mjs` (`diff`), then copy it over together with
   `package/LICENSE`.
3. `shasum -a 256 scripts/lib/vendor/js-yaml/js-yaml.mjs`, and update the
   version, tarball URL, integrity, digest and date in the table above.
4. `node --test scripts/__tests__/source-leak-gate.test.mjs` — the drift test
   named in the table must pass, and the gate's own YAML tests must stay green.

The copy is never edited in place. Anything the engine needs beyond the
published build belongs in the engine, not here.
