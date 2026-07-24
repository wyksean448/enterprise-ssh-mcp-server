import type { Attributes, FileEntryWithStats, InputAttributes, SFTPWrapper, Stats, WriteFileOptions } from "ssh2";

import { McpToolError } from "./tool-result.js";
import { joinRemotePath, normalizeRemotePath, splitRemotePath } from "./remote-path.js";

export interface FileAttributesJson {
  mode: number;
  modeOctal: string;
  permissionsOctal: string;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
}

export interface FileStatsJson extends FileAttributesJson {
  type: string;
}

export interface DirectoryEntryJson {
  filename: string;
  longname: string;
  attrs: FileStatsJson;
}

export interface RemoteReadResult {
  data: string;
  encoding: "utf8" | "base64";
  bytesRead: number;
  truncated: boolean;
}

export type SmallWriteFlag = "w" | "wx" | "a" | "ax";

export function attributesToJson(attrs: Attributes): FileAttributesJson {
  return {
    mode: attrs.mode,
    modeOctal: `0${attrs.mode.toString(8)}`,
    permissionsOctal: `0${(attrs.mode & 0o777).toString(8).padStart(3, "0")}`,
    uid: attrs.uid,
    gid: attrs.gid,
    size: attrs.size,
    atime: attrs.atime,
    mtime: attrs.mtime,
  };
}

export function statsToJson(stats: Stats): FileStatsJson {
  return {
    ...attributesToJson(stats),
    type: classifyStats(stats),
  };
}

export function entryToJson(entry: FileEntryWithStats): DirectoryEntryJson {
  return {
    filename: entry.filename,
    longname: entry.longname,
    attrs: statsToJson(entry.attrs),
  };
}

export function sftpStat(sftp: SFTPWrapper, remotePath: string, followSymlinks: boolean): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const callback = (err: Error | null | undefined, stats: Stats): void => {
      if (err != null) {
        reject(wrapSftpError("stat", remotePath, err));
        return;
      }
      resolve(stats);
    };

    if (followSymlinks) {
      sftp.stat(remotePath, callback);
      return;
    }

    sftp.lstat(remotePath, callback);
  });
}

export function sftpReadDir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err: Error | null | undefined, list: FileEntryWithStats[]) => {
      if (err != null) {
        reject(wrapSftpError("readdir", remotePath, err));
        return;
      }
      resolve(list);
    });
  });
}

export function sftpMkdir(sftp: SFTPWrapper, remotePath: string, attrs?: InputAttributes): Promise<void> {
  return new Promise((resolve, reject) => {
    const callback = (err: Error | null | undefined): void => {
      if (err != null) {
        reject(wrapSftpError("mkdir", remotePath, err));
        return;
      }
      resolve();
    };

    if (attrs !== undefined) {
      sftp.mkdir(remotePath, attrs, callback);
      return;
    }

    sftp.mkdir(remotePath, callback);
  });
}

export async function sftpMkdirRecursive(sftp: SFTPWrapper, remotePath: string, attrs?: InputAttributes): Promise<void> {
  const normalized = normalizeRemotePath(remotePath);
  const parts = splitRemotePath(normalized);
  let current = normalized.startsWith("/") ? "/" : "";

  for (const part of parts) {
    current = current === "/" ? `/${part}` : current.length === 0 ? part : joinRemotePath(current, part);
    try {
      const stats = await sftpStat(sftp, current, false);
      if (!stats.isDirectory()) {
        throw new McpToolError("remote_path_not_directory", "Remote path exists but is not a directory", {
          path: current,
        });
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      await sftpMkdir(sftp, current, attrs);
    }
  }
}

export function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("unlink", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export function sftpRmdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("rmdir", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export async function sftpRemove(sftp: SFTPWrapper, remotePath: string, recursive: boolean): Promise<void> {
  const stats = await sftpStat(sftp, remotePath, false);
  if (!stats.isDirectory()) {
    await sftpUnlink(sftp, remotePath);
    return;
  }

  if (!recursive) {
    throw new McpToolError("recursive_required", "Remote path is a directory; pass recursive=true to remove it", {
      path: remotePath,
    });
  }

  const entries = await sftpReadDir(sftp, remotePath);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") {
      continue;
    }
    await sftpRemove(sftp, joinRemotePath(remotePath, entry.filename), true);
  }
  await sftpRmdir(sftp, remotePath);
}

export function sftpRename(sftp: SFTPWrapper, sourcePath: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(sourcePath, destinationPath, (err: Error | null | undefined) => {
      if (err != null) {
        reject(new McpToolError("sftp_rename_failed", err.message, { sourcePath, destinationPath }));
        return;
      }
      resolve();
    });
  });
}

export function sftpChmod(sftp: SFTPWrapper, remotePath: string, mode: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("chmod", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export function sftpChown(sftp: SFTPWrapper, remotePath: string, uid: number, gid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chown(remotePath, uid, gid, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("chown", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export function sftpUtimes(sftp: SFTPWrapper, remotePath: string, atime: Date, mtime: Date): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.utimes(remotePath, atime, mtime, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("utimes", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export function sftpReadlink(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.readlink(remotePath, (err: Error | null | undefined, target: string) => {
      if (err != null) {
        reject(wrapSftpError("readlink", remotePath, err));
        return;
      }
      resolve(target);
    });
  });
}

export function sftpSymlink(sftp: SFTPWrapper, targetPath: string, linkPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.symlink(targetPath, linkPath, (err: Error | null | undefined) => {
      if (err != null) {
        reject(new McpToolError("sftp_symlink_failed", err.message, { targetPath, linkPath }));
        return;
      }
      resolve();
    });
  });
}

export function sftpRealpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (err: Error | null | undefined, absolutePath: string) => {
      if (err != null) {
        reject(wrapSftpError("realpath", remotePath, err));
        return;
      }
      resolve(absolutePath);
    });
  });
}

export function sftpWriteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  data: Buffer,
  mode: number | undefined,
  flag: SmallWriteFlag,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: WriteFileOptions = mode === undefined ? { flag } : { flag, mode };
    sftp.writeFile(remotePath, data, options, (err: Error | null | undefined) => {
      if (err != null) {
        reject(wrapSftpError("writeFile", remotePath, err));
        return;
      }
      resolve();
    });
  });
}

export function sftpReadFileLimited(
  sftp: SFTPWrapper,
  remotePath: string,
  encoding: "utf8" | "base64",
  maxBytes: number,
): Promise<RemoteReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let resolved = false;
    let truncated = false;

    const finish = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      const buffer = Buffer.concat(chunks, bytesRead);
      resolve({
        data: encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
        encoding,
        bytesRead,
        truncated,
      });
    };

    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (chunk: Buffer) => {
      if (resolved) {
        return;
      }

      const remaining = maxBytes - bytesRead;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        bytesRead += chunk.length;
        return;
      }

      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        bytesRead += remaining;
      }
      truncated = true;
      finish();
      stream.destroy();
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (err: Error) => {
      if (resolved) {
        return;
      }
      reject(wrapSftpError("readFile", remotePath, err));
    });
  });
}

export function isMissingPathError(error: Error): boolean {
  if (error instanceof McpToolError) {
    return error.code === "sftp_stat_failed" && /no such file|not found|failure/i.test(error.message);
  }

  const errno = error as NodeJS.ErrnoException;
  return errno.code === "ENOENT" || /no such file|not found/i.test(error.message);
}

function wrapSftpError(action: string, remotePath: string, error: Error): McpToolError {
  return new McpToolError(`sftp_${action}_failed`, error.message, { action, remotePath });
}

function classifyStats(stats: Stats): string {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isBlockDevice()) {
    return "block_device";
  }
  if (stats.isCharacterDevice()) {
    return "character_device";
  }
  if (stats.isFIFO()) {
    return "fifo";
  }
  if (stats.isSocket()) {
    return "socket";
  }
  return "unknown";
}
