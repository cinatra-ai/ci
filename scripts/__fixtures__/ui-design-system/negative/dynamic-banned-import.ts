// Negative fixture: dynamic import() of banned modules in a NON-JSX source.
// no-restricted-imports only sees STATIC `import`, so Block C must flag the
// dynamic forms as errors. A banned subpath (`@mui/material/Button`) must be
// caught too. Expected: two no-restricted-syntax reports (error).
export async function lazyLoad() {
  const mui = await import("@mui/material/Button");
  const styled = await import("styled-components");
  return { mui, styled };
}
