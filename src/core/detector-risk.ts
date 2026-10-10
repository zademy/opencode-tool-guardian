import type { Finding } from "./models.js";
import { isWithin, normalizePath } from "./canonicalize.js";
import { isBinary, resolveBinary, splitSegments, tokenize } from "./shell-args.js";

/**
 * Conservative command risk analysis.
 *
 * A "block" severity means the detection is unambiguous *given that argv[0] really is
 * the dangerous binary*: it never fires on a substring inside a quoted string, a
 * comment or prose. Even then it only becomes a decision in `enforce` mode, and only
 * when the rule is explicitly listed in `policy.blockRules` (empty by default).
 */

const ROOT_TARGETS = new Set(["/", "/*", "//", "~", "~/", "$HOME", "${HOME}", "/.", "/.."]);

const SENSITIVE = [
  "/.ssh",
  "/.aws",
  "/.gnupg",
  "/.config/gcloud",
  "/etc",
  "/.zshrc",
  "/.bashrc",
  "/.bash_profile",
  "/.profile",
  "/.git/hooks",
  "/.git/config",
];

const DISK_BINARIES = new Set(["mke2fs", "fdisk", "parted", "diskutil"]);
const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "fish"]);
const FETCH_BINARIES = new Set(["curl", "wget"]);

export interface RiskContext {
  readonly workspace: string;
  readonly cwd?: string;
}

export function analyzeCommand(command: string, context: RiskContext): Finding[] {
  const findings: Finding[] = [];
  const segments = splitSegments(command);
  if (segments.length === 0) return findings;

  if (/:\(\)\s*\{.*\|.*&.*\}\s*;\s*:/.test(command)) {
    findings.push({ rule: "risk.fork-bomb", severity: "block", message: "Fork bomb pattern detected." });
  }

  segments.forEach((segment, index) => {
    findings.push(...analyzeSegment(segment, index, segments, context));
  });
  return dedupe(findings);
}

function analyzeSegment(
  segment: string,
  index: number,
  segments: readonly string[],
  context: RiskContext,
): Finding[] {
  const findings: Finding[] = [];
  const resolved = resolveBinary(tokenize(segment));
  if (resolved === null) return findings;
  const { bin, args } = resolved;
  const base = context.cwd ?? context.workspace;
  const absolute = (target: string): string => normalizePath(target, base);

  if (bin === "rm") {
    const recursive = hasShort(args, "r") || hasAny(args, ["--recursive"]);
    const force = hasShort(args, "f") || hasAny(args, ["--force"]);
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && force) {
      if (targets.some((t) => ROOT_TARGETS.has(t))) {
        findings.push({
          rule: "risk.rm-destructive",
          severity: "block",
          message: "Recursive force delete aimed at a filesystem or home root.",
          detail: { targets },
        });
      } else if (targets.some((t) => absolute(t) === normalizePath(context.workspace))) {
        findings.push({
          rule: "risk.rm-workspace-root",
          severity: "block",
          message: "Recursive force delete aimed at the workspace root.",
          detail: { targets },
        });
      }
    }
  }

  // mkfs, mkfs.ext4, mkfs.xfs ... all take a device name.
  if (DISK_BINARIES.has(bin) || bin.startsWith("mkfs")) {
    findings.push({
      rule: "risk.disk-write",
      severity: "block",
      message: "Filesystem or partition write command.",
      detail: { binary: bin },
    });
  }

  if (bin === "dd" && args.some((a) => a.startsWith("of=/dev/"))) {
    findings.push({
      rule: "risk.disk-write",
      severity: "block",
      message: "Raw write to a block device.",
      detail: { binary: bin },
    });
  }

  if (bin === "chmod" || bin === "chown") {
    const recursive = hasShort(args, "r") || hasAny(args, ["--recursive"]);
    const broad = args.some((a) => a === "777" || a === "a+rwx" || a === "+rwx");
    if (recursive && (broad || args.some((a) => ROOT_TARGETS.has(a)))) {
      findings.push({
        rule: "risk.permissions-broad",
        severity: "block",
        message: "Broad recursive permission change.",
        detail: { binary: bin },
      });
    }
  }

  const next = segments[index + 1];
  if (next !== undefined && FETCH_BINARIES.has(bin)) {
    let piped = false;
for (const shell of SHELL_BINARIES) {
  if (isBinary(next, shell) !== null) {
    piped = true;
    break;
  }
}
    if (piped) {
      findings.push({
        rule: "risk.remote-code-execution",
        severity: "warn",
        message: "Remote script downloaded and piped into a shell.",
        detail: { binary: bin },
      });
    }
  }

  if (bin === "git") {
    if (args[0] === "clean" && hasShort(args, "f") && (hasShort(args, "x") || hasAny(args, ["-x", "-X", "--expunge", "--exclude-standard"]))) {
      findings.push({
        rule: "risk.vcs-destructive",
        severity: "warn",
        message: "git clean with force removes ignored files and build output.",
        detail: { args: args.slice(0, 4) },
      });
    }
    if (args[0] === "push" && (hasAny(args, ["--force", "--force-with-lease"]) || hasShort(args, "f"))) {
      findings.push({
        rule: "risk.vcs-destructive",
        severity: "warn",
        message: "Force push overwrites remote history.",
        detail: { args: args.slice(0, 4) },
      });
    }
  }

  for (const target of args.filter((a) => !a.startsWith("-") && (a.includes("/") || a.startsWith("~")))) {
    const path = absolute(target);
    if (!isWithin(context.workspace, path)) {
      findings.push({
        rule: "risk.outside-workspace",
        severity: "warn",
        message: "Command touches a path outside the workspace.",
        detail: { path },
      });
    } else if (SENSITIVE.some((fragment) => path.includes(fragment))) {
      findings.push({
        rule: "risk.sensitive-path",
        severity: "warn",
        message: "Command touches a sensitive path.",
        detail: { path },
      });
    }
  }

  return findings;
}

/** Short flags may be bundled: -fdx satisfies both -f and -x. */
function hasShort(args: readonly string[], flag: string): boolean {
  return args.some(
    (arg) => arg.length > 1 && !arg.startsWith("--") && arg.slice(1).includes(flag) && /^-[A-Za-z]+$/.test(arg),
  );
}

function hasAny(args: readonly string[], candidates: readonly string[]): boolean {
  return args.some((arg) => candidates.includes(arg));
}

function has(args: readonly string[], candidates: readonly string[]): boolean {
  return args.some((arg) => candidates.includes(arg));
}

function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = finding.rule + "|" + JSON.stringify(finding.detail ?? {});
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}
