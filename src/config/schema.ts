import { z } from "zod";

/**
 * Plugin schema (spec section 6). This is NOT an opencode.json property: OpenCode's
 * official schema has no place for plugin-specific keys, so the config lives in its
 * own tool-guardian.jsonc file.
 */
export const ConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["observe", "warn", "enforce"]).default("observe"),
    detectors: z
      .object({
        duplicates: z.boolean().default(true),
        repeatedFailures: z.boolean().default(true),
        commandRisk: z.boolean().default(true),
        excessiveSearch: z.boolean().default(true),
        outputCost: z.boolean().default(true),
      })
      .default({}),
    thresholds: z
      .object({
        repeatedFailureCount: z.number().int().min(1).default(3),
        largeOutputLines: z.number().int().min(1).default(1500),
        maxTrackedOperations: z.number().int().min(1).default(2000),
        maxSessions: z.number().int().min(1).default(20),
        sessionTtlMs: z.number().int().min(0).default(6 * 60 * 60 * 1000),
      })
      .default({}),
    privacy: z
      .object({
        storeRawToolOutput: z.boolean().default(false),
        storeFullCommands: z.boolean().default(false),
        redactSecrets: z.boolean().default(true),
      })
      .default({}),
    // Spec section 10: result caching and argument rewrites are research items, not
    // MVP features. They are accepted in config only so a future version can honour
    // them without a schema break, and both are inert in 0.1.0.
    cache: z.object({ enabled: z.boolean().default(false) }).default({}),
    rewrites: z.object({ enabled: z.boolean().default(false) }).default({}),
    excludedTools: z.array(z.string()).default([]),
    excludedPaths: z
      .array(z.string())
      .default([".git/**", "node_modules/**", "target/**", "dist/**", "build/**"]),
    /** Empty by default: nothing can block until a rule is named here. */
    policy: z.object({ blockRules: z.array(z.string()).default([]) }).default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export interface LoadedConfig {
  readonly config: Config;
  readonly source: string;
  readonly errors: readonly string[];
}

export function parseConfig(raw: unknown): { config: Config } | { errors: string[] } {
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data };
  return { errors: parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message) };
}
