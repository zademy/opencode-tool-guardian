/**
 * Minimal shell argument analysis: split a command line into segments and argv
 * tokens while honouring quotes and escapes.
 *
 * Deliberately NOT a shell parser. It exists so that a dangerous substring inside a
 * quoted string or a comment ("echo rm -rf /") is not mistaken for a command, and so
 * that only a dangerous binary in argv[0] can ever escalate. Anything it cannot
 * resolve confidently must be treated as unknown, never as safe.
 */

const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "\n"];

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "command", "builtin", "exec"]);

/** Splits on shell operators that appear outside quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote !== null) {
      current += char;
      if (char === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const operator = OPERATORS.find((op) => command.startsWith(op, i));
    if (operator !== undefined) {
      if (current.trim().length > 0) segments.push(current.trim());
      current = "";
      i += operator.length - 1;
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) segments.push(current.trim());
  return segments;
}

/** Splits a segment into argv tokens, honouring single/double quotes and backslash escapes. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    // Single quotes were handled above, so a backslash here is always an escape.
    if (char === "\\" && i + 1 < segment.length) {
      current += segment[i + 1]!;
      i += 1;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function basename(binary: string): string {
  const parts = binary.split(/[/\\]/);
  return parts[parts.length - 1]!.toLowerCase();
}

export interface Resolved {
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * Strips leading env assignments and privilege wrappers so the real binary is argv[0].
 * Returns null when a wrapper changes meaning enough that we cannot reason safely.
 */
export function resolveBinary(argv: readonly string[]): Resolved | null {
  let index = 0;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]!)) index += 1;
  const rest = argv.slice(index);
  if (rest.length === 0) return null;
  // xargs rebuilds the command line itself, so argv[0] tells us nothing about intent.
  if (rest[0] === "xargs") return null;
  let bin = basename(rest[0]!);
  let args = rest.slice(1);
  while (WRAPPERS.has(bin)) {
    let next = 0;
    while (next < args.length && args[next]!.startsWith("-")) next += 1;
    if (next >= args.length) return null;
    bin = basename(args[next]!);
    args = args.slice(next + 1);
  }
  return { bin, args };
}

/** True when the segment's argv[0] is the given binary, ignoring the binary's own path. */
export function isBinary(segment: string, binary: string): Resolved | null {
  const resolved = resolveBinary(tokenize(segment));
  return resolved !== null && resolved.bin === binary ? resolved : null;
}

export function hasFlag(args: readonly string[], short: string, long: string): boolean {
  return args.some((arg) => arg === short || arg === long || arg.startsWith(long + "="));
}
