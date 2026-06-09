// Fixture-root flat config: exactly what a consuming repo does — wire a
// TS/JSX-capable parser, then spread the preset. The test harness points
// ESLint at this file with cwd = this directory so the preset's relative
// globs resolve against the fixture tree.
import tsParser from "@typescript-eslint/parser";

import { uiDesignSystem } from "../../../config/ui-design-system.flat.mjs";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  ...uiDesignSystem(),
];
