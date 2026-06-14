export function register(ctx) {
  ctx.capabilities.registerProvider("email-send", { impl: {} });
}
