import type {
  PermissionEvaluate,
  PluginContext,
  Registration,
  ToolDefinition,
  ToolEditor,
  ToolExecuteAfter,
  ToolExecuteBefore,
} from "../../src/opencode/v2-api.js";

type BeforeHook = (event: ToolExecuteBefore) => void;
type AfterHook = (event: ToolExecuteAfter) => void;
type PermissionHook = (event: PermissionEvaluate) => void;

/**
 * Minimal stand-in for the OpenCode 2.0.26 host context, shaped from the verified
 * dispatch sites: tool.hook / permission.hook / tool.transform, plus location.
 */
export interface FakeContext {
  readonly ctx: PluginContext;
  readonly tools: ToolDefinition[];
  /** Hook names the plugin successfully registered, in order. */
  readonly registered: string[];
  /** Registration names whose dispose() ran, in order. */
  readonly disposed: string[];
  fireBefore(event: ToolExecuteBefore): void;
  fireAfter(event: ToolExecuteAfter): void;
  firePermission(event: PermissionEvaluate): void;
}

export function createFakeContext(options?: {
  directory?: string;
  canonical?: string;
  pluginOptions?: unknown;
  failBeforeHook?: boolean;
}): FakeContext {
  const before: BeforeHook[] = [];
  const after: AfterHook[] = [];
  const permissions: PermissionHook[] = [];
  const tools: ToolDefinition[] = [];
  const registered: string[] = [];
  const disposed: string[] = [];
  const directory = options?.directory ?? process.cwd();

  const registration = (name: string): Registration => ({
    dispose() {
      disposed.push(name);
    },
  });
  const granted = (name: string): Registration => {
    registered.push(name);
    return registration(name);
  };

  const editor: ToolEditor = {
    add(definition) {
      tools.push(definition);
    },
    remove() {
      /* not used by the plugin */
    },
  };

  const ctx: PluginContext = {
    location: { directory, project: { id: "test", directory, canonical: options?.canonical ?? directory } },
    app: { version: "2.0.26" },
    // The 2.0.26 runtime hands plugins loaded from the plugins directory an empty
    // options object, not undefined. Modelling that is what caught the shadowing bug.
    options: options?.pluginOptions ?? ({} as unknown),
    tool: {
      hook(name, callback) {
        if (name === "execute.before") {
          if (options?.failBeforeHook === true) return Promise.reject(new Error("registration refused"));
          before.push(callback as BeforeHook);
        } else {
          after.push(callback as AfterHook);
        }
        return Promise.resolve(granted("tool." + name));
      },
      transform(callback) {
        callback(editor);
        return Promise.resolve(granted("tool.transform"));
      },
    },
    permission: {
      hook(_name, callback) {
        permissions.push(callback as PermissionHook);
        return Promise.resolve(granted("permission.evaluate"));
      },
    },
  };

  return {
    ctx,
    tools,
    registered,
    disposed,
    fireBefore: (event) => before.forEach((hook) => hook(event)),
    fireAfter: (event) => after.forEach((hook) => hook(event)),
    firePermission: (event) => permissions.forEach((hook) => hook(event)),
  };
}

export function beforeEvent(
  overrides: Partial<ToolExecuteBefore> & { tool: string; sessionID: string; id: string },
): ToolExecuteBefore {
  return { messageID: "msg_1", input: {}, ...overrides };
}

export function afterEvent(
  overrides: Partial<ToolExecuteAfter> & { tool: string; sessionID: string; id: string },
): ToolExecuteAfter {
  return { messageID: "msg_1", input: {}, status: "completed", result: { content: [] }, ...overrides };
}

export function permissionEvent(
  overrides: Partial<PermissionEvaluate> & { resources: string[] },
): PermissionEvaluate {
  return { sessionID: "ses_1", action: "tool.use", effect: "allow", ...overrides };
}
