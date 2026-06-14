// Dogfood: this repo lints its own scripts with the shareable
// ui-design-system preset, exactly as a consuming repo would.
// The preset's fixture tree deliberately violates the rules and is linted
// only by its test harness (scripts/__tests__/ui-design-system-gate.test.mjs).
import { uiDesignSystem } from "./config/ui-design-system.flat.mjs";

export default [
  {
    // Fixture trees deliberately contain rule-violating / TypeScript-syntax
    // sources linted only by their own test harnesses, not the dogfood lint.
    ignores: [
      "scripts/__fixtures__/ui-design-system/**",
      "scripts/__fixtures__/extension-ioc/**",
    ],
  },
  ...uiDesignSystem(),
];
