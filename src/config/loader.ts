import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { DEFAULT_CONFIG, parseConfig, type Config, type LoadedConfig } from "./schema.js";

const FILE_NAMES = ["tool-guardian.jsonc", "tool-guardian.json", ".tool-guardian.jsonc"];

/**
 * Resolves the config file: project-local first (current directory, then ancestors),
 * then the user's OpenCode config directory. An unreadable or invalid file never
 * throws: defaults are used and the errors are reported through the normal report.
 */
export function loadConfig(cwd: string | undefined, overridePath?: string): LoadedConfig {
  const candidates: string[] = [];
  if (overridePath !== undefined) candidates.push(overridePath);
  let dir = cwd;
  while (dir !== undefined && dir.length > 0) {
    for (const name of FILE_NAMES) candidates.push(join(dir, name));
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const name of FILE_NAMES) candidates.push(join(homedir(), ".config", "opencode", name));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return readConfigFile(candidate);
  }
  return { config: DEFAULT_CONFIG, source: "defaults", errors: [] };
}

function readConfigFile(path: string): LoadedConfig {
  let raw: unknown;
  const errors: string[] = [];
  try {
    const text = readFileSync(path, "utf8");
    // jsonc.parse() returns the value and *fills* the diagnostics array; it is not a tuple.
    const parseErrors: ParseError[] = [];
    const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
    for (const error of parseErrors) errors.push("JSON error at offset " + error.offset);
    if (errors.length > 0) return { config: DEFAULT_CONFIG, source: path, errors };
    raw = value;
  } catch (error) {
    return { config: DEFAULT_CONFIG, source: path, errors: ["unreadable: " + (error as Error).message] };
  }
  const result = parseConfig(raw ?? {});
  if ("errors" in result) return { config: DEFAULT_CONFIG, source: path, errors: result.errors };
  return { config: result.config, source: path, errors: [] };
}

/** Programmatic override for tests and for the `opencode.json` options object form. */
export function configFromOptions(options: unknown): { config: Config; errors: string[] } {
  if (options === undefined || options === null) return { config: DEFAULT_CONFIG, errors: [] };
  const result = parseConfig(options);
  return "errors" in result ? { config: DEFAULT_CONFIG, errors: result.errors } : { config: result.config, errors: [] };
}
