/**
 * Local declarations for the OpenCode V2 plugin surface this plugin uses.
 *
 * Why not `@opencode-ai/plugin`: the published 1.18.x types describe a much smaller
 * context (agent/command/catalog/integration/reference/skill transforms only) and have
 * no bare `./v2` entrypoint, so they do not describe the 2.0.26 runtime. These shapes
 * come from https://opencode.ai/v2/docs/build/plugins plus the event payloads emitted by
 * the installed 2.0.26 binary. Only the members actually used are declared.
 */

export interface Registration {
  dispose(): void | Promise<void>;
}

export interface ToolExecuteBefore {
  tool: string;
  sessionID: string;
  agent?: string;
  messageID: string;
  id: string;
  input: unknown;
}

export interface ToolExecuteAfter {
  tool: string;
  sessionID: string;
  agent?: string;
  messageID: string;
  id: string;
  input: unknown;
  status: "completed" | "error";
  result?: { output?: unknown; content?: unknown; metadata?: unknown };
  error?: unknown;
}

export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionEvaluate {
  sessionID: string;
  agent?: string;
  action: string;
  /** Entries of the form "<action>:<resource>", e.g. "tool.use:bash:rm -rf /". */
  resources: readonly string[];
  metadata?: unknown;
  source?: { type: string; messageID?: string; id?: string };
  effect: PermissionEffect;
  message?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  execute: (args: unknown, toolContext: Record<string, unknown>) => Promise<{ content: string }>;
}

export interface ToolEditor {
  add(definition: ToolDefinition): void;
  remove(id: string): void;
}

export interface ToolDomain {
  hook(name: "execute.before", callback: (event: ToolExecuteBefore) => Promise<void> | void): Promise<Registration>;
  hook(
    name: "execute.after",
    callback: (event: ToolExecuteAfter) => Promise<void> | void,
  ): Promise<Registration>;
  transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
}

export interface PermissionDomain {
  hook(
    name: "evaluate",
    callback: (event: PermissionEvaluate) => Promise<void> | void,
  ): Promise<Registration>;
}

export interface PluginLocation {
  directory: string;
  workspaceID?: string;
  project?: { id: string; directory: string; canonical: string };
}

export interface PluginContext {
  readonly options?: unknown;
  readonly location?: PluginLocation;
  readonly app?: { version?: string };
  readonly tool: ToolDomain;
  readonly permission: PermissionDomain;
}

export interface PluginDefinition {
  id: string;
  setup(context: PluginContext): Promise<(() => void) | void> | (() => void) | void;
}
