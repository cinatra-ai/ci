// Negative fixture: require() of banned modules in a NON-JSX source file.
// no-restricted-imports never sees require(), so Block C must flag these as
// errors. Expected: two no-restricted-syntax reports (error), zero
// no-restricted-imports reports.
const mui = require("@mui/material");
const radix = require("@radix-ui/react-dialog");

export function legacyLoad() {
  return { mui, radix };
}
