// Negative fixture: raw <button> JSX outside the shadcn primitive dirs.
// Expected: no-restricted-syntax (Block B).
export function SaveAction({ onSave }: { onSave: () => void }) {
  return (
    <button type="button" onClick={onSave}>
      Save
    </button>
  );
}
