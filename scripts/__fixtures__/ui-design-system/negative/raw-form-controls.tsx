// Negative fixture: raw <input>, <select>, <textarea>, <a> JSX outside the
// shadcn primitive dirs. Expected: one no-restricted-syntax report each.
export function ContactForm() {
  return (
    <form>
      <input name="email" />
      <select name="topic">
        <option value="sales">Sales</option>
      </select>
      <textarea name="message" />
      <a href="https://example.com">Help</a>
    </form>
  );
}
