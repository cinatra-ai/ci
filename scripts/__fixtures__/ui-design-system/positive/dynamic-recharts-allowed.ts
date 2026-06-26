// Positive control: recharts is the allowed shadcn chart primitive and is not
// banned anywhere, statically or dynamically. A dynamic import of a relative
// module is fine too. Expected: zero reports.
export async function loadChart() {
  const recharts = await import("recharts");
  const local = await import("./settings-page");
  const helper = require("./usage-chart");
  return { recharts, local, helper };
}
