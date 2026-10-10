import type { Finding } from "./models.js";
import { normalizePath } from "./canonicalize.js";
import { resolveBinary, splitSegments, tokenize } from "./shell-args.js";

const GENERATED = ["node_modules", ".git", "target", "dist", "build", ".next", "vendor", "__pycache__"];
const SEARCH_BINARIES = new Set(["find", "grep", "egrep", "fgrep", "rg", "ag", "ack", "ugrep"]);
const RECURSIVE = ["-r", "-R", "--recursive", "-recurse"];
const EXCLUSION = ["--exclude", "--exclude-dir", "--glob", "--iglob", "-prune", "-not"];

/**
 * Flags exploration patterns that are usually expensive. Advice only: the plugin never
 * rewrites a search into a different tool, because rg and grep are not interchangeable
 * and rg is not installed everywhere.
 */
export function analyzeSearch(args: unknown, cwd: string | undefined): Finding[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const findings: Finding[] = [];

  if (typeof record.command === "string") {
    for (const segment of splitSegments(record.command)) {
      findings.push(...analyzeCommandSegment(segment));
    }
    return findings;
  }

  const scope = record.path ?? record.directory;
  if (typeof scope === "string" && scope.length > 0) {
    const absolute = normalizePath(scope, cwd);
    const generated = GENERATED.find((dir) => absolute.endsWith("/" + dir) || absolute.includes("/" + dir + "/"));
    if (generated !== undefined) {
      findings.push({
        rule: "search.generated-directory",
        severity: "warn",
        message: "Search scoped to " + generated + ", which is usually large and machine-generated.",
        detail: { directory: generated },
      });
    }
  }
  return findings;
}

function analyzeCommandSegment(segment: string): Finding[] {
  const resolved = resolveBinary(tokenize(segment));
  if (resolved === null || !SEARCH_BINARIES.has(resolved.bin)) return [];
  const { bin, args } = resolved;
  const findings: Finding[] = [];

  // Only non-flag tokens can be paths. "--exclude-dir=node_modules" is a flag, so an
  // excluded directory is never mistaken for a searched one.
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  const flagText = args.filter((arg) => arg.startsWith("-")).join(" ");

  const generated = GENERATED.find(
    (dir) => positionals.some((arg) => arg.split(/[/\\]/).includes(dir)),
  );
  if (generated !== undefined) {
    findings.push({
      rule: "search.generated-directory",
      severity: "warn",
      message: "Search descends into " + generated + ", which is usually large and machine-generated.",
      detail: { directory: generated, binary: bin },
    });
  }

  const recursive = args.some((arg) => RECURSIVE.includes(arg)) || bin === "find" || bin === "rg" || bin === "ag";
  const excludes = EXCLUSION.some((flag) => flagText.includes(flag));
  const fromRoot = positionals.some((arg) => arg === "." || arg === "/" || arg === "./" || arg === "..");
  if (recursive && fromRoot && !excludes) {
    findings.push({
      rule: "search.recursive-root",
      severity: "warn",
      message: "Recursive search from the project root with no exclusions. Narrow the path or add one.",
      detail: { binary: bin },
    });
  }
  return findings;
}
