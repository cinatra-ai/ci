import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

for (const name of ["actions-pinned-gate", "gitignore-gate", "source-leak-gate"]) {
  const workflow = load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const input = workflow.on.workflow_call.inputs.use_slim;
  const job = workflow.jobs[name];
  const expression = job["runs-on"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");

  test(`${name}: existing callers retain the standard runner`, () => {
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
    assert.equal(runInNewContext(expression, { inputs: { use_slim: input.default } }), "ubuntu-latest");
    assert.equal(runInNewContext(expression, { inputs: {} }), "ubuntu-latest");
  });

  test(`${name}: opt-in retains a bounded read-only gate on the slim runner`, () => {
    assert.equal(runInNewContext(expression, { inputs: { use_slim: true } }), "ubuntu-slim");
    assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.equal(job["continue-on-error"], undefined);
    assert.ok(job.steps.some(step => step.run?.includes(`scripts/${name}.mjs`)));
  });
}
