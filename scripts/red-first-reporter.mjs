// node:test reporter used by red-first-gate.mjs. It writes one JSON line per
// test result (pass or fail, with the error's failure type, name, code and
// message) and one per stderr line of the test file's process, so the gate can
// tell an assertion failure from a load error without parsing human output.
// Node built-ins only.
function errorFields(error) {
  if (!error) return null;
  const cause = error.cause;
  const causeIsObject = cause !== null && typeof cause === "object";
  return {
    failureType: error.failureType ?? null,
    name: error.name ?? null,
    code: error.code ?? null,
    message: String(error.message ?? ""),
    causeName: causeIsObject ? (cause.name ?? null) : null,
    causeCode: causeIsObject ? (cause.code ?? null) : null,
    causeMessage: causeIsObject ? String(cause.message ?? "") : String(cause ?? ""),
  };
}

export default async function* redFirstReporter(source) {
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:pass" || event.type === "test:fail") {
      yield `${JSON.stringify({
        kind: "test",
        ok: event.type === "test:pass",
        name: String(data.name ?? ""),
        nesting: Number(data.nesting ?? 0),
        file: data.file ?? null,
        type: data.details?.type ?? "test",
        skip: Boolean(data.skip),
        todo: Boolean(data.todo),
        error: event.type === "test:fail" ? errorFields(data.details?.error) : null,
      })}\n`;
    } else if (event.type === "test:stderr") {
      yield `${JSON.stringify({ kind: "stderr", file: data.file ?? null, message: String(data.message ?? "") })}\n`;
    }
  }
}
