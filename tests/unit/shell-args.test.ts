import { describe, expect, test } from "bun:test";
import { isBinary, resolveBinary, splitSegments, tokenize } from "../../src/core/shell-args.js";

describe("tokenize", () => {
  test("keeps a quoted string as one token", () => {
    expect(tokenize('echo "rm -rf /"')).toEqual(["echo", "rm -rf /"]);
  });

  test("handles single quotes and escapes", () => {
    expect(tokenize("echo 'a b'")).toEqual(["echo", "a b"]);
    expect(tokenize("echo a\\ b")).toEqual(["echo", "a b"]);
  });
});

describe("splitSegments", () => {
  test("splits on operators outside quotes only", () => {
    expect(splitSegments("ls && rm -rf /")).toEqual(["ls", "rm -rf /"]);
    expect(splitSegments('echo "a;b"')).toEqual(['echo "a;b"']);
    expect(splitSegments("a | b; c")).toEqual(["a", "b", "c"]);
  });
});

describe("resolveBinary", () => {
  test("takes argv[0] only", () => {
    expect(resolveBinary(["echo", "rm"])?.bin).toBe("echo");
    expect(resolveBinary(["/usr/bin/rm", "-rf"])?.bin).toBe("rm");
  });

  test("sees through env assignments and privilege wrappers", () => {
    expect(resolveBinary(["FOO=1", "sudo", "rm", "-rf"])?.bin).toBe("rm");
  });

  test("refuses to reason about xargs", () => {
    expect(resolveBinary(["xargs", "rm"])).toBeNull();
  });

  test("isBinary rejects a dangerous word that is not argv[0]", () => {
    expect(isBinary('echo "rm -rf /"', "rm")).toBeNull();
  });
});
