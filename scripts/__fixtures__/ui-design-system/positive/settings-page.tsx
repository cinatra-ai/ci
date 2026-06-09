// Positive control: ordinary app code composing the shadcn wrappers.
// Expected: zero reports.
import { Button } from "./components/ui/button";

export function SettingsPage() {
  return (
    <main>
      <Button>Save changes</Button>
    </main>
  );
}
