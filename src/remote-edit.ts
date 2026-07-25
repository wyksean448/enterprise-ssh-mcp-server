import { createHash, randomUUID } from "node:crypto";
import type { SFTPWrapper, Stats } from "ssh2";

import { dirnameRemote, joinRemotePath, normalizeRemotePath } from "./remote-path.js";
import {
  sftpMkdirRecursive,
  sftpReadDir,
  sftpRename,
  sftpStat,
  sftpUnlink,
  sftpWriteFile,
  statsToJson,
  type FileStatsJson,
} from "./sftp-ops.js";
import { McpToolError } from "./tool-result.js";

export interface EditableProfile {
  name: string;
  defaultDir?: string;
  allowEdit?: boolean;
  editRoot?: string;
  maxEditFileBytes?: number;
  backupBeforeEdit?: boolean;
  backupDir?: string;
}

export interface SafeRemotePath {
  rootPath: string;
  remotePath: string;
}

export interface RemoteFileSnapshot {
  remotePath: string;
  data: Buffer;
  sha256: string;
  stats: Stats;
}

export interface PublicRemoteFileSnapshot {
  remotePath: string;
  data: string;
  encoding: "utf8" | "base64";
  bytes: number;
  sha256: string;
  stats: FileStatsJson;
}

export interface RemoteTreeEntry {
  path: string;
  type: string;
  size: number;
  permissionsOctal: string;
  mtime: number;
  children?: RemoteTreeEntry[];
}

export interface RemoteTreeOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
  ignoreNames: string[];
}

export interface BackupRecord {
  editId: string;
  originalPath: string;
  backupPath: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
  isNewFile: boolean;
  isDeletedFile: boolean;
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

interface PatchLine {
  kind: "context" | "remove" | "add";
  text: string;
}

interface SplitText {
  lines: string[];
  trailingNewline: boolean;
}

const DEFAULT_IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
]);

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function defaultEditRoot(profile: EditableProfile): string {
  const root = profile.editRoot ?? profile.defaultDir;
  if (root === undefined || root.trim().length === 0) {
    throw new McpToolError("ssh_project_root_required", "SSH profile needs DEFAULT_DIR, EDIT_ROOT, or projectRoot", {
      profileName: profile.name,
    });
  }
  return root;
}

export function ensureProfileAllowsEdit(profile: EditableProfile): void {
  if (profile.allowEdit !== true) {
    throw new McpToolError("ssh_profile_edit_disabled", "SSH profile editing is disabled", {
      profileName: profile.name,
      requiredEnv: `SSH_MCP_SERVER_<N>_ALLOW_EDIT=true`,
    });
  }
}

export async function resolveProjectRoot(
  sftp: SFTPWrapper,
  profile: EditableProfile,
  projectRoot: string | undefined,
): Promise<string> {
  const editRoot = await sftpRealpathSafe(sftp, defaultEditRoot(profile));
  const candidatePath = projectRoot === undefined ? editRoot : toAbsoluteRemotePath(editRoot, projectRoot);
  const realProjectRoot = await sftpRealpathSafe(sftp, candidatePath);
  assertPathInsideRoot(editRoot, realProjectRoot, projectRoot ?? ".");
  return realProjectRoot;
}

export async function resolveSafeRemotePath(
  sftp: SFTPWrapper,
  profile: EditableProfile,
  projectRoot: string | undefined,
  filePath: string,
  mustExist: boolean,
): Promise<SafeRemotePath> {
  const rootPath = await resolveProjectRoot(sftp, profile, projectRoot);
  const candidatePath = toAbsoluteRemotePath(rootPath, filePath);
  assertPathInsideRoot(rootPath, candidatePath, filePath);

  if (mustExist) {
    const realPath = await sftpRealpathSafe(sftp, candidatePath);
    assertPathInsideRoot(rootPath, realPath, filePath);
    return { rootPath, remotePath: realPath };
  }

  try {
    const realPath = await sftpRealpathSafe(sftp, candidatePath);
    assertPathInsideRoot(rootPath, realPath, filePath);
  } catch (error) {
    if (!isMissingPathLike(error)) {
      throw error;
    }
    const parentPath = dirnameRemote(candidatePath);
    const parentRealPath = await sftpRealpathSafe(sftp, parentPath);
    assertPathInsideRoot(rootPath, parentRealPath, filePath);
  }

  return { rootPath, remotePath: candidatePath };
}

export async function readRemoteFileSnapshot(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number,
): Promise<RemoteFileSnapshot> {
  const stats = await sftpStat(sftp, remotePath, true);
  if (!stats.isFile()) {
    throw new McpToolError("ssh_edit_path_not_file", "Remote path is not a regular file", { remotePath });
  }
  if (stats.size > maxBytes) {
    throw new McpToolError("ssh_edit_file_too_large", "Remote file exceeds max edit size", {
      remotePath,
      bytes: stats.size,
      maxBytes,
    });
  }

  const data = await readRemoteFileBuffer(sftp, remotePath);
  return {
    remotePath,
    data,
    sha256: sha256(data),
    stats,
  };
}

export function publicSnapshot(snapshot: RemoteFileSnapshot, encoding: "utf8" | "base64"): PublicRemoteFileSnapshot {
  return {
    remotePath: snapshot.remotePath,
    data: encoding === "base64" ? snapshot.data.toString("base64") : snapshot.data.toString("utf8"),
    encoding,
    bytes: snapshot.data.length,
    sha256: snapshot.sha256,
    stats: statsToJson(snapshot.stats),
  };
}

export function assertExpectedSha256(
  snapshot: RemoteFileSnapshot | undefined,
  expectedSha256: string | "absent" | undefined,
  requireExpectedSha256: boolean,
  remotePath: string,
): void {
  if (snapshot === undefined) {
    if (expectedSha256 !== undefined && expectedSha256 !== "absent") {
      throw new McpToolError("ssh_edit_expected_hash_mismatch", "Remote file is absent but expected a hash", {
        remotePath,
        expectedSha256,
      });
    }
    return;
  }

  if (expectedSha256 === undefined && requireExpectedSha256) {
    throw new McpToolError("ssh_edit_expected_hash_required", "expectedSha256 is required for existing files", {
      remotePath,
      currentSha256: snapshot.sha256,
    });
  }
  if (expectedSha256 === "absent") {
    throw new McpToolError("ssh_edit_expected_hash_mismatch", "Remote file exists but expected absent", {
      remotePath,
      currentSha256: snapshot.sha256,
    });
  }
  if (expectedSha256 !== undefined && expectedSha256 !== snapshot.sha256) {
    throw new McpToolError("ssh_edit_expected_hash_mismatch", "Remote file changed since it was read", {
      remotePath,
      expectedSha256,
      currentSha256: snapshot.sha256,
    });
  }
}

export async function writeRemoteFileAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  data: Buffer,
  mode: number | undefined,
  createDirs: boolean,
): Promise<void> {
  if (createDirs) {
    await sftpMkdirRecursive(sftp, dirnameRemote(remotePath));
  }

  const tempPath = `${remotePath}.mcp-edit-${Date.now()}-${randomUUID()}.tmp`;
  try {
    await sftpWriteFile(sftp, tempPath, data, mode, "wx");
    await sftpRename(sftp, tempPath, remotePath);
  } catch (error) {
    await sftpUnlink(sftp, tempPath).catch(() => undefined);
    throw error;
  }
}

export async function createRemoteBackup(
  sftp: SFTPWrapper,
  profile: EditableProfile,
  rootPath: string,
  snapshot: RemoteFileSnapshot,
): Promise<BackupRecord> {
  const editId = randomUUID();
  const backupRootCandidate =
    profile.backupDir === undefined
      ? dirnameRemote(snapshot.remotePath)
      : toAbsoluteRemotePath(rootPath, profile.backupDir);
  assertPathInsideRoot(rootPath, backupRootCandidate, profile.backupDir ?? dirnameRemote(snapshot.remotePath));
  await sftpMkdirRecursive(sftp, backupRootCandidate);
  const backupRoot = await sftpRealpathSafe(sftp, backupRootCandidate);
  assertPathInsideRoot(rootPath, backupRoot, profile.backupDir ?? dirnameRemote(snapshot.remotePath));
  const backupPath = joinRemotePath(backupRoot, `.mcp-edit-backup-${Date.now()}-${editId}`);
  await sftpWriteFile(sftp, backupPath, snapshot.data, snapshot.stats.mode & 0o777, "wx");
  return {
    editId,
    originalPath: snapshot.remotePath,
    backupPath,
    sha256: snapshot.sha256,
    bytes: snapshot.data.length,
    createdAt: new Date().toISOString(),
  };
}

export async function readRemoteTree(
  sftp: SFTPWrapper,
  rootPath: string,
  options: RemoteTreeOptions,
): Promise<{ rootPath: string; entries: RemoteTreeEntry[]; truncated: boolean; entryCount: number }> {
  let entryCount = 0;
  let truncated = false;

  const walk = async (currentPath: string, depth: number): Promise<RemoteTreeEntry[]> => {
    if (depth > options.maxDepth || truncated) {
      return [];
    }

    const entries = await sftpReadDir(sftp, currentPath);
    const output: RemoteTreeEntry[] = [];
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") {
        continue;
      }
      if (!options.includeHidden && entry.filename.startsWith(".")) {
        continue;
      }
      if (shouldIgnoreName(entry.filename, options.ignoreNames)) {
        continue;
      }
      if (entryCount >= options.maxEntries) {
        truncated = true;
        break;
      }

      const childPath = joinRemotePath(currentPath, entry.filename);
      const stats = statsToJson(entry.attrs);
      entryCount += 1;
      const treeEntry: RemoteTreeEntry = {
        path: childPath,
        type: stats.type,
        size: stats.size,
        permissionsOctal: stats.permissionsOctal,
        mtime: stats.mtime,
      };
      if (entry.attrs.isDirectory() && depth < options.maxDepth) {
        treeEntry.children = await walk(childPath, depth + 1);
      }
      output.push(treeEntry);
    }
    return output.sort((left, right) => `${left.type}:${left.path}`.localeCompare(`${right.type}:${right.path}`));
  };

  return {
    rootPath,
    entries: await walk(rootPath, 1),
    truncated,
    entryCount,
  };
}

export function parseUnifiedPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFile[] = [];
  let index = 0;
  let currentFile: PatchFile | undefined;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("--- ")) {
      const oldPath = parsePatchPath(line.slice(4));
      const nextLine = lines[index + 1];
      if (nextLine === undefined || !nextLine.startsWith("+++ ")) {
        throw new McpToolError("invalid_unified_patch", "Unified patch file header is missing +++ line", { line });
      }
      currentFile = {
        oldPath,
        newPath: parsePatchPath(nextLine.slice(4)),
        hunks: [],
        isNewFile: oldPath === "/dev/null",
        isDeletedFile: parsePatchPath(nextLine.slice(4)) === "/dev/null",
      };
      files.push(currentFile);
      index += 2;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (currentFile === undefined) {
        throw new McpToolError("invalid_unified_patch", "Unified patch hunk appeared before file header", { line });
      }
      const hunk = parseHunkHeader(line);
      index += 1;
      while (index < lines.length) {
        const hunkLine = lines[index] ?? "";
        if (hunkLine.startsWith("--- ") || hunkLine.startsWith("@@ ")) {
          break;
        }
        if (hunkLine.startsWith("\\ No newline")) {
          index += 1;
          continue;
        }
        const marker = hunkLine[0];
        const text = hunkLine.slice(1);
        if (marker === " ") {
          hunk.lines.push({ kind: "context", text });
        } else if (marker === "-") {
          hunk.lines.push({ kind: "remove", text });
        } else if (marker === "+") {
          hunk.lines.push({ kind: "add", text });
        } else if (hunkLine.length > 0) {
          throw new McpToolError("invalid_unified_patch", "Invalid unified patch hunk line", { line: hunkLine });
        }
        index += 1;
      }
      currentFile.hunks.push(hunk);
      continue;
    }

    index += 1;
  }

  if (files.length === 0) {
    throw new McpToolError("invalid_unified_patch", "Unified patch did not contain any files");
  }
  return files;
}

export function applyUnifiedPatch(original: string, patchFile: PatchFile): string {
  if (patchFile.isDeletedFile) {
    throw new McpToolError("unsupported_unified_patch", "File deletion patches are not applied by patch tools", {
      oldPath: patchFile.oldPath,
    });
  }

  const split = splitText(original);
  const output: string[] = [];
  let pointer = 0;

  for (const hunk of patchFile.hunks) {
    const targetIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (targetIndex < pointer || targetIndex > split.lines.length) {
      throw new McpToolError("unified_patch_context_mismatch", "Unified patch hunk location does not match file", {
        oldStart: hunk.oldStart,
      });
    }
    output.push(...split.lines.slice(pointer, targetIndex));
    pointer = targetIndex;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }

      const actual = split.lines[pointer];
      if (actual !== line.text) {
        throw new McpToolError("unified_patch_context_mismatch", "Unified patch context does not match file", {
          expected: line.text,
          actual,
        });
      }
      if (line.kind === "context") {
        output.push(actual);
      }
      pointer += 1;
    }
  }

  output.push(...split.lines.slice(pointer));
  return joinText(output, split.trailingNewline);
}

export function patchTargetPath(patchFile: PatchFile): string {
  if (patchFile.isDeletedFile) {
    return stripPatchPathPrefix(patchFile.oldPath);
  }
  return stripPatchPathPrefix(patchFile.newPath);
}

export function maxEditFileBytes(profile: EditableProfile, fallback: number): number {
  return profile.maxEditFileBytes ?? fallback;
}

export function defaultTreeOptions(input: Partial<RemoteTreeOptions>): RemoteTreeOptions {
  return {
    maxDepth: input.maxDepth ?? 4,
    maxEntries: input.maxEntries ?? 500,
    includeHidden: input.includeHidden ?? false,
    ignoreNames: input.ignoreNames ?? [...DEFAULT_IGNORE_NAMES],
  };
}

async function readRemoteFileBuffer(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (error: Error) => {
      reject(new McpToolError("sftp_readFile_failed", error.message, { action: "readFile", remotePath }));
    });
  });
}

function parseHunkHeader(line: string): PatchHunk {
  const match = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/.exec(line);
  if (match?.groups === undefined) {
    throw new McpToolError("invalid_unified_patch", "Invalid unified patch hunk header", { line });
  }
  return {
    oldStart: Number.parseInt(match.groups.oldStart ?? "0", 10),
    oldCount: Number.parseInt(match.groups.oldCount ?? "1", 10),
    newStart: Number.parseInt(match.groups.newStart ?? "0", 10),
    newCount: Number.parseInt(match.groups.newCount ?? "1", 10),
    lines: [],
  };
}

function parsePatchPath(rawPath: string): string {
  const [path] = rawPath.trim().split(/\s+/);
  if (path === undefined || path.length === 0) {
    throw new McpToolError("invalid_unified_patch", "Unified patch path is empty", { rawPath });
  }
  return path;
}

function stripPatchPathPrefix(patchPath: string): string {
  if (patchPath === "/dev/null") {
    return patchPath;
  }
  if (/^[ab]\//.test(patchPath)) {
    return patchPath.slice(2);
  }
  return patchPath;
}

function splitText(text: string): SplitText {
  const normalized = text.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body.length === 0 ? [] : body.split("\n"),
    trailingNewline,
  };
}

function joinText(lines: string[], trailingNewline: boolean): string {
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function toAbsoluteRemotePath(rootPath: string, filePath: string): string {
  const normalizedFilePath = normalizeRemotePath(filePath);
  if (normalizedFilePath.startsWith("/")) {
    return normalizedFilePath;
  }
  return normalizeRemotePath(joinRemotePath(rootPath, normalizedFilePath));
}

function assertPathInsideRoot(rootPath: string, remotePath: string, requestedPath: string): void {
  const normalizedRoot = normalizeRemotePath(rootPath);
  const normalizedPath = normalizeRemotePath(remotePath);
  if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return;
  }
  throw new McpToolError("ssh_edit_path_outside_root", "Remote path is outside the project root", {
    requestedPath,
    rootPath: normalizedRoot,
    remotePath: normalizedPath,
  });
}

function shouldIgnoreName(name: string, ignoreNames: string[]): boolean {
  return DEFAULT_IGNORE_NAMES.has(name) || ignoreNames.includes(name);
}

function sftpRealpathSafe(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error: Error | null | undefined, absolutePath: string) => {
      if (error != null) {
        reject(new McpToolError("sftp_realpath_failed", error.message, { action: "realpath", remotePath }));
        return;
      }
      resolve(normalizeRemotePath(absolutePath));
    });
  });
}

function isMissingPathLike(error: Error): boolean {
  if (error instanceof McpToolError) {
    return /no such file|not found|failure/i.test(error.message);
  }
  return /no such file|not found/i.test(error.message);
}
