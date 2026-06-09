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

import { ESLint } from "eslint";

import {
  uiDesignSystem,
  RAW_JSX_RESTRICTIONS,
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

  it("raw-JSX severity defaults to warn and covers all five elements", () => {
    const [severity, ...restrictions] =
      rawJsxBlock(uiDesignSystem()).rules["no-restricted-syntax"];
    assert.equal(severity, "warn");
    assert.deepEqual(restrictions, RAW_JSX_RESTRICTIONS);
    assert.equal(restrictions.length, 5);
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
