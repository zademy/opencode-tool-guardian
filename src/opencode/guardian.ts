import { loadConfig, configFromOptions } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { decide, evaluate, isExcludedTool } from "../core/engine.js";
import { scopedPath } from "../core/fingerprints.js";
import { commandFromArguments } from "../core/tool-class.js";
import { recordOutput } from "../core/estimator-output.js";
import { recordFailure, claimEscalation, detectFailureLoop } from "../core/detector-failures.js";
import { analyzeCommand } from "../core/detector-risk.js";
import { extractErrorMessage, invocationFingerprint, stateFingerprint } from "../core/fingerprints.js";
import { buildReport, formatReport } from "../reporting/report.js";
import { newSessionState } from "../core/models.js";
import { SessionStore } from "../state/session-store.js";
import type {
  PermissionEvaluate,
  PluginContext,
  PluginDefinition,
  Registration,
  ToolExecuteAfter,
  ToolExecuteBefore,
  ToolEditor,
} from "./v2-api.js";
import { classifyTool } from "../core/tool-class.js";

// The plugin id is the package name, so the plugins list shows it unprefixed.
const PLUGIN_ID = "opencode-tool-guardian";
/**
 * The observer must not measure itself: counting our own report calls would make
 * "check the numbers" the most common duplicate in the session, and every check
 * would move the numbers it is trying to read.
 */
const REPORT_TOOL = "guardian_report";
const MARKER = "[tool-guardian]";

interface PendingCall {
  fingerprintId: string;
  toolId: string;
}

/**
 * All state lives here so the whole observer can be torn down on unload.
 * Nothing is written to disk: metrics are per-session and in memory only.
 */
export class Guardian {
  private readonly store: SessionStore;
  private readonly workspace: string;
  private config: Config;
  private readonly configSource: string;
  private readonly configErrors: readonly string[];
  private readonly pending = new Map<string, PendingCall>();
  private blockedActions = 0;
  private lastSessionId = "";

  constructor(context: PluginContext) {
    const directory = context.location?.directory ?? process.cwd();
    const canonical = context.location?.project?.canonical ?? directory;
    this.workspace = canonical.length > 0 ? canonical : directory;
    const fromOptions = configFromOptions(context.options);
    const loaded = loadConfig(directory);
    // Options win over the file, but only when the host actually supplied some. The
    // 2.0.26 runtime hands over an empty object for plugins loaded from the plugins
    // directory, and treating that as "configured" would silently shadow the file.
    const supplied = hasKeys(context.options);
    const optionsWin = supplied && fromOptions.errors.length === 0;
    this.config = optionsWin ? fromOptions.config : loaded.config;
    // A bad config must not fail silently: the report says which file won and why.
    this.configSource = optionsWin ? "opencode.json (options)" : loaded.source;
    this.configErrors = [
      ...(supplied ? fromOptions.errors : []),
      ...(optionsWin ? [] : loaded.errors),
    ];
    this.store = new SessionStore({
      maxSessions: this.config.thresholds.maxSessions,
      ttlMs: this.config.thresholds.sessionTtlMs,
    });
  }

  get id(): string {
    return PLUGIN_ID;
  }

  /** The observer must never break a legitimate tool call, so every entry point swallows. */
  private guard(label: string, sessionId: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      const state = this.store.peek(sessionId);
      if (state !== undefined) state.metrics.errors += 1;
      console.warn(MARKER + " internal error in " + label + ": " + (error as Error).message);
    }
  }

  private cwdOf(context: PluginContext): string {
    return context.location?.directory ?? this.workspace;
  }

  onExecuteBefore(context: PluginContext, event: ToolExecuteBefore): void {
    if (event.tool === REPORT_TOOL) return;
    this.guard("execute.before", event.sessionID, () => {
      const config = this.config;
      if (!config.enabled || isExcludedTool(config, event.tool)) return;
      const state = this.store.get(event.sessionID);
      this.lastSessionId = event.sessionID;
      const cwd = this.cwdOf(context);
      const toolClass = classifyTool(event.tool);
      const path = scopedPath(event.input);
      const fingerprint = invocationFingerprint(
        event.tool,
        event.input,
        cwd,
        toolClass === "read" ? stateFingerprint(path, cwd) : null,
      );
      this.pending.set(key(event.sessionID, event.id), {
        fingerprintId: fingerprint.id,
        toolId: event.tool,
      });
      const result = evaluate(
        { toolId: event.tool, arguments: event.input, cwd, sessionId: event.sessionID, invocationId: event.id },
        state,
        config,
        { root: this.workspace },
      );
      if (result.findings.some((f) => f.rule === "duplicate.confirmed")) state.metrics.duplicatesConfirmed += 1;
      if (result.findings.some((f) => f.rule === "duplicate.possible")) state.metrics.duplicatesPossible += 1;
      if (result.findings.some((f) => f.rule.startsWith("risk."))) state.metrics.riskWarnings += 1;
      if (result.decision.action === "block") {
        this.blockedActions += 1;
        console.warn(MARKER + " blocked " + event.tool + ": " + result.decision.reason);
      } else if (result.decision.action === "warn") {
        console.warn(MARKER + " " + result.decision.message);
      }
      // event.input is never modified. In observe mode nothing about the call changes.
    });
  }

  onExecuteAfter(context: PluginContext, event: ToolExecuteAfter): void {
    if (event.tool === REPORT_TOOL) return;
    this.guard("execute.after", event.sessionID, () => {
      const state = this.store.get(event.sessionID);
      this.lastSessionId = event.sessionID;
      const pending = this.pending.get(key(event.sessionID, event.id));
      this.pending.delete(key(event.sessionID, event.id));

      if (this.config.detectors.outputCost && event.status === "completed") {
        const large = recordOutput(state.metrics.outputs, event.result, this.config.thresholds.largeOutputLines);
        if (large) state.metrics.largeOutputs += 1;
      }

      if (event.status !== "error") return;

      const fingerprintId =
        pending?.fingerprintId ??
        invocationFingerprint(event.tool, event.input, this.cwdOf(context), null).id;
      const record = recordFailure(state, { id: fingerprintId, state: null }, event.error, this.config.thresholds.maxTrackedOperations);
      const finding = detectFailureLoop(record, this.config.thresholds.repeatedFailureCount);
      if (finding === null) return;
      state.metrics.repeatedFailures += 1;

      // Official, non-blocking channel to reach the agent: the error it is about to
      // read. The original message is preserved; only a short note is appended.
      if (this.config.mode !== "observe" && claimEscalation(state, { id: fingerprintId, state: null })) {
        state.metrics.escalated += 1;
        event.error = annotate(event.error, finding.message);
      }
    });
  }

  /**
   * The only supported blocking channel in V2. Guardian can escalate a permission to
   * "ask" or "deny"; it never sets "allow", so it can never widen the user's own policy.
   */
  onPermissionEvaluate(context: PluginContext, event: PermissionEvaluate): void {
    this.guard("permission.evaluate", event.sessionID, () => {
      const config = this.config;
      if (!config.enabled || config.mode === "observe") return;
      // An explicit user/config deny is already final; never soften it.
      if (event.effect === "deny") return;

      const command = commandFromPermission(event);
      if (command === null) return;

      const findings = analyzeCommand(command, { workspace: this.workspace, cwd: this.cwdOf(context) });
      if (findings.length === 0) return;

      const decision = decide(findings, config);
      if (decision.action === "block") {
        event.effect = "deny";
        event.message = MARKER + " " + decision.reason;
        this.blockedActions += 1;
        const state = this.store.peek(event.sessionID);
        if (state !== undefined) state.metrics.riskWarnings += 1;
      } else if (decision.action === "warn" && event.effect === "allow") {
        event.effect = "ask";
        event.message = MARKER + " " + decision.message;
        const state = this.store.peek(event.sessionID);
        if (state !== undefined) state.metrics.escalated += 1;
      }
    });
  }

  report(sessionId: string | undefined): string {
    const id = sessionId !== undefined && sessionId.length > 0 ? sessionId : this.lastSessionId;
    if (id.length === 0) {
      return "OpenCode Tool Guardian: no session observed yet.";
    }
    // No metrics yet is still a valid answer, as long as it carries the health block:
    // a session with no activity must still prove the observer is loaded and which
    // config it read. Falling back to a bare sentence is what made an idle or broken
    // observer indistinguishable from a quiet one.
    const state = this.store.peek(id) ?? newSessionState(id, Date.now());
    return formatReport(
      buildReport(id, state, this.config, this.blockedActions, Date.now(), {
        source: this.configSource,
        errors: this.configErrors,
        workspace: this.workspace,
      }),
    );
  }

  registerReportTool(editor: ToolEditor, context: PluginContext): void {
    editor.add({
      name: REPORT_TOOL,
      description:
        "Show the Tool Guardian session report: tool calls observed, confirmed and possible duplicates, repeated-failure candidates, risk warnings, large outputs, estimated output size, plus the observer's own health (config file, detector toggles and internal errors). Takes no arguments.",
      input: reportInputSchema(),
      execute: async (_args: unknown, toolContext: Record<string, unknown>) => ({
        content: this.report(readSessionId(toolContext)),
      }),
    });
    void context;
  }

  dispose(): void {
    this.pending.clear();
    this.store.clear();
  }

  /** Test seam: the store is internal, so expose it narrowly. */
  get sessionStore(): SessionStore {
    return this.store;
  }
}

function hasKeys(options: unknown): boolean {
  return typeof options === "object" && options !== null && Object.keys(options).length > 0;
}

function key(sessionId: string, id: string): string {
  return sessionId + "/" + id;
}

function readSessionId(toolContext: Record<string, unknown>): string | undefined {
  const value = toolContext["sessionID"] ?? toolContext["sessionId"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Pulls the command out of a permission evaluation. Resources look like
 * "tool.use:bash:<command>"; everything else is left to the tool hooks.
 */
function commandFromPermission(event: PermissionEvaluate): string | null {
  const prefix = event.action + ":";
  for (const resource of event.resources) {
    if (typeof resource !== "string" || !resource.startsWith(prefix)) continue;
    const body = resource.slice(prefix.length);
    const separator = body.indexOf(":");
    if (separator < 0) continue;
    const tool = body.slice(0, separator);
    const payload = body.slice(separator + 1);
    if (payload.length > 0 && classifyTool(tool) === "exec") return payload;
  }
  const metadata = event.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const fromMetadata = commandFromArguments(metadata);
    if (fromMetadata !== null) return fromMetadata;
  }
  return null;
}

function annotate(error: unknown, note: string): unknown {
  const message = extractErrorMessage(error);
  if (message.includes(MARKER)) return error;
  const combined = message + "\n\n" + MARKER + " " + note;
  if (error instanceof Error) {
    const annotated = new Error(combined);
    annotated.name = error.name;
    if (error.stack !== undefined) annotated.stack = error.stack;
    return annotated;
  }
  return new Error(combined);
}

// Kept as a function so the dependency is visible and swappable in tests.
function reportInputSchema(): unknown {
  return { type: "object", properties: {}, additionalProperties: false };
}

export function createPlugin(): PluginDefinition {
  return {
    id: PLUGIN_ID,
    async setup(context: PluginContext) {
      const guardian = new Guardian(context);
      const registrations: Registration[] = [];
      const register = async (promise: Promise<Registration>): Promise<void> => {
        try {
          registrations.push(await promise);
        } catch (error) {
          console.warn(MARKER + " hook registration failed: " + (error as Error).message);
        }
      };

      await register(context.tool.hook("execute.before", (event) => guardian.onExecuteBefore(context, event)));
      await register(context.tool.hook("execute.after", (event) => guardian.onExecuteAfter(context, event)));
      await register(context.permission.hook("evaluate", (event) => guardian.onPermissionEvaluate(context, event)));
      await register(context.tool.transform((editor) => guardian.registerReportTool(editor, context)));

      return () => {
        for (const registration of registrations) {
          try {
            registration.dispose();
          } catch (error) {
            console.warn(MARKER + " dispose failed: " + (error as Error).message);
          }
        }
        guardian.dispose();
      };
    },
  };
}
