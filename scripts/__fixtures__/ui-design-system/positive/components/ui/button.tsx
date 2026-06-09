// Positive control: a vendored shadcn primitive. Radix imports and the raw
// <button> element are both allowed inside the ui carve-out.
// Expected: zero reports.
import { Slot } from "@radix-ui/react-slot";

export function Button({
  asChild = false,
  ...props
}: {
  asChild?: boolean;
  children?: unknown;
}) {
  const Comp = asChild ? Slot : "button";
  if (asChild) {
    return <Comp {...props} />;
  }
  return <button type="button" {...props} />;
}
