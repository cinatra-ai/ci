// Positive control: the Drizzle Cube dashboard-components carve-out.
// drizzle-cube/client* and react-grid-layout are re-allowed here.
// Expected: zero reports.
import { DashboardGrid } from "drizzle-cube/client";
import { useChartTheme } from "drizzle-cube/client/charts";
import GridLayout from "react-grid-layout";

export function DeskDashboard() {
  useChartTheme();
  return (
    <GridLayout cols={12} rowHeight={30} width={1200}>
      <DashboardGrid />
    </GridLayout>
  );
}
