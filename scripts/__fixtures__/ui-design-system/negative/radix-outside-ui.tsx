// Negative fixture: Radix import outside the shadcn primitive dirs.
// Expected: no-restricted-imports (Block A).
import { FocusScope } from "@radix-ui/react-focus-scope";

export function TrapFocus({ children }: { children: unknown }) {
  return <FocusScope trapped>{children}</FocusScope>;
}
