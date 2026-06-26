// Dogfood harness for config/ui-design-system.flat.mjs.
//
// Asserts the OUTCOME of running ESLint over the fixture tree: the negative
// fixtures must produce reports (nonzero) and the positive controls must
// produce none. The fixture-root eslint.config.mjs spreads the preset the
// same way a consuming repo does.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint, Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";

import {
  uiDesignSystem,
  RAW_JSX_RESTRICTIONS,
  DYNAMIC_IMPORT_BANS,
  RADIX_BAN,
  UI_LIB_BAN,
  DRIZZLE_CLIENT_BAN,
  GRID_LAYOUT_BAN,
} from "../../config/ui-design-system.flat.mjs";

const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "ui-design-system",
);

const WARN = 1;
const ERROR = 2;

const eslint = new ESLint({
  cwd: FIXTURE_ROOT,
  overrideConfigFile: path.join(FIXTURE_ROOT, "eslint.config.mjs"),
});

async function lintFixture(relativePath) {
  const results = await eslint.lintFiles([relativePath]);
  assert.equal(results.length, 1, `expected one result for ${relativePath}`);
  const [result] = results;
  for (const message of result.messages) {
    assert.equal(
      message.fatal,
      undefined,
      `parse error in ${relativePath}: ${message.message}`,
    );
  }
  return result;
}

function messagesFor(result, ruleId) {
  return result.messages.filter((message) => message.ruleId === ruleId);
}

function expectImportBan(result, substring) {
  const matching = messagesFor(result, "no-restricted-imports").filter(
    (message) => message.message.includes(substring),
  );
  assert.ok(
    matching.length > 0,
    `expected a no-restricted-imports report mentioning "${substring}", got: ${JSON.stringify(result.messages, null, 2)}`,
  );
  for (const message of matching) {
    assert.equal(message.severity, ERROR);
  }
}

function expectClean(result) {
  assert.deepEqual(
    result.messages,
    [],
    `expected zero reports for ${result.filePath}, got: ${JSON.stringify(result.messages, null, 2)}`,
  );
}

describe("negative fixtures are flagged", () => {
  it("raw <button> JSX outside ui/ is reported by the raw-JSX block (warn by default)", async () => {
    const result = await lintFixture("negative/raw-button.tsx");
    const raw = messagesFor(result, "no-restricted-syntax");
    assert.equal(raw.length, 1);
    assert.match(raw[0].message, /<button>/);
    assert.equal(raw[0].severity, WARN);
  });

  it("raw <input>/<select>/<textarea>/<a> JSX are each reported", async () => {
    const result = await lintFixture("negative/raw-form-controls.tsx");
    const raw = messagesFor(result, "no-restricted-syntax");
    for (const element of ["<input>", "<select>", "<textarea>", "<a>"]) {
      assert.ok(
        raw.some((message) => message.message.includes(element)),
        `expected a raw-JSX report for ${element}, got: ${JSON.stringify(raw, null, 2)}`,
      );
    }
    assert.equal(raw.length, 4);
  });

  it("Radix import outside ui/ is an error", async () => {
    const result = await lintFixture("negative/radix-outside-ui.tsx");
    expectImportBan(result, "Radix");
  });

  it("competing UI libraries are errors everywhere", async () => {
    const result = await lintFixture("negative/banned-ui-lib.tsx");
    const bans = messagesFor(result, "no-restricted-imports");
    assert.equal(bans.length, 2, "one report per banned import (@mui/material, styled-components)");
    expectImportBan(result, "non-shadcn UI libraries");
  });

  it("react-grid-layout outside the Drizzle Cube carve-out is an error", async () => {
    const result = await lintFixture("negative/grid-layout-outside-carveout.tsx");
    expectImportBan(result, "react-grid-layout");
  });

  it("drizzle-cube/client outside the Drizzle Cube carve-out is an error", async () => {
    const result = await lintFixture("negative/drizzle-client-outside-carveout.tsx");
    expectImportBan(result, "drizzle-cube/client");
  });

  it("Radix inside the Drizzle Cube carve-out is still an error (only client*/grid re-allowed)", async () => {
    const result = await lintFixture(
      "negative/packages/dashboards/src/components/radix-in-drizzle-carveout.tsx",
    );
    expectImportBan(result, "Radix");
  });

  it("every negative fixture produces at least one report", async () => {
    const results = await eslint.lintFiles(["negative"]);
    assert.ok(results.length >= 7, "negative fixture sweep found the fixtures");
    for (const result of results) {
      assert.ok(
        result.messages.length > 0,
        `expected reports in ${result.filePath}`,
      );
    }
  });
});

describe("Block C — dynamic-loader coverage (import()/require)", () => {
  function syntaxBans(result) {
    return messagesFor(result, "no-restricted-syntax");
  }

  it("require() of banned modules in a non-JSX file is flagged as error (no-restricted-imports never sees require)", async () => {
    const result = await lintFixture("negative/dynamic-banned-require.ts");
    assert.equal(
      messagesFor(result, "no-restricted-imports").length,
      0,
      "no-restricted-imports does not see require()",
    );
    const bans = syntaxBans(result);
    assert.equal(bans.length, 2, "one report per banned require()");
    for (const message of bans) {
      assert.equal(message.severity, ERROR);
      assert.match(message.message, /require\(\) of a banned module/);
    }
  });

  it("dynamic import() of banned modules (incl. a banned subpath) is flagged as error", async () => {
    const result = await lintFixture("negative/dynamic-banned-import.ts");
    const bans = syntaxBans(result);
    assert.equal(bans.length, 2, "one report per banned import()");
    for (const message of bans) {
      assert.equal(message.severity, ERROR);
      assert.match(message.message, /Dynamic import\(\) of a banned module/);
    }
  });

  it("inside the Drizzle Cube carve-out, a dynamic import() of @mui is still an error (only the Drizzle Cube surface is re-allowed)", async () => {
    const result = await lintFixture(
      "negative/packages/dashboards/src/components/dynamic-mui-in-drizzle-carveout.ts",
    );
    const bans = syntaxBans(result);
    assert.equal(bans.length, 1, "react-grid-layout re-allowed, @mui still banned");
    assert.equal(bans[0].severity, ERROR);
    assert.match(bans[0].message, /import\(\) of a banned module/);
  });

  it("dynamic Drizzle Cube loads inside the carve-out are clean", async () => {
    expectClean(
      await lintFixture(
        "positive/packages/dashboards/src/components/dynamic-drizzle-allowed.ts",
      ),
    );
  });

  it("dynamic Radix loads inside the shadcn-primitives carve-out are clean", async () => {
    expectClean(
      await lintFixture("positive/components/ui/dynamic-radix-allowed.ts"),
    );
  });

  it("a JSX file in the shadcn-primitives carve-out: dynamic Radix + raw elements are clean", async () => {
    expectClean(
      await lintFixture("positive/components/ui/dynamic-radix-allowed-jsx.tsx"),
    );
  });

  it("a JSX file in the shadcn-primitives carve-out still bans a dynamic @mui load (.tsx ui hole closed)", async () => {
    const result = await lintFixture(
      "negative/components/ui/dynamic-mui-in-ui-jsx.tsx",
    );
    const bans = syntaxBans(result);
    assert.equal(bans.length, 1, "Radix re-allowed, @mui still banned, raw <button> exempt");
    assert.match(bans[0].message, /import\(\) of a banned module/);
  });

  it("dynamic recharts / relative-module loads are clean everywhere", async () => {
    expectClean(await lintFixture("positive/dynamic-recharts-allowed.ts"));
  });

  it("on a JSX file the dynamic ban honors strictness (warn by default, error when ramped)", async () => {
    const code =
      'export function C(){ const m = require("@mui/material"); return m; }';
    async function lintWith(strictness) {
      const linter = new ESLint({
        cwd: FIXTURE_ROOT,
        overrideConfigFile: true,
        overrideConfig: [
          {
            files: ["**/*.{ts,tsx}"],
            languageOptions: {
              parser: tsParser,
              parserOptions: { ecmaFeatures: { jsx: true } },
            },
          },
          ...uiDesignSystem({ strictness }),
        ],
      });
      const [result] = await linter.lintText(code, {
        filePath: path.join(FIXTURE_ROOT, "app/widget.tsx"),
      });
      return result.messages.filter(
        (m) => m.ruleId === "no-restricted-syntax",
      );
    }
    const warned = await lintWith("warn");
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, WARN, "dynamic ban warns on a .tsx at strictness=warn");
    const errored = await lintWith("error");
    assert.equal(errored.length, 1);
    assert.equal(errored[0].severity, ERROR, "dynamic ban errors on a .tsx at strictness=error");
  });

  it("the dynamic ban mirrors the static no-restricted-imports ban exactly (no over/under-match)", () => {
    // Generated selectors and the authored import patterns must agree on every
    // specifier so the two blocks can never drift (the dynamic block is derived
    // from the same groups). A mismatch on a bare scope (@mui), a near-miss
    // name (antdx), or a non-carved subpath would be a real regression.
    const linter = new Linter();
    const importPatterns = [
      ...RADIX_BAN,
      ...UI_LIB_BAN,
      ...DRIZZLE_CLIENT_BAN,
      ...GRID_LAYOUT_BAN,
    ];
    const lang = {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    };
    const isStaticBanned = (spec) =>
      linter.verify(`import x from ${JSON.stringify(spec)};`, {
        languageOptions: lang,
        rules: {
          "no-restricted-imports": ["error", { patterns: importPatterns }],
        },
      }).length > 0;
    const isDynamicBanned = (spec) =>
      linter.verify(
        `const a = import(${JSON.stringify(spec)}); const b = require(${JSON.stringify(spec)});`,
        {
          languageOptions: lang,
          rules: { "no-restricted-syntax": ["error", ...DYNAMIC_IMPORT_BANS] },
        },
      ).length > 0;

    const specifiers = [
      "@mui/material",
      "@mui/material/Button",
      "@mui", // bare scope: NOT statically banned (group is @mui/*) — must match
      "@radix-ui/react-dialog",
      "@radix-ui", // bare scope: not banned
      "radix-ui",
      "radix-ui/themes",
      "radix-uix", // near-miss: not banned
      "react-grid-layout",
      "react-grid-layout/css",
      "react-grid-layoutx", // near-miss: not banned
      "styled-components",
      "styled-components/macro",
      "antd",
      "antd/lib/button",
      "antdx", // near-miss: not banned
      "@headlessui/react",
      "@chakra-ui/react",
      "@mantine/core",
      "@emotion/react",
      "drizzle-cube/client",
      "drizzle-cube/client/charts",
      "drizzle-cube/server", // not banned (only /client*)
      "drizzle-cube", // not banned
      "recharts", // allowed everywhere
      "react",
      "./local",
    ];
    for (const spec of specifiers) {
      assert.equal(
        isDynamicBanned(spec),
        isStaticBanned(spec),
        `dynamic vs static ban disagree on "${spec}"`,
      );
    }
  });
});

describe("positive controls are clean", () => {
  it("a vendored shadcn primitive (Radix import + raw <button> inside ui/) is clean", async () => {
    expectClean(await lintFixture("positive/components/ui/button.tsx"));
  });

  it("drizzle-cube/client* + react-grid-layout inside the carve-out are clean", async () => {
    expectClean(
      await lintFixture(
        "positive/packages/dashboards/src/components/dashboard-grid.tsx",
      ),
    );
  });

  it("recharts is allowed everywhere (not banned, not Drizzle-scoped)", async () => {
    expectClean(await lintFixture("positive/usage-chart.tsx"));
  });

  it("app code composing the shadcn wrappers is clean", async () => {
    expectClean(await lintFixture("positive/settings-page.tsx"));
  });

  it("deliberately-violating files under __tests__/fixtures/ are exempt", async () => {
    expectClean(
      await lintFixture("ignored/__tests__/fixtures/deliberate-violations.tsx"),
    );
  });

  it("the whole positive sweep is clean", async () => {
    const results = await eslint.lintFiles(["positive", "ignored"]);
    assert.ok(results.length >= 5, "positive sweep found the fixtures");
    for (const result of results) {
      expectClean(result);
    }
  });
});

describe("factory options", () => {
  const ENV_KEYS = [
    "UI_DESIGN_SYSTEM_UI_GLOBS",
    "UI_DESIGN_SYSTEM_DRIZZLE_CUBE_GLOBS",
    "UI_DESIGN_SYSTEM_STRICTNESS",
  ];
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function rawJsxBlock(blocks) {
    const block = blocks.find((entry) => entry.name === "ui-design-system/raw-jsx");
    assert.ok(block, "raw-jsx block present");
    return block;
  }

  it("raw-JSX severity defaults to warn and covers all five elements (plus the dynamic-loader bans)", () => {
    const [severity, ...restrictions] =
      rawJsxBlock(uiDesignSystem()).rules["no-restricted-syntax"];
    assert.equal(severity, "warn");
    // The raw-JSX block leads with exactly the five raw-element selectors...
    assert.deepEqual(restrictions.slice(0, 5), RAW_JSX_RESTRICTIONS);
    // ...then carries the everywhere dynamic-loader bans (Block C shares this
    // rule on JSX files; see the preset docblock).
    assert.deepEqual(restrictions.slice(5), DYNAMIC_IMPORT_BANS);
    assert.equal(restrictions.length, 5 + DYNAMIC_IMPORT_BANS.length);
  });

  it("strictness: error escalates the raw-JSX block only", () => {
    const blocks = uiDesignSystem({ strictness: "error" });
    assert.equal(rawJsxBlock(blocks).rules["no-restricted-syntax"][0], "error");
    const imports = blocks.find((entry) => entry.name === "ui-design-system/imports");
    assert.equal(imports.rules["no-restricted-imports"][0], "error");
  });

  it("invalid strictness throws", () => {
    assert.throws(() => uiDesignSystem({ strictness: "loose" }), /strictness/);
  });

  it("workflow env vars are honored as defaults", () => {
    process.env.UI_DESIGN_SYSTEM_STRICTNESS = "error";
    process.env.UI_DESIGN_SYSTEM_UI_GLOBS = "lib/primitives/**, widgets/ui/**";
    const blocks = uiDesignSystem();
    assert.equal(rawJsxBlock(blocks).rules["no-restricted-syntax"][0], "error");
    const carveOut = blocks.find(
      (entry) => entry.name === "ui-design-system/imports-ui-carve-out",
    );
    assert.deepEqual(carveOut.files, ["lib/primitives/**", "widgets/ui/**"]);
  });

  it("explicit options take precedence over env vars", () => {
    process.env.UI_DESIGN_SYSTEM_STRICTNESS = "error";
    const blocks = uiDesignSystem({ strictness: "warn" });
    assert.equal(rawJsxBlock(blocks).rules["no-restricted-syntax"][0], "warn");
  });

  it("globs accept arrays as well as comma-separated strings", () => {
    const blocks = uiDesignSystem({ drizzleCubeGlobs: ["apps/*/dashboards/**"] });
    const carveOut = blocks.find(
      (entry) => entry.name === "ui-design-system/imports-drizzle-cube-carve-out",
    );
    assert.deepEqual(carveOut.files, ["apps/*/dashboards/**"]);
    assert.throws(() => uiDesignSystem({ uiGlobs: " , " }), /uiGlobs/);
  });
});
