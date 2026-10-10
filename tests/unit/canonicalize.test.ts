import { describe, expect, test } from "bun:test";
import { canonicalize, isWithin, normalizePath } from "../../src/core/canonicalize.js";

describe("canonicalize", () => {
  test("is stable across reordered JSON keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("keeps array order", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    expect(canonicalize({ xs: [1, 2] })).toBe(canonicalize({ xs: [1, 2] }));
  });

  test("preserves string content exactly", () => {
    expect(canonicalize("rm -rf /")).toBe(canonicalize("rm -rf /"));
    expect(canonicalize("a b")).not.toBe(canonicalize("a  b"));
  });

  test("drops undefined members and survives cycles", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).not.toThrow();
  });
});

describe("normalizePath", () => {
  test("resolves relative paths against cwd and collapses traversal", () => {
    const cwd = "/tmp/project";
    expect(normalizePath("src/index.ts", cwd)).toBe("/tmp/project/src/index.ts");
    expect(normalizePath("./src/../src/index.ts", cwd)).toBe("/tmp/project/src/index.ts");
    expect(normalizePath("../sibling/file.ts", cwd)).toBe("/tmp/sibling/file.ts");
  });

  test("expands a leading tilde", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (home.length > 0) expect(normalizePath("~/.ssh/config")).toBe(home + "/.ssh/config");
  });

  test("handles paths containing spaces", () => {
    expect(normalizePath("my project/a b.txt", "/tmp")).toBe("/tmp/my project/a b.txt");
  });

  test("POSIX shapes", () => {
    expect(normalizePath("/Users/me/a.txt")).toBe("/Users/me/a.txt");
    // Backslash is a legal filename character on POSIX and must not become a separator.
    expect(normalizePath("/tmp/a\\b.txt")).toBe("/tmp/a\\b.txt");
    expect(normalizePath("rel/../x.txt", "/base")).toBe("/base/x.txt");
  });

  // These run on every platform: a Windows-looking path must normalize with Windows
  // rules no matter which machine computes it, otherwise the Windows behaviour of the
  // whole plugin can never be verified from Linux or macOS.
  test("Windows shapes normalize identically on any host", () => {
    expect(normalizePath("C:\\Users\\me\\a.txt")).toBe("c:/Users/me/a.txt");
    expect(normalizePath("C:\\Users\\me\\a.txt", "/ignored")).toBe("c:/Users/me/a.txt");
    expect(normalizePath("c:/Users/me/a.txt")).toBe("c:/Users/me/a.txt");
    expect(normalizePath("src\\notes.txt", "C:\\Users\\me\\proj")).toBe("c:/Users/me/proj/src/notes.txt");
    expect(normalizePath("\\\\server\\share\\a.txt")).toBe("//server/share/a.txt");
  });
});

describe("isWithin", () => {
  test("accepts the root itself and descendants", () => {
    expect(isWithin("/w", "/w")).toBe(true);
    expect(isWithin("/w", "/w/a/b")).toBe(true);
  });

  test("rejects siblings that merely share a prefix", () => {
    expect(isWithin("/w", "/wx/a")).toBe(false);
    expect(isWithin("/w", "/")).toBe(false);
    expect(isWithin("", "/a")).toBe(false);
  });

  // Regression: the workspace root arrives raw from ctx.location with native
  // separators while candidates are already normalized. Comparing the raw form made
  // every project file look like it was outside the workspace on Windows.
  test("accepts a raw Windows workspace root against normalized candidates", () => {
    expect(isWithin("C:\\Users\\me\\proj", "c:/Users/me/proj/src/notas.txt")).toBe(true);
    expect(isWithin("C:\\Users\\me\\proj" + "\\", "c:/Users/me/proj")).toBe(true);
    expect(isWithin("C:\\Users\\me\\proj", "c:/Users/me/otro/a.ts")).toBe(false);
  });
});
