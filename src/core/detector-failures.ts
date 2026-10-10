import type { FailureRecord, Finding, SessionState } from "./models.js";
import type { Fingerprint } from "./fingerprints.js";
import { errorSignature } from "./fingerprints.js";

/**
 * Consecutive identical failures for the same call. Any change in arguments, cwd,
 * provable state or error shape restarts the count.
 */
export function recordFailure(
  state: SessionState,
  fingerprint: Fingerprint,
  error: unknown,
  maxTracked: number,
): FailureRecord {
  const signature = errorSignature(error);
  const previous = state.failures.get(fingerprint.id);
  const sameRun =
    previous !== undefined && previous.signature === signature && previous.state === fingerprint.state;
  const record: FailureRecord = sameRun
    ? { signature, state: fingerprint.state, count: previous.count + 1 }
    : { signature, state: fingerprint.state, count: 1 };
  state.failures.set(fingerprint.id, record);
  while (state.failures.size > maxTracked) {
    const oldest = state.failures.keys().next();
    if (oldest.done) break;
    state.failures.delete(oldest.value);
  }
  return record;
}

export function detectFailureLoop(record: FailureRecord, threshold: number): Finding | null {
  if (record.count < threshold) return null;
  return {
    rule: "failures.repeated",
    severity: "warn",
    message:
      "This exact call failed " +
      record.count +
      " times in a row with the same error signature. Re-read the error or change something before retrying.",
    detail: { count: record.count, threshold, stateProof: record.state === null ? "not-provable" : "content-digest" },
  };
}

/** True once per fingerprint per session, so a retry loop raises at most one prompt. */
export function claimEscalation(state: SessionState, fingerprint: Fingerprint): boolean {
  if (state.escalated.has(fingerprint.id)) return false;
  state.escalated.add(fingerprint.id);
  return true;
}
