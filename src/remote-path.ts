import { posix } from "node:path";

export function normalizeRemotePath(remotePath: string): string {
  if (remotePath.length === 0) {
    return ".";
  }

  if (remotePath.startsWith("/")) {
    return posix.normalize(remotePath);
  }

  return posix.normalize(remotePath);
}

export function dirnameRemote(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  const dirname = posix.dirname(normalized);
  return dirname.length === 0 ? "." : dirname;
}

export function splitRemotePath(remotePath: string): string[] {
  return normalizeRemotePath(remotePath)
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
}

export function joinRemotePath(...parts: string[]): string {
  return posix.join(...parts);
}
