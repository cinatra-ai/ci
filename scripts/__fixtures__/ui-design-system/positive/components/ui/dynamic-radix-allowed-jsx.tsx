// Positive control: inside the shadcn-primitives carve-out, a JSX file may
// dynamically load Radix (the primitives are built on Radix) and render raw
// elements (the wrappers themselves render them). Expected: zero reports.
export function LazyDialog() {
  const dialog = require("@radix-ui/react-dialog");
  void import("radix-ui");
  return <button type="button">{dialog ? "ready" : "loading"}</button>;
}
