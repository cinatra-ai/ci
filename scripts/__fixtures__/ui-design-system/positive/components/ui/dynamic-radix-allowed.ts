// Positive control: inside the shadcn-primitives carve-out, dynamic loads of
// Radix are re-allowed exactly as the static imports are (shadcn primitives
// are built on Radix). recharts is allowed everywhere. Expected: zero reports.
export async function loadPrimitive() {
  const dialog = await import("@radix-ui/react-dialog");
  const popover = require("radix-ui");
  const chart = await import("recharts");
  return { dialog, popover, chart };
}
