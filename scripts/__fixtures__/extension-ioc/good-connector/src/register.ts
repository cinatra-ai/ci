import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
export function register(ctx: ExtensionHostContext) {
  ctx.capabilities.registerProvider("email-send", { impl: {} });
}
