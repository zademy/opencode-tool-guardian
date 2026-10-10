import type { Finding, SessionState, ToolClass } from "./models.js";
import type { Fingerprint } from "./fingerprints.js";

/**
 * A repeat is only "confirmed" when the file bytes behind the call are provably
 * identical. Everything else stays "possible": a command can depend on time, network,
 * processes or caches that no local digest can prove.
 */
export function detectDuplicate(
  state: SessionState,
  fingerprint: Fingerprint,
  toolClass: ToolClass,
  cwd: string | undefined,
): Finding | null {
  const previous = state.seen.get(fingerprint.id);
  if (previous === undefined) return null;
  const stateProven = toolClass === "read" && fingerprint.state !== null && previous.state === fingerprint.state;
  // Both digests known and different means the world changed: re-reading is legitimate.
  if (previous.state !== null && fingerprint.state !== null && previous.state !== fingerprint.state) return null;
  return {
    rule: stateProven ? "duplicate.confirmed" : "duplicate.possible",
    severity: "warn",
    message: stateProven
      ? "Same tool, same arguments and provably identical file content as an earlier call this session."
      : "Same tool and same arguments as an earlier call this session; relevant state could not be proven equal.",
    detail: {
      toolClass,
      cwd: cwd ?? "(none)",
      firstSeenCall: previous.index,
      stateProof: stateProven ? "content-digest" : "not-provable",
    },
  };
}

export function rememberCall(state: SessionState, fingerprint: Fingerprint, maxTracked: number): void {
  if (!state.seen.has(fingerprint.id)) state.seen.set(fingerprint.id, { index: state.metrics.calls, state: fingerprint.state });
  state.metrics.calls += 1;
  while (state.seen.size > maxTracked) {
    const oldest = state.seen.keys().next();
    if (oldest.done) break;
    state.seen.delete(oldest.value);
  }
}
