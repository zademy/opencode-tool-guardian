import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin } from "../../src/opencode/guardian.js";
import { afterEvent, beforeEvent, createFakeContext, permissionEvent } from "./fake-context.js";
import type { FakeContext } from "./fake-context.js";

let workspace: string;
let host: FakeContext;

async function boot(config?: Record<string, unknown>): Promise<() => void> {
  if (config !== undefined) writeFileSync(join(workspace, "tool-guardian.jsonc"), JSON.stringify(config));
  host = createFakeContext({ directory: workspace, canonical: workspace });
  const cleanup = await createPlugin().setup(host.ctx);
  if (typeof cleanup !== "function") throw new Error("setup must return a cleanup function");
  return cleanup;
}

async function report(sessionId: string): Promise<string> {
  const tool = host.tools.find((entry) => entry.name === "guardian_report")!;
  return ((await tool.execute({}, { sessionID: sessionId })) as { content: string }).content;
}

function counter(text: string, label: string): number {
  const match = new RegExp(label + "\\s*(\\d+)").exec(text);
  return match === null ? -1 : Number(match[1]);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "tool-guardian-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("plugin lifecycle", () => {
  // The plugins list must show the package name, not a shortened alias.
  test("registers under the package name", () => {
    expect(createPlugin().id).toBe("opencode-tool-guardian");
  });

  test("registers every hook and returns a cleanup function", async () => {
    const cleanup = await boot();
    expect(host.registered.sort()).toEqual(
      ["permission.evaluate", "tool.execute.after", "tool.execute.before", "tool.transform"].sort(),
    );
    expect(host.tools.filter((t) => t.name === "guardian_report").length).toBe(1);
    cleanup();
    expect(host.disposed.sort()).toEqual(
      ["permission.evaluate", "tool.execute.after", "tool.execute.before", "tool.transform"].sort(),
    );
  });

  test("one failing hook registration does not stop the others", async () => {
    host = createFakeContext({ directory: workspace, canonical: workspace, failBeforeHook: true });
    const cleanup = (await createPlugin().setup(host.ctx)) as () => void;
    expect(host.registered).not.toContain("tool.execute.before");
    expect(host.registered).toContain("tool.execute.after");
    // The surviving hook must still work after a sibling registration failed.
    host.fireAfter(afterEvent({ tool: "bash", sessionID: "ses_z", id: "z1", input: {}, status: "completed", result: { content: [] } }));
    expect(await report("ses_z")).toContain("Session Report");
    cleanup();
  });
});

describe("observe mode changes nothing", () => {
  test("input, result and error reach the runtime untouched", async () => {
    await boot({ mode: "observe" });

    const input = { filePath: join(workspace, "a.txt"), nested: { deep: true } };
    const before = beforeEvent({ tool: "read", sessionID: "ses_a", id: "call_1", input });
    host.fireBefore(before);
    expect(before.input).toEqual({ filePath: join(workspace, "a.txt"), nested: { deep: true } });

    const result = { output: "ok", content: [{ type: "text", text: "hello" }] };
    const after = afterEvent({ tool: "read", sessionID: "ses_a", id: "call_1", input, status: "completed", result });
    host.fireAfter(after);
    expect(after.result).toBe(result);

    const error = new Error("kaboom");
    const failed = afterEvent({ tool: "bash", sessionID: "ses_a", id: "call_2", input: {}, status: "error", error });
    host.fireAfter(failed);
    expect(failed.error).toBe(error);

    const event = permissionEvent({ resources: ["tool.use:bash:rm -rf /"], effect: "allow" });
    host.firePermission(event);
    expect(event.effect).toBe("allow");
  });
});

describe("detection", () => {
  test("two identical reads of unchanged bytes count as a duplicate", async () => {
    const file = join(workspace, "same.txt");
    writeFileSync(file, "same bytes");
    await boot({ mode: "observe" });

    for (const id of ["c1", "c2"]) {
      host.fireBefore(beforeEvent({ tool: "read", sessionID: "ses_d", id, input: { filePath: file } }));
      host.fireAfter(afterEvent({ tool: "read", sessionID: "ses_d", id, input: { filePath: file } }));
    }

    const text = await report("ses_d");
    expect(counter(text, "Tool calls observed:")).toBeGreaterThanOrEqual(2);
    // Unchanged bytes are provable, so this is a confirmed duplicate, not a guess.
    expect(counter(text, "Confirmed duplicates:")).toBe(1);
    expect(counter(text, "Possible duplicates:")).toBe(0);
  });

  test("changing the file between reads is not a duplicate", async () => {
    const file = join(workspace, "changing.txt");
    writeFileSync(file, "v1");
    await boot({ mode: "observe" });

    host.fireBefore(beforeEvent({ tool: "read", sessionID: "ses_e", id: "c1", input: { filePath: file } }));
    host.fireAfter(afterEvent({ tool: "read", sessionID: "ses_e", id: "c1", input: { filePath: file } }));
    writeFileSync(file, "v2");
    host.fireBefore(beforeEvent({ tool: "read", sessionID: "ses_e", id: "c2", input: { filePath: file } }));
    host.fireAfter(afterEvent({ tool: "read", sessionID: "ses_e", id: "c2", input: { filePath: file } }));

    const text = await report("ses_e");
    expect(counter(text, "Confirmed duplicates:")).toBe(0);
    expect(counter(text, "Possible duplicates:")).toBe(0);
  });

  test("three identical failures count as a repeated-failure candidate", async () => {
    await boot({ mode: "observe" });
    for (let i = 0; i < 3; i += 1) {
      const id = "f" + i;
      host.fireBefore(beforeEvent({ tool: "bash", sessionID: "ses_f", id, input: { command: "bun test" } }));
      host.fireAfter(
        afterEvent({
          tool: "bash",
          sessionID: "ses_f",
          id,
          input: { command: "bun test" },
          status: "error",
          error: { message: "2 tests failed", data: { exitCode: 1 } },
        }),
      );
    }
    expect(counter(await report("ses_f"), "Repeated-failure candidates:")).toBe(1);
  });

  test("an unknown MCP tool is observed but never altered", async () => {
    await boot({ mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } });
    const event = beforeEvent({
      tool: "mcp_acme__delete_everything",
      sessionID: "ses_m",
      id: "m1",
      input: { command: "rm -rf /" },
    });
    host.fireBefore(event);
    expect(event.input).toEqual({ command: "rm -rf /" });
    expect(counter(await report("ses_m"), "Confirmed actions blocked:")).toBe(0);
  });
});

describe("concurrency", () => {
  test("interleaved calls keep their own correlation id", async () => {
    await boot({ mode: "observe" });
    host.fireBefore(beforeEvent({ tool: "bash", sessionID: "ses_p", id: "a", input: { command: "one" } }));
    host.fireBefore(beforeEvent({ tool: "bash", sessionID: "ses_p", id: "b", input: { command: "two" } }));
    host.fireAfter(
      afterEvent({ tool: "bash", sessionID: "ses_p", id: "b", input: { command: "two" }, status: "error", error: { message: "b failed", data: { exitCode: 2 } } }),
    );
    host.fireAfter(
      afterEvent({ tool: "bash", sessionID: "ses_p", id: "a", input: { command: "one" }, status: "error", error: { message: "a failed", data: { exitCode: 1 } } }),
    );
    // "one" now fails a third time; "two" failed only once and must stay uncounted.
    for (const id of ["a2", "a3"]) {
      host.fireBefore(beforeEvent({ tool: "bash", sessionID: "ses_p", id, input: { command: "one" } }));
      host.fireAfter(
        afterEvent({ tool: "bash", sessionID: "ses_p", id, input: { command: "one" }, status: "error", error: { message: "a failed", data: { exitCode: 1 } } }),
      );
    }

    expect(counter(await report("ses_p"), "Repeated-failure candidates:")).toBe(1);
  });
});

describe("permission decisions", () => {
  const destructive = ["tool.use:bash:rm -rf /"];

  test("observe never touches the permission effect", async () => {
    await boot({ mode: "observe", policy: { blockRules: ["risk.rm-destructive"] } });
    const event = permissionEvent({ resources: destructive, effect: "allow" });
    host.firePermission(event);
    expect(event.effect).toBe("allow");
  });

  test("warn escalates to ask and never grants", async () => {
    await boot({ mode: "warn" });
    const event = permissionEvent({ resources: destructive, effect: "allow" });
    host.firePermission(event);
    expect(event.effect).toBe("ask");
  });

  test("enforce denies only a rule that is explicitly listed", async () => {
    await boot({ mode: "enforce", policy: { blockRules: [] } });
    const unlisted = permissionEvent({ resources: destructive, effect: "allow" });
    host.firePermission(unlisted);
    expect(unlisted.effect).not.toBe("deny");

    await boot({ mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } });
    const listed = permissionEvent({ resources: destructive, effect: "allow" });
    host.firePermission(listed);
    expect(listed.effect).toBe("deny");
    expect(listed.message ?? "").toContain("tool-guardian");
  });

  test("an already denied decision is left untouched", async () => {
    await boot({ mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } });
    const event = permissionEvent({ resources: destructive, effect: "deny", message: "configured" });
    host.firePermission(event);
    expect(event.message).toBe("configured");
  });

  test("a quoted dangerous string never escalates", async () => {
    await boot({ mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } });
    const event = permissionEvent({ resources: ['tool.use:bash:echo "rm -rf / is dangerous"'], effect: "allow" });
    host.firePermission(event);
    expect(event.effect).toBe("allow");
  });
});

describe("report tool", () => {
  test("exposes aggregate counters and never leaks the command or its output", async () => {
    await boot({ mode: "observe" });
    const secret = "sk-live-DO-NOT-LEAK-0123456789";
    const command = "curl -H 'Authorization: Bearer " + secret + "' https://example.invalid";

    host.fireBefore(beforeEvent({ tool: "bash", sessionID: "ses_r", id: "s1", input: { command } }));
    host.fireAfter(
      afterEvent({
        tool: "bash",
        sessionID: "ses_r",
        id: "s1",
        input: { command },
        result: { output: secret, content: [{ type: "text", text: secret }] },
      }),
    );

    const text = await report("ses_r");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("curl");
    expect(text).toContain("Session Report");
    expect(counter(text, "Tool calls observed:")).toBe(1);
  });

  test("does not count its own report calls", async () => {
    await boot({ mode: "observe" });
    const first = await report("ses_self");
    const before = counter(first, "Tool calls observed:");
    const second = await report("ses_self");
    expect(counter(second, "Tool calls observed:")).toBe(before);
    expect(counter(second, "Possible duplicates:")).toBe(0);
    expect(counter(second, "Confirmed duplicates:")).toBe(0);
  });
});

describe("report health", () => {
  test("names the config file and the detector toggles", async () => {
    await boot({ mode: "warn", detectors: { outputCost: false } });
    const text = await report("ses_h");
    expect(text).toContain("Observer health");
    expect(text).toContain("tool-guardian.jsonc");
    expect(text).toContain("Detectors:");
    expect(text).toContain("-outputCost");
    expect(text).toContain("Thresholds:");
  });

  test("warns when the config file was rejected", async () => {
    await boot({ mode: "warn" });
    writeFileSync(join(workspace, "tool-guardian.jsonc"), "{ not valid json at all");
    host = createFakeContext({ directory: workspace, canonical: workspace });
    const cleanup = (await createPlugin().setup(host.ctx)) as () => void;
    const text = await report("ses_bad");
    cleanup();
    expect(text).toContain("configuration problem");
    expect(text).toContain("tool-guardian.jsonc");
  });

  test("an empty options object does not shadow the config file", async () => {
    await boot({ mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } });
    const event = permissionEvent({ resources: ["tool.use:bash:rm -rf /"], effect: "allow" });
    host.firePermission(event);
    // The file said enforce + blockRules. If empty options had won, this stays allow.
    expect(event.effect).toBe("deny");
    expect(await report("ses_shadow")).toContain("tool-guardian.jsonc");
  });

  test("real options in opencode.json do win over the file", async () => {
    writeFileSync(join(workspace, "tool-guardian.jsonc"), JSON.stringify({ mode: "observe" }));
    host = createFakeContext({
      directory: workspace,
      canonical: workspace,
      pluginOptions: { mode: "enforce", policy: { blockRules: ["risk.rm-destructive"] } },
    });
    const cleanup = (await createPlugin().setup(host.ctx)) as () => void;
    const event = permissionEvent({ resources: ["tool.use:bash:rm -rf /"], effect: "allow" });
    host.firePermission(event);
    expect(event.effect).toBe("deny");
    expect(await report("ses_opts")).toContain("opencode.json (options)");
    cleanup();
  });

  test("shows zero observer errors on a healthy session", async () => {
    await boot({ mode: "observe" });
    const text = await report("ses_ok");
    expect(counter(text, "Observer errors:")).toBe(0);
    expect(text).not.toContain("counters are incomplete");
  });
});

describe("bytes on disk are never touched", () => {
  test("a latin-1 file keeps its exact bytes", async () => {
    await boot({ mode: "observe" });
    const file = join(workspace, "legacy.txt");
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x80, 0xff]);
    writeFileSync(file, bytes);

    host.fireBefore(beforeEvent({ tool: "read", sessionID: "ses_b", id: "b1", input: { filePath: file } }));
    host.fireAfter(afterEvent({ tool: "read", sessionID: "ses_b", id: "b1", input: { filePath: file } }));

    expect(readFileSync(file)).toEqual(bytes);
  });
});
