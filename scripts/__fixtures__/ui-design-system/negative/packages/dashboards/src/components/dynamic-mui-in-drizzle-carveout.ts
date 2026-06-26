// Negative fixture: inside the Drizzle Cube carve-out, the Drizzle Cube
// surface is re-allowed for dynamic loads too — but the UI-library ban still
// holds. A dynamic import() of @mui here must still be an error (Block C
// carve-out parity with Block A). Expected: one no-restricted-syntax report.
export async function carveoutLoad() {
  const grid = await import("react-grid-layout"); // re-allowed here
  const mui = await import("@mui/material"); // still banned
  return { grid, mui };
}
