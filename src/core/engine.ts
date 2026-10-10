import type { Config } from "../config/schema.js";
import type { Decision, Evaluation, Finding, SessionState, ToolInvocation } from "./models.js";
import type { Fingerprint } from "./fingerprints.js";
import { invocationFingerprint, scopedPath, stateFingerprint } from "./fingerprints.js";
import { classifyTool, commandFromArguments } from "./tool-class.js";
import { detectDuplicate, rememberCall } from "./detector-duplicates.js";
import { detectFailureLoop } from "./detector-failures.js";
import { analyzeCommand } from "./detector-risk.js";
import { analyzeSearch } from "./detector-search.js";

export interface Workspace {
  readonly root: string;
}

const ALLOW: Decision = { action: "allow", rules: [] };

export function isExcludedTool(config: Config, toolId: string): boolean {
  return config.excludedTools.includes(toolId);
}

export function isExcludedPath(config: Config, path: string | null): boolean {
  if (path === null) return false;
  return config.excludedPaths.some((pattern) => matchesGlob(pattern, path.replace(/\\/g, "/")));
}

/**
 * Pure decision function for the pre-execution phase.
 *
 * In observe mode it always returns allow. In warn mode findings become warnings and
 * only an explicitly listed block rule escalates to block. In enforce mode a block
 * severity finding escalates only when its rule is in policy.blockRules.
 */
export function evaluate(
  invocation: ToolInvocation,
  state: SessionState,
  config: Config,
  workspace: Workspace,
): Evaluation {
  const toolClass = classifyTool(invocation.toolId);
  if (!config.enabled || isExcludedTool(config, invocation.toolId)) {
    return { decision: ALLOW, findings: [], toolClass };
  }

  const path = scopedPath(invocation.arguments);
  if (isExcludedPath(config, path)) {
    return { decision: ALLOW, findings: [], toolClass };
  }

  const fingerprint: Fingerprint = invocationFingerprint(
    invocation.toolId,
    invocation.arguments,
    invocation.cwd,
    stateFingerprintFor(toolClass, path, invocation.cwd),
  );

  const findings: Finding[] = [];

  if (config.detectors.duplicates) {
    const duplicate = detectDuplicate(state, fingerprint, toolClass, invocation.cwd);
    if (duplicate !== null) findings.push(duplicate);
  }

  if (config.detectors.excessiveSearch) {
    findings.push(...analyzeSearch(invocation.arguments, invocation.cwd));
  }

  // Only a declared shell tool is analysed as a command. An unknown or MCP tool keeps
  // its payload opaque: guessing that its "command" field is a shell line is exactly
  // the false assumption the spec forbids.
  if (config.detectors.commandRisk && toolClass === "exec") {
    const command = commandFromArguments(invocation.arguments);
    if (command !== null) {
      findings.push(...analyzeCommand(command, { workspace: workspace.root, cwd: invocation.cwd }));
    }
  }

  rememberCall(state, fingerprint, config.thresholds.maxTrackedOperations);

  const decision = decide(findings, config);
  return { decision, findings, toolClass };
}

/**
 * State proof only exists for single-file reads. Commands, globs and writes depend on
 * time, network, other processes and caches, so their state is never claimed equal.
 */
function stateFingerprintFor(toolClass: string, path: string | null, cwd: string | undefined): string | null {
  return toolClass === "read" ? stateFingerprint(path, cwd) : null;
}

/** The failure loop can only be known after execution; it is surfaced separately. */
export function failureFinding(state: SessionState, fingerprintId: string, config: Config): Finding | null {
  if (!config.detectors.repeatedFailures) return null;
  const record = state.failures.get(fingerprintId);
  if (record === undefined) return null;
  return detectFailureLoop(record, config.thresholds.repeatedFailureCount);
}

export function decide(findings: readonly Finding[], config: Config): Decision {
  if (config.mode === "observe") return ALLOW;
  if (findings.length === 0) return ALLOW;

  const blockers = findings.filter(
    (finding) => finding.severity === "block" && config.policy.blockRules.includes(finding.rule),
  );
  if (config.mode === "enforce" && blockers.length > 0) {
    return {
      action: "block",
      rules: blockers.map((finding) => finding.rule),
      reason: blockers.map((finding) => finding.message).join(" "),
    };
  }

  const warned = findings.filter((finding) => finding.severity !== "info");
  if (warned.length === 0) return ALLOW;
  return {
    action: "warn",
    rules: warned.map((finding) => finding.rule),
    message: warned.map((finding) => finding.message).join(" "),
  };
}

function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("")
    .map((char) => (/[.+^${}()|[\]\\]/.test(char) ? "\\" + char : char))
    .join("")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, ".*");
  return new RegExp("^" + escaped + "$").test(value);
}
