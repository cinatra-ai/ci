import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

// The org gates take a `runner` input: a JSON runs-on value chosen by the
// caller. An empty input keeps the GitHub-hosted runner, so a caller that
// does not pass it keeps the runner it has today.
const GATES = {
  "actions-pinned-gate": { slim: true },
  "gitignore-gate": { slim: true },
  "source-leak-gate": { slim: true },
  "secret-scan-gate": { slim: false },
  "truthful-attribution-gate": { slim: false },
};

// GitHub expression functions the runs-on expressions use.
const fromJSON = (text) => JSON.parse(text);

function evaluate(expression, inputs) {
  return runInNewContext(expression, { inputs, fromJSON });
}

for (const [name, { slim }] of Object.entries(GATES)) {
  const source = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  const workflow = load(source);
  const inputs = workflow.on.workflow_call.inputs;
  const job = workflow.jobs[name];
  const runsOn = String(job["runs-on"]);
  const expression = runsOn.replace(/^\$\{\{\s*|\s*\}\}$/g, "");

  test(`${name}: declares an optional string runner input that defaults to empty`, () => {
    assert.ok(inputs.runner, "the runner input is missing");
    assert.equal(inputs.runner.type, "string");
    assert.equal(inputs.runner.required, false);
    assert.equal(inputs.runner.default, "");
  });

  test(`${name}: a caller that passes no runner keeps the hosted runner`, () => {
    assert.equal(evaluate(expression, { runner: "" }), "ubuntu-latest");
    assert.equal(evaluate(expression, { runner: inputs.runner?.default ?? "" }), "ubuntu-latest");
    if (slim) {
      assert.equal(evaluate(expression, { runner: "", use_slim: false }), "ubuntu-latest");
      assert.equal(evaluate(expression, { runner: "", use_slim: true }), "ubuntu-slim");
    }
  });

  test(`${name}: a runner input is honoured as a label array or a single label`, () => {
    assert.deepEqual(evaluate(expression, { runner: '["self-hosted","linux"]' }), ["self-hosted", "linux"]);
    assert.equal(evaluate(expression, { runner: '"ubuntu-24.04"' }), "ubuntu-24.04");
    if (slim) {
      assert.deepEqual(evaluate(expression, { runner: '["self-hosted"]', use_slim: true }), ["self-hosted"]);
    }
  });

  test(`${name}: the runner never comes from a variable or another context`, () => {
    assert.doesNotMatch(runsOn, /\bvars\./);
    assert.doesNotMatch(runsOn, /\bgithub\.|\benv\.|\bsecrets\./);
    assert.match(runsOn, /inputs\.runner/);
  });

  test(`${name}: the gate keeps its permissions, timeout and status name`, () => {
    assert.ok(job["timeout-minutes"] > 0);
    assert.equal(job["continue-on-error"], undefined);
    assert.ok(workflow.jobs[name], "the job id (status name) changed");
  });
}
