// Negative fixture: the Drizzle Cube carve-out re-allows drizzle-cube/client*
// and react-grid-layout ONLY — Radix stays banned here.
// Expected: no-restricted-imports (Block A restated by the carve-out).
import { Slot } from "@radix-ui/react-slot";

export function CarveOutSlot({ children }: { children: unknown }) {
  return <Slot>{children}</Slot>;
}
