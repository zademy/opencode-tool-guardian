import { describe, expect, test } from "bun:test";
import { isBinary, resolveBinary, splitSegments, tokenize } from "../../src/core/shell-args.js";

describe("tokenize", () => {
  test("keeps a quoted string as one token", () => {
    expect(tokenize('echo "rm -rf /"')).toEqual(["echo", "rm -rf /"]);
  });

  test("handles single quotes and POSIX escapes of metacharacters", () => {
    expect(tokenize("echo 'a b'")).toEqual(["echo", "a b"]);
    // Un espacio escapado sigue siendo un escape de verdad.
    expect(tokenize("echo a\\ b")).toEqual(["echo", "a b"]);
  });

  test("keeps backslashes literal outside metacharacters", () => {
    // En Windows la barra invertida separa rutas: comersela convertia
    // D:\etc en D:etc y volvia invisibles las rutas nativas.
    expect(tokenize("cat D:\\etc\\hosts")).toEqual(["cat", "D:\\etc\\hosts"]);
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
