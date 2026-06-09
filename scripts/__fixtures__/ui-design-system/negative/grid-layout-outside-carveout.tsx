// Negative fixture: react-grid-layout outside the Drizzle Cube
// dashboard-components carve-out. Expected: no-restricted-imports (Block A).
import GridLayout from "react-grid-layout";

export function FreeformGrid() {
  return <GridLayout cols={12} rowHeight={30} width={1200} />;
}
