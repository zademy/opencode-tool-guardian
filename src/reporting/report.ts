import type { Config } from "../config/schema.js";
import type { Metrics, SessionState } from "../core/models.js";
import { estimateTokens } from "../core/estimator-output.js";

/**
 * Observer health, shown next to the activity counters.
 *
 * Without it a plugin that throws on every hook produces exactly the same report as a
 * healthy session with nothing to report, and a config typo looks like a quiet day.
 */
export interface ObserverHealth {
  readonly source: string;
  readonly errors: readonly string[];
  readonly workspace: string;
}

export interface Report {
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly mode: Config["mode"];
  readonly toolCallsObserved: number;
  readonly confirmedDuplicates: number;
  readonly possibleDuplicates: number;
  readonly repeatedFailureCandidates: number;
  readonly riskWarnings: number;
  readonly largeOutputs: number;
  readonly escalatedActions: number;
  readonly confirmedActionsBlocked: number;
  /** Internal observer failures. Non-zero means the numbers above are incomplete. */
  readonly observerErrors: number;
  readonly estimatedOutputTokens: number;
  readonly largestOutputChars: number;
  readonly outputsObserved: number;
  readonly health: ObserverHealth;
  readonly detectors: ReadonlyArray<readonly [string, boolean]>;
  readonly thresholds: Readonly<Record<string, number>>;
}

export function buildReport(
  sessionId: string,
  state: SessionState,
  config: Config,
  blocked: number,
  now: number,
  health: ObserverHealth,
): Report {
  const metrics: Metrics = state.metrics;
  return {
    sessionId,
    generatedAt: new Date(now).toISOString(),
    mode: config.mode,
    toolCallsObserved: metrics.calls,
    confirmedDuplicates: metrics.duplicatesConfirmed,
    possibleDuplicates: metrics.duplicatesPossible,
    repeatedFailureCandidates: metrics.repeatedFailures,
    riskWarnings: metrics.riskWarnings,
    largeOutputs: metrics.largeOutputs,
    escalatedActions: metrics.escalated,
    confirmedActionsBlocked: blocked,
    observerErrors: metrics.errors,
    // Local heuristic only. These are NOT billed tokens and NOT tokens saved.
    estimatedOutputTokens: estimateTokens(metrics.outputs.totalChars),
    largestOutputChars: metrics.outputs.largestChars,
    outputsObserved: metrics.outputs.outputs,
    health,
    detectors: Object.entries(config.detectors) as ReadonlyArray<readonly [string, boolean]>,
    thresholds: { ...config.thresholds },
  };
}

const COUNTERS: ReadonlyArray<readonly [keyof Report, string]> = [
  ["toolCallsObserved", "Tool calls observed:"],
  ["confirmedDuplicates", "Confirmed duplicates:"],
  ["possibleDuplicates", "Possible duplicates:"],
  ["repeatedFailureCandidates", "Repeated-failure candidates:"],
  ["riskWarnings", "Risk warnings:"],
  ["largeOutputs", "Large outputs:"],
  ["escalatedActions", "Warnings escalated to the user:"],
  ["confirmedActionsBlocked", "Confirmed actions blocked:"],
  ["observerErrors", "Observer errors:"],
  ["estimatedOutputTokens", "Estimated tokens in outputs:"],
];

const WIDTH = Math.max(...COUNTERS.map(([, label]) => label.length));

export function formatReport(report: Report): string {
  const rows = COUNTERS.map(([key, label]) => label + " ".repeat(WIDTH - label.length) + "  " + String(report[key]));
  const lines = [
    "OpenCode Tool Guardian - Session Report",
    "Session: " + report.sessionId,
    "Mode: " + report.mode,
    "",
    ...rows,
    "",
    "Observer health",
    "  Config: " + report.health.source,
    "  Workspace: " + report.health.workspace,
    "  Detectors: " + report.detectors.map(([name, on]) => (on ? name : "-" + name)).join(" "),
    "  Thresholds: " + Object.entries(report.thresholds).map(([k, v]) => k + "=" + String(v)).join(" "),
  ];

  if (report.observerErrors > 0) {
    // Never let the agent believe the counters above are complete.
    lines.push("", "  WARNING: the observer raised " + report.observerErrors + " internal error(s); counters are incomplete.");
  }

  const configErrors = report.health.errors;
  if (configErrors.length > 0) {
    lines.push("", "  WARNING: " + configErrors.length + " configuration problem(s); defaults are in use:");
    for (const error of configErrors.slice(0, 5)) lines.push("    - " + error);
    if (configErrors.length > 5) lines.push("    - ...and " + (configErrors.length - 5) + " more");
  }

  lines.push("", "Token figures are a local character-count estimate, not billed usage.");
  return lines.join("\n");
}
