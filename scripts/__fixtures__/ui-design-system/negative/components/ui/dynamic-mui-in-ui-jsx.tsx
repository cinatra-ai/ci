// Negative fixture: a JSX file inside the shadcn-primitives carve-out may load
// Radix, but a non-shadcn UI library is still banned on dynamic loads too —
// closing the .tsx ui carve-out hole (dynamic-imports-ui-carve-out only covers
// non-JSX). Expected: one no-restricted-syntax report for the @mui import().
export function StrayPrimitive() {
  const ok = require("@radix-ui/react-dialog"); // re-allowed here
  void import("@mui/material"); // still banned
  return <button type="button">{ok ? "x" : "y"}</button>;
}
