// Positive control: inside the Drizzle Cube carve-out, dynamic loads of the
// Drizzle Cube surface are re-allowed exactly as the static imports are.
// Expected: zero reports.
export async function loadDashboard() {
  const client = await import("drizzle-cube/client");
  const charts = await import("drizzle-cube/client/charts");
  const grid = require("react-grid-layout");
  return { client, charts, grid };
}
