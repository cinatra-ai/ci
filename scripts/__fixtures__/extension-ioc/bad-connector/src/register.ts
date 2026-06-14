import { something } from "@/lib/extension-host-context";
import { helper } from "@cinatra-ai/objects";
import { sdkThing } from "@cinatra-ai/sdk-extensions";
export function register(ctx) { return [something, helper, sdkThing]; }
