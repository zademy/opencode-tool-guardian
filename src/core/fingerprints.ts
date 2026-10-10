import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize, normalizePath } from "./canonicalize.js";

const NUL = "\u0000";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const PATH_KEYS = ["filePath", "path", "file", "target_file", "absolute_path", "directory"];

/** The single path a call is scoped to, or null when it is not file-scoped. */
export function scopedPath(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Digest of the raw bytes on disk. Raw bytes, never text: legacy encodings
 * (ISO-8859-1, Windows-1252) must not be transcoded to compute a digest.
 * Returns null when the file cannot be read, because an unknown state is never
 * treated as equal state.
 */
export function fileDigest(absolutePath: string): string | null {
  try {
    return sha256(readFileSync(absolutePath));
  } catch {
    return null;
  }
}

/** null when state equality cannot be proven; callers must then report "possible". */
export function stateFingerprint(path: string | null, cwd: string | undefined): string | null {
  if (path === null) return null;
  return fileDigest(normalizePath(path, cwd));
}

export interface Fingerprint {
  readonly id: string;
  /** null means "state not provable". */
  readonly state: string | null;
}

export function invocationFingerprint(
  toolId: string,
  args: unknown,
  cwd: string | undefined,
  state: string | null,
): Fingerprint {
  const id = sha256(
    toolId + NUL + canonicalize(args) + NUL + (cwd === undefined ? "" : normalizePath(cwd)),
  );
  return { id, state };
}

/**
 * Normalized failure shape: exit code plus a digest of the normalized message.
 * The full error text is never stored or reported.
 */
export function errorSignature(error: unknown): string {
  const message = extractErrorMessage(error);
  const exitCode = extractExitCode(error);
  const normalized = message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(String(exitCode ?? "?") + NUL + normalized);
}

export function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  // The 2.0.26 runtime sets error to the thrown failure, but a wrapper object is
  // also observed in the wild; unwrap defensively instead of assuming one shape.
  for (const key of ["message", "error", "data"]) {
    const nested = record[key];
    if (typeof nested === "string") return nested;
    if (nested !== null && typeof nested === "object") {
      const inner = (nested as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
  }
  try {
    return JSON.stringify(error) ?? "unserializable error";
  } catch {
    return "unserializable error";
  }
}

function extractExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const nested = record.error as Record<string, unknown> | undefined;
  for (const source of [record, nested]) {
    if (source === undefined) continue;
    const direct = source.exitCode ?? source.exit_status ?? source.code;
    if (typeof direct === "number") return direct;
    const data = source.data as Record<string, unknown> | undefined;
    if (data !== undefined && typeof data.exitCode === "number") return data.exitCode;
  }
  return undefined;
}
