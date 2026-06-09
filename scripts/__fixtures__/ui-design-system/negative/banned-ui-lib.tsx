// Negative fixture: competing (non-shadcn) UI libraries.
// Expected: one no-restricted-imports report per import (Block A).
import { Button } from "@mui/material";
import styled from "styled-components";

const Wrapper = styled.div`
  padding: 1rem;
`;

export function LegacyAction() {
  return (
    <Wrapper>
      <Button>Save</Button>
    </Wrapper>
  );
}
