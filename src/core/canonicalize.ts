import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Deterministic JSON: object keys sorted, array order preserved, undefined members
 * dropped, cycles replaced. Never mutates the input.
 */
export function canonicalize(value: unknown): string {
  return render(value, new WeakSet<object>());
}

function render(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "bigint") return JSON.stringify(String(value));
  if (type === "undefined" || type === "function" || type === "symbol") return "null";
  const obj = value as object;
  if (seen.has(obj)) return JSON.stringify("[circular]");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return "[" + obj.map((item) => render(item, seen)).join(",") + "]";
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + render(v, seen)).join(",") + "}";
  } finally {
    seen.delete(obj);
  }
}

// A drive letter or a UNC prefix is unambiguous evidence of a Windows path even when
// the process runs on POSIX. Without this, "C:\Users\me\a.txt" looks relative to a
// POSIX host and gets resolved against the cwd, which silently breaks every
// containment and identity check for a Windows session.
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\/;

// Precedence: the host platform, then the path itself (an absolute Windows path wins
// over any cwd), then the cwd, because a relative path carries no evidence of its own.
function flavorFor(input: string, cwd?: string): typeof posix {
  if (process.platform === "win32") return win32;
  if (WINDOWS_DRIVE.test(input) || WINDOWS_UNC.test(input)) return win32;
  return cwd !== undefined && cwd.length > 0 ? flavorFor(cwd) : posix;
}

/**
 * Path normalization for identity comparison only, never for IO. Windows-looking
 * paths always use Windows rules so the result does not depend on which machine
 * computed it; everything else uses POSIX rules, where a backslash stays a legal
 * filename character. Output always uses "/" separators.
 */
export function normalizePath(input: string, cwd?: string): string {
  if (input.length === 0) return input;
  const home = homedir();
  const expanded =
    input.startsWith("~") && (input.length === 1 || input[1] === "/" || input[1] === "\\")
      ? home + input.slice(1)
      : input;
  const flavor = flavorFor(expanded, cwd);
  const absolute = flavor.isAbsolute(expanded) || !cwd ? expanded : flavor.resolve(cwd, expanded);
  const normalized = flavor.normalize(absolute).split(flavor.sep).join("/");
  return /^[A-Za-z]:/.test(normalized) ? normalized[0]!.toLowerCase() + normalized.slice(1) : normalized;
}

/**
 * True when candidate is the same as, or nested under, root.
 *
 * Both sides are normalized: callers pass whatever the host context gave
 * (ctx.location.project.canonical keeps its native separators) while candidates are
 * already normalized. Comparing those two forms directly fails on Windows and reports
 * every project file as outside the workspace.
 */
export function isWithin(root: string, candidate: string): boolean {
  if (root.length === 0) return false;
  const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
  const normalizedCandidate = normalizePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + "/");
}
