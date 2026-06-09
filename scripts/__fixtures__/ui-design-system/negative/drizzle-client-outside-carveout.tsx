// Negative fixture: drizzle-cube/client outside the Drizzle Cube
// dashboard-components carve-out. Expected: no-restricted-imports (Block A).
import { DashboardGrid } from "drizzle-cube/client";

export function StrayDashboard() {
  return <DashboardGrid />;
}
