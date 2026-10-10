import { createPlugin } from "./opencode/guardian.js";
import type { PluginDefinition } from "./opencode/v2-api.js";

/**
 * OpenCode V2 entry point.
 *
 * The default export is a plain object shaped like Plugin.define(...) rather than the
 * Plugin.define() call itself: `@opencode-ai/plugin` ships types that predate the 2.0.26
 * runtime and have no bare "./v2" export, so importing it here would type-check against a
 * contract the installed runtime does not implement. The shape is identical, so OpenCode
 * loads it the same way it loads any V2 plugin.
 */
const plugin: PluginDefinition = createPlugin();

export default plugin;
export type { PluginDefinition, PluginContext } from "./opencode/v2-api.js";
