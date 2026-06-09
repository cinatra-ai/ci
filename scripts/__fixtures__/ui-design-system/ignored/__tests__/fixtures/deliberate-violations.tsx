// Positive control for the fixture exemption: this file violates Block A
// and Block B on purpose, but lives under a __tests__/fixtures/ directory,
// which every preset block ignores. Expected: zero preset reports.
import { Button } from "@mui/material";

export function FixtureOnly() {
  return (
    <button type="button">
      <Button>nested</Button>
    </button>
  );
}
