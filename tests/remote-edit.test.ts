import { describe, expect, it } from "vitest";

import { applyUnifiedPatch, parseUnifiedPatch, patchTargetPath, sha256 } from "../src/remote-edit.js";

describe("remote edit helpers", () => {
  it("applies a unified patch to text", () => {
    const [patchFile] = parseUnifiedPatch(`
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function hello(): string {
-  return "hello";
+  const greeting = "hello";
+  return greeting;
 }
`);

    expect(patchFile).toBeDefined();
    expect(patchTargetPath(patchFile!)).toBe("src/app.ts");
    expect(applyUnifiedPatch('export function hello(): string {\n  return "hello";\n}\n', patchFile!)).toBe(
      'export function hello(): string {\n  const greeting = "hello";\n  return greeting;\n}\n',
    );
  });

  it("rejects unified patches with stale context", () => {
    const [patchFile] = parseUnifiedPatch(`
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 export function hello(): string {
-  return "hello";
+  return "hi";
 }
`);

    expect(() => applyUnifiedPatch('export function hello(): string {\n  return "changed";\n}\n', patchFile!)).toThrow(
      "Unified patch context does not match file",
    );
  });

  it("hashes file content for expectedSha256 checks", () => {
    expect(sha256(Buffer.from("hello\n", "utf8"))).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
  });
});
