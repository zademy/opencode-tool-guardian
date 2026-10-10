import type { ToolClass } from "./models.js";

const READ = new Set(["read", "grep", "glob", "list", "ls", "search", "view", "cat"]);
const EXEC = new Set(["bash", "shell", "sh", "run", "execute", "terminal"]);
const MODIFY = new Set(["edit", "write", "multiedit", "applypatch", "patch", "create", "delete", "remove"]);

/**
 * Classify from the tool id the runtime reports. Names are only a hint: an
 * unrecognised id is "unknown", and "unknown" is never assumed to be read-only.
 */
export function classifyTool(toolId: string): ToolClass {
  const id = toolId.toLowerCase().replace(/[^a-z]/g, "");
  if (READ.has(id)) return "read";
  if (EXEC.has(id)) return "exec";
  if (MODIFY.has(id)) return "modify";
  if (id.startsWith("mcp") || toolId.toLowerCase().includes("mcp_")) return "unknown";
  if (/^(read|get|search|list|find|view)/.test(id)) return "read";
  if (/^(exec|run|bash|shell|command)/.test(id)) return "exec";
  if (/^(write|edit|patch|delete|remove|create|apply)/.test(id)) return "modify";
  return "unknown";
}

/** Structured payload tools use for a shell command. */
export function commandFromArguments(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Structured payload tools use for a search pattern. */
export function patternFromArguments(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["pattern", "query", "regex", "glob"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
