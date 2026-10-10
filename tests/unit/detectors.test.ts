import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState, type SessionState } from "../../src/core/models.js";
import { invocationFingerprint, stateFingerprint } from "../../src/core/fingerprints.js";
import { detectDuplicate, rememberCall } from "../../src/core/detector-duplicates.js";
import { detectFailureLoop, recordFailure } from "../../src/core/detector-failures.js";
import { analyzeSearch } from "../../src/core/detector-search.js";

function state(): SessionState {
  return newSessionState("ses_test", 0);
}

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otg-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, contents);
  return file;
}

describe("duplicate detector", () => {
  test("different cwd is never the same call", () => {
    const s = state();
    const a = invocationFingerprint("bash", { command: "ls" }, "/w/a", null);
    const b = invocationFingerprint("bash", { command: "ls" }, "/w/b", null);
    expect(a.id).not.toBe(b.id);
  });

  test("reordered JSON keys are the same call", () => {
    expect(invocationFingerprint("read", { limit: 10, offset: 0 }, "/w", null).id).toBe(
      invocationFingerprint("read", { offset: 0, limit: 10 }, "/w", null).id,
    );
  });

  test("unprovable state yields possible_duplicate, never confirmed", () => {
    const s = state();
    const fingerprint = invocationFingerprint("bash", { command: "mvn test" }, "/w", null);
    rememberCall(s, fingerprint, 100);
    expect(detectDuplicate(s, fingerprint, "exec", "/w")?.rule).toBe("duplicate.possible");
  });

  test("changed file content invalidates equality", () => {
    const file = tempFile("one");
    const first = stateFingerprint(file, undefined);
    writeFileSync(file, "two");
    const second = stateFingerprint(file, undefined);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    rmSync(file, { force: true });
  });

  test("identical bytes confirm the duplicate", () => {
    const file = tempFile("same");
    const s = state();
    const digest = stateFingerprint(file, undefined);
    const fingerprint = { id: "fixed", state: digest };
    rememberCall(s, fingerprint, 100);
    expect(detectDuplicate(s, fingerprint, "read", "/w")?.rule).toBe("duplicate.confirmed");
    rmSync(file, { force: true });
  });

  test("a missing file yields no state proof", () => {
    expect(stateFingerprint("/definitely/not/here.txt", undefined)).toBeNull();
  });

  test("the seen map stays bounded", () => {
    const s = state();
    for (let i = 0; i < 50; i += 1) {
      rememberCall(s, invocationFingerprint("bash", { command: "c" + i }, "/w", null), 10);
    }
    expect(s.seen.size).toBe(10);
  });
});

describe("failure loop detector", () => {
  const failure = { message: "ENOENT: no such file or directory", exitCode: 1 };

  test("counts consecutive identical failures", () => {
    const s = state();
    const fingerprint = { id: "x", state: null };
    expect(detectFailureLoop(recordFailure(s, fingerprint, failure, 100), 3)).toBeNull();
    expect(detectFailureLoop(recordFailure(s, fingerprint, failure, 100), 3)).toBeNull();
    expect(detectFailureLoop(recordFailure(s, fingerprint, failure, 100), 3)?.rule).toBe("failures.repeated");
  });

  test("a different error signature restarts the count", () => {
    const s = state();
    const fingerprint = { id: "x", state: null };
    recordFailure(s, fingerprint, failure, 100);
    recordFailure(s, fingerprint, failure, 100);
    const third = recordFailure(s, fingerprint, { message: "EACCES: permission denied" }, 100);
    expect(third.count).toBe(1);
    expect(detectFailureLoop(third, 3)).toBeNull();
  });

  test("different arguments are different calls and never loop", () => {
    const s = state();
    const a = invocationFingerprint("bash", { command: "mvn test" }, "/w", null);
    const b = invocationFingerprint("bash", { command: "mvn test -DskipTests" }, "/w", null);
    expect(a.id).not.toBe(b.id);
    recordFailure(s, a, failure, 100);
    expect(detectFailureLoop(recordFailure(s, b, failure, 100), 3)).toBeNull();
  });

  test("a recovered call resets the streak", () => {
    const s = state();
    const fingerprint = { id: "x", state: null };
    recordFailure(s, fingerprint, failure, 100);
    recordFailure(s, fingerprint, failure, 100);
    // Success clears the entry the way the adapter does by overwriting on the next failure.
    s.failures.delete(fingerprint.id);
    expect(detectFailureLoop(recordFailure(s, fingerprint, failure, 100), 3)).toBeNull();
  });
});

describe("excessive search advisor", () => {
  test("flags generated directories", () => {
    expect(analyzeSearch({ path: "node_modules" }, "/w").map((f) => f.rule)).toContain("search.generated-directory");
    expect(analyzeSearch({ command: "grep -r foo target/" }, "/w").map((f) => f.rule)).toContain(
      "search.generated-directory",
    );
  });

  test("flags unbounded recursion from the root", () => {
    expect(analyzeSearch({ command: "find . -name '*.ts'" }, "/w").map((f) => f.rule)).toContain(
      "search.recursive-root",
    );
  });

  test("does not flag a search that already excludes directories", () => {
    expect(analyzeSearch({ command: "grep -r --exclude-dir=node_modules foo ." }, "/w")).toEqual([]);
  });

  test("a narrow search is silent", () => {
    expect(analyzeSearch({ path: "src/core", pattern: "x" }, "/w")).toEqual([]);
  });
});
