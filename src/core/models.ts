/**
 * Domain types from the spec (section 7). These are the plugin's own types,
 * NOT exports of the OpenCode SDK.
 */

export type ToolClass = "read" | "exec" | "modify" | "unknown";
export type Mode = "observe" | "warn" | "enforce";

export interface ToolInvocation {
  readonly toolId: string;
  readonly arguments: unknown;
  readonly cwd?: string;
  readonly sessionId?: string;
  /** Official per-call correlation id (event.id). */
  readonly invocationId?: string;
}

export type Decision =
  | { readonly action: "allow"; readonly rules: readonly string[] }
  | { readonly action: "warn"; readonly rules: readonly string[]; readonly message: string }
  | { readonly action: "block"; readonly rules: readonly string[]; readonly reason: string };

/** A detector hit, independent of the mode it is rendered in. */
export interface Finding {
  readonly rule: string;
  readonly severity: "info" | "warn" | "block";
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export interface Evaluation {
  /** In observe mode this is always "allow". */
  readonly decision: Decision;
  readonly findings: readonly Finding[];
  readonly toolClass: ToolClass;
}

export interface FailureRecord {
  signature: string;
  /** null means state equality was not provable for that call. */
  state: string | null;
  count: number;
}

export interface OutputStats {
  outputs: number;
  totalChars: number;
  totalBytes: number;
  totalLines: number;
  largestChars: number;
  largeOutputs: number;
}

export interface Metrics {
  calls: number;
  /** Same call, provably identical state: the same file re-read without changes. */
  duplicatesConfirmed: number;
  /** Same call, state not provable: worth a look, not an assertion. */
  duplicatesPossible: number;
  repeatedFailures: number;
  riskWarnings: number;
  largeOutputs: number;
  escalated: number;
  /** Internal observer failures. Must be visible: a broken observer looks like a quiet one. */
  errors: number;
  outputs: OutputStats;
}

/** Bounded per-session state. Never shared across sessions, users or projects. */
export interface SessionState {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly seen: Map<string, { index: number; state: string | null }>;
  readonly failures: Map<string, FailureRecord>;
  readonly escalated: Set<string>;
  readonly metrics: Metrics;
}

export function emptyMetrics(): Metrics {
  return {
    calls: 0,
    duplicatesConfirmed: 0,
    duplicatesPossible: 0,
    repeatedFailures: 0,
    riskWarnings: 0,
    largeOutputs: 0,
    escalated: 0,
    errors: 0,
    outputs: { outputs: 0, totalChars: 0, totalBytes: 0, totalLines: 0, largestChars: 0, largeOutputs: 0 },
  };
}

export function newSessionState(sessionId: string, now: number): SessionState {
  return {
    sessionId,
    createdAt: now,
    seen: new Map(),
    failures: new Map(),
    escalated: new Set(),
    metrics: emptyMetrics(),
  };
}
