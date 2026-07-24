import { describe, expect, it } from "vitest";

import { dirnameRemote, joinRemotePath, normalizeRemotePath, splitRemotePath } from "../src/remote-path.js";

describe("remote path helpers", () => {
  it("normalizes absolute and relative remote paths", () => {
    expect(normalizeRemotePath("/var//log/../tmp")).toBe("/var/tmp");
    expect(normalizeRemotePath("apps//service/./logs")).toBe("apps/service/logs");
  });

  it("splits remote paths into useful segments", () => {
    expect(splitRemotePath("/opt/app/releases")).toEqual(["opt", "app", "releases"]);
    expect(splitRemotePath("./a/b")).toEqual(["a", "b"]);
  });

  it("returns dirname and joins using POSIX separators", () => {
    expect(dirnameRemote("/opt/app/file.txt")).toBe("/opt/app");
    expect(joinRemotePath("/opt", "app", "file.txt")).toBe("/opt/app/file.txt");
  });
});
