import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromOptions, loadConfig } from "../../src/config/loader.js";
import { DEFAULT_CONFIG, parseConfig } from "../../src/config/schema.js";
import { SessionStore } from "../../src/state/session-store.js";
import { estimateTokens, measureResult, recordOutput } from "../../src/core/estimator-output.js";
import { emptyMetrics } from "../../src/core/models.js";

const NL = String.fromCharCode(10);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  test("defaults are safe: observe mode and an empty block list", () => {
    expect(DEFAULT_CONFIG.mode).toBe("observe");
    expect(DEFAULT_CONFIG.policy.blockRules).toEqual([]);
    expect(DEFAULT_CONFIG.cache.enabled).toBe(false);
    expect(DEFAULT_CONFIG.rewrites.enabled).toBe(false);
  });

  test("reads a jsonc file with comments and trailing commas", () => {
    writeFileSync(
      join(dir, "tool-guardian.jsonc"),
      ["{", "  // the mode is the important bit", '  "mode": "warn",', '  "thresholds": { "repeatedFailureCount": 2 },', "}"].join(NL),
    );
    const loaded = loadConfig(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.mode).toBe("warn");
    expect(loaded.config.thresholds.repeatedFailureCount).toBe(2);
  });

  test("a malformed file falls back to defaults and reports the error", () => {
    writeFileSync(join(dir, "tool-guardian.jsonc"), "{ this is not json");
    const loaded = loadConfig(dir);
    expect(loaded.config.mode).toBe("observe");
    expect(loaded.errors.length).toBeGreaterThan(0);
  });

  test("an unknown key is rejected instead of being silently ignored", () => {
    expect("errors" in parseConfig({ mode: "warn", nope: true })).toBe(true);
  });

  test("an out-of-range threshold is rejected", () => {
    expect("errors" in parseConfig({ thresholds: { repeatedFailureCount: 0 } })).toBe(true);
  });

  test("an unknown mode is rejected", () => {
    expect("errors" in parseConfig({ mode: "paranoid" })).toBe(true);
  });

  test("options from opencode.json parse the same way", () => {
    expect(configFromOptions({ mode: "enforce" }).config.mode).toBe("enforce");
    expect(configFromOptions(undefined).config.mode).toBe("observe");
    expect(configFromOptions({ mode: "nope" }).errors.length).toBeGreaterThan(0);
  });

  test("a missing config file yields defaults and no error", () => {
    const loaded = loadConfig(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });
});

describe("session store", () => {
  test("keeps sessions apart and evicts the oldest past the limit", () => {
    const store = new SessionStore({ maxSessions: 2, ttlMs: 10000, now: () => 0 });
    store.get("a");
    store.get("b");
    store.get("c");
    expect(store.peek("a")).toBeUndefined();
    expect(store.peek("c")).toBeDefined();
  });

  test("two sessions never share metrics", () => {
    const store = new SessionStore({ maxSessions: 8, ttlMs: 10000, now: () => 0 });
    store.get("a").metrics.calls = 5;
    expect(store.get("b").metrics.calls).toBe(0);
  });

  test("expires a session once the ttl passes", () => {
    let clock = 0;
    const store = new SessionStore({ maxSessions: 8, ttlMs: 100, now: () => clock });
    store.get("a").metrics.calls = 5;
    clock = 200;
    // get() is what sweeps expired sessions; it must hand back a fresh state.
    expect(store.get("a").metrics.calls).toBe(0);
  });
});

describe("output estimator", () => {
  test("counts characters, bytes and lines", () => {
    const measured = measureResult({ content: [{ type: "text", text: "uno" + NL + "dos" + NL }] });
    expect(measured.chars).toBe(8);
    expect(measured.lines).toBe(2);
    expect(measured.bytes).toBe(8);
  });

  test("a large output is flagged against the line threshold", () => {
    const text = Array.from({ length: 50 }, (_, i) => "line " + i).join(NL);
    const stats = emptyMetrics().outputs;
    expect(recordOutput(stats, { content: [{ type: "text", text }] }, 10)).toBe(true);
    expect(recordOutput(emptyMetrics().outputs, { content: [{ type: "text", text }] }, 1000)).toBe(false);
    expect(stats.outputs).toBe(1);
    expect(stats.largestChars).toBe(text.length);
  });

  test("token count is a coarse local estimate", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
  });

  test("an absent result measures as empty and a bare output still counts", () => {
    expect(measureResult(undefined).chars).toBe(0);
    expect(measureResult({ output: "abc" }).chars).toBe(3);
  });
});
