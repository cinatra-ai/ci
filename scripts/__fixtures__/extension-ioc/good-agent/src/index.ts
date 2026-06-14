import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
// A comment mentioning import "@/lib/should-not-count" must NOT be flagged.
const note = "require('@cinatra-ai/objects')"; // a string literal, not an import
export function register(ctx: ExtensionHostContext) { return [ctx, note]; }
