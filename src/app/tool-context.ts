import { randomUUID } from "node:crypto";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PseudoTtyOptions } from "ssh2";

import { defaultEnvPath, ProfileRegistry, type SshServerProfile } from "../env-profiles.js";
import { reloadEnvSnapshot } from "../env-reload.js";
import { RuntimeConfigRegistry } from "../runtime-config.js";
import { SessionRegistry } from "../session-registry.js";
import type { ExecResult, SessionSummary, SshSession } from "../ssh-session.js";
import {
  entryToJson,
  sftpChmod,
  sftpChown,
  sftpMkdir,
  sftpMkdirRecursive,
  sftpReadFileLimited,
  sftpReadDir,
  sftpReadlink,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  sftpStat,
  sftpSymlink,
  sftpUnlink,
  sftpUtimes,
  sftpWriteFile,
  statsToJson,
} from "../sftp-ops.js";
import { TransferManager } from "../transfer-manager.js";
import { assertNonEmpty, McpToolError, setCompactJsonResponse, toToolResult } from "../tool-result.js";
import {
  applyUnifiedPatch,
  assertExpectedSha256,
  createRemoteBackup,
  defaultTreeOptions,
  ensureProfileAllowsEdit,
  maxEditFileBytes,
  parseUnifiedPatch,
  patchTargetPath,
  publicSnapshot,
  readRemoteFileSnapshot,
  readRemoteTree,
  resolveProjectRoot,
  resolveSafeRemotePath,
  sha256,
  writeRemoteFileAtomic,
  type BackupRecord,
  type RemoteFileSnapshot,
} from "../remote-edit.js";

import { AGENT_TOOL_NAMES, DANGEROUS_TOOL_NAMES, resolveToolAnnotations } from "../tools/tool-metadata.js";

const SERVER_INSTRUCTIONS = [
  "This server provides SSH/SFTP tools for configured remote hosts.",
  "For a new host that is not saved as a Profile, use ssh_connect for a temporary direct connection; host may be a hostname/IP with a separate username, or username@hostname.",
  "A host and port identify the destination but do not by themselves authenticate the user; use the authentication mechanism required by the server.",
  "For InstaBox SSH tokens, the ibssh_… token is the SSH username itself; it needs no password or private key. Treat this username as a bearer secret; responses redact it and it should not be saved in a shared .env file.",
  "The current ssh2 persistent-session backend cannot negotiate InstaBox's OpenSSH host-certificate algorithm. ssh_probe_host_key can inspect the certificate without authentication; ssh_connect refuses this target before sending the token. For a one-shot command, use ssh_run_openssh_temporary only after a host-specific CA fingerprint has been independently verified and pinned in the local MCP process environment variable SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS. Tool arguments cannot create or override this trust anchor. Call ssh_trust_host_ca only when the CA key matches that local pin and the user wants permanent known_hosts trust; prefer usernameEnvVar to avoid passing a token in tool arguments. Persistent Shell/SFTP/tunnel support for this certificate backend remains future work.",
  "InstaBox's SSH gateway does not support agent forwarding or remote forwarding. Never silently trust an unknown host key or CA fingerprint.",
  "For quick remote inspection or health checks, prefer ssh_check_profile.",
  "For one-shot commands on a configured profile, prefer ssh_run_profile instead of ssh_connect_profile + ssh_exec.",
  "Use ssh_connect_profile plus session tools only when the user explicitly needs a persistent session, shell, SFTP workflow, transfer job, or tunnel.",
  "Do not use local shell commands to simulate remote SSH checks when an SSH profile tool can do the work.",
  "Dangerous tools such as tunnels, rm, chmod, chown, and disconnect_all are hidden unless explicitly enabled by runtime config.",
].join(" ");

const server = new McpServer(
  {
    name: "enterprise-ssh-mcp-server",
    version: "0.3.1",
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

const envPath = defaultEnvPath();
const profiles = new ProfileRegistry(envPath);
const runtimeConfig = new RuntimeConfigRegistry(envPath);
setCompactJsonResponse(runtimeConfig.get().compactJson);
const startupToolExposure = {
  toolset: runtimeConfig.get().toolset,
  enableDangerousTools: runtimeConfig.get().enableDangerousTools,
};
const reloadEnvState = () => reloadEnvSnapshot({
  envPath,
  runtimeConfig,
  profiles,
  startupToolExposure,
  setCompactJsonResponse,
});
const sessions = new SessionRegistry();
const transfers = new TransferManager();
const editHistory = new Map<string, EditRecord>();

const sessionIdSchema = z.string().min(1);
const wireEncodingSchema = z.enum(["utf8", "base64"]).default("utf8");
const positivePortSchema = z.number().int().min(0).max(65_535);
const modeSchema = z.union([z.number().int().min(0).max(0o7777), z.string().regex(/^[0-7]{3,4}$/)]);
const ptySchema = z.object({
  rows: z.number().int().min(1).optional(),
  cols: z.number().int().min(1).optional(),
  height: z.number().int().min(0).optional(),
  width: z.number().int().min(0).optional(),
  term: z.string().min(1).optional(),
});

const projectRootSchema = z.string().min(1).optional();
const fileEncodingSchema = z.enum(["utf8", "base64"]).default("utf8");
const expectedShaSchema = z.union([z.string().length(64), z.literal("absent")]);
const expectedFileSchema = z.object({
  path: z.string().min(1),
  sha256: expectedShaSchema,
});
const projectPathSchema = z.string().min(1);

type ToolConfig<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};









const REMOTE_CHECK_NAMES = ["identity", "pwd", "os", "uptime", "disk", "memory", "processes"] as const;
const remoteCheckNameSchema = z.enum(REMOTE_CHECK_NAMES);
type RemoteCheckName = z.infer<typeof remoteCheckNameSchema>;

const DEFAULT_REMOTE_CHECKS: RemoteCheckName[] = ["identity", "pwd", "os", "uptime", "disk", "memory"];

const REMOTE_CHECK_COMMANDS: Record<RemoteCheckName, { title: string; command: string }> = {
  identity: {
    title: "User and host identity",
    command: "printf 'whoami: '; whoami; printf 'hostname: '; hostname; id",
  },
  pwd: {
    title: "Current directory",
    command: "pwd",
  },
  os: {
    title: "Operating system",
    command: "uname -a || ver",
  },
  uptime: {
    title: "Uptime",
    command: "uptime || wmic os get lastbootuptime",
  },
  disk: {
    title: "Disk usage",
    command: "df -h . || wmic logicaldisk get caption,freespace,size",
  },
  memory: {
    title: "Memory usage",
    command: "free -h || vm_stat || wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value",
  },
  processes: {
    title: "Top processes",
    command: "ps aux | head -n 15 || tasklist",
  },
};

function registerTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  name: string,
  config: ToolConfig<OutputArgs, InputArgs>,
  cb: ToolCallback<InputArgs>,
): RegisteredTool | undefined {
  const activeConfig = runtimeConfig.get();
  if (activeConfig.toolset === "agent" && !AGENT_TOOL_NAMES.has(name)) {
    return undefined;
  }
  if (!activeConfig.enableDangerousTools && DANGEROUS_TOOL_NAMES.has(name)) {
    return undefined;
  }

  return server.registerTool(name, { ...config, annotations: resolveToolAnnotations(name, config.annotations) }, cb);
}































































































































type ExpectedFile = z.infer<typeof expectedFileSchema>;

interface ProjectWorkspace {
  profile: SshServerProfile;
  sessionId: string;
  session: SshSession;
  sftp: Awaited<ReturnType<SshSession["getSftp"]>>;
  rootPath: string;
}

type EditOperation = "create" | "modify" | "delete" | "move";

interface EditFileChange {
  path: string;
  remotePath: string;
  operation: EditOperation;
  oldSha256?: string | undefined;
  newSha256?: string | undefined;
  bytes?: number | undefined;
  backup?: BackupRecord | undefined;
  movedToPath?: string | undefined;
  movedToRemotePath?: string | undefined;
}

interface EditRecord {
  editId: string;
  profileName: string;
  projectRoot: string;
  createdAt: string;
  rolledBackAt?: string;
  changes: EditFileChange[];
}

async function connectProjectWorkspace(
  profileName: string,
  projectRoot: string | undefined,
  requireEdit: boolean,
): Promise<ProjectWorkspace> {
  const profile = profiles.get(profileName);
  if (requireEdit) {
    ensureProfileAllowsEdit(profile);
  }

  const connected = await connectProfileSession({
    profileName,
    keyboardResponses: [],
    strictVendor: true,
    debug: false,
  });
  const session = sessions.get(connected.session.id);
  const sftp = await session.getSftp();

  try {
    return {
      profile,
      sessionId: connected.session.id,
      session,
      sftp,
      rootPath: await resolveProjectRoot(sftp, profile, projectRoot),
    };
  } catch (error) {
    await sessions.disconnect(connected.session.id);
    throw error;
  }
}

async function inspectRemoteProject(session: SshSession, rootPath: string): Promise<object> {
  const config = runtimeConfig.get();
  const result = await session.exec({
    command: buildProjectOpenCommand(rootPath),
    stdinEncoding: "utf8",
    outputEncoding: "utf8",
    timeoutMs: config.defaultExecTimeoutMs,
    maxOutputBytes: config.defaultMaxOutputBytes,
  });
  return {
    rootPath,
    result,
  };
}

function projectProfileSummary(profile: SshServerProfile): object {
  return {
    name: profile.name,
    aliases: profile.aliases,
    defaultDir: profile.defaultDir,
    edit: {
      allowEdit: profile.allowEdit ?? false,
      editRoot: profile.editRoot ?? profile.defaultDir,
      maxEditFileBytes: maxEditFileBytes(profile, runtimeConfig.get().defaultMaxEditFileBytes),
      backupBeforeEdit: profile.backupBeforeEdit ?? true,
      backupDir: profile.backupDir,
      allowDelete: profile.allowDelete ?? false,
      allowBinaryEdit: profile.allowBinaryEdit ?? false,
    },
  };
}

async function writeProjectFile(
  workspace: ProjectWorkspace,
  path: string,
  data: Buffer,
  expectedSha256: string | "absent" | undefined,
  createDirs: boolean,
  mode: number | undefined,
): Promise<EditRecord> {
  const change = await writeProjectFileChange(workspace, path, data, expectedSha256, createDirs, mode);
  return recordEdit(workspace, [change]);
}

async function applySinglePatchFile(
  workspace: ProjectWorkspace,
  path: string,
  patchFile: ReturnType<typeof parseUnifiedPatch>[number],
  expectedSha256: string | "absent",
  createDirs: boolean,
): Promise<EditRecord> {
  const patchPath = patchTargetPath(patchFile);
  if (patchPath !== path && patchPath !== "/dev/null") {
    throw new McpToolError("ssh_patch_path_mismatch", "Unified patch target does not match requested path", {
      path,
      patchPath,
    });
  }

  const currentText = expectedSha256 === "absent" ? "" : await readProjectTextForPatch(workspace, path);
  const nextText = applyUnifiedPatch(currentText, patchFile);
  const change = await writeProjectFileChange(
    workspace,
    path,
    Buffer.from(nextText, "utf8"),
    expectedSha256,
    createDirs,
    undefined,
  );
  return recordEdit(workspace, [change]);
}

async function validateProjectPatch(
  workspace: ProjectWorkspace,
  patchFiles: ReturnType<typeof parseUnifiedPatch>,
  expectedFiles: ExpectedFile[],
): Promise<object> {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.sha256]));
  const changedFiles = [];
  const conflicts = [];

  for (const patchFile of patchFiles) {
    const path = patchTargetPath(patchFile);
    try {
      const expectedSha256 = expectedByPath.get(path);
      const currentText = expectedSha256 === "absent" || patchFile.isNewFile ? "" : await readProjectTextForPatch(workspace, path);
      if (expectedSha256 !== undefined && expectedSha256 !== "absent") {
        const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, path, true);
        const snapshot = await readRemoteFileSnapshot(
          workspace.sftp,
          safePath.remotePath,
          maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
        );
        assertExpectedSha256(snapshot, expectedSha256, false, safePath.remotePath);
      }
      const nextText = applyUnifiedPatch(currentText, patchFile);
      changedFiles.push({
        path,
        oldBytes: Buffer.byteLength(currentText, "utf8"),
        newBytes: Buffer.byteLength(nextText, "utf8"),
        newSha256: sha256(Buffer.from(nextText, "utf8")),
      });
    } catch (error) {
      conflicts.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    applicable: conflicts.length === 0,
    changedFiles,
    conflicts,
  };
}

async function applyProjectPatch(
  workspace: ProjectWorkspace,
  patchFiles: ReturnType<typeof parseUnifiedPatch>,
  expectedFiles: ExpectedFile[],
  createDirs: boolean,
): Promise<EditRecord> {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.sha256]));
  const changes: EditFileChange[] = [];

  try {
    for (const patchFile of patchFiles) {
      const path = patchTargetPath(patchFile);
      const expectedSha256 = expectedByPath.get(path);
      if (expectedSha256 === undefined) {
        throw new McpToolError("ssh_patch_expected_file_missing", "Patch file is missing expectedFiles entry", { path });
      }
      const currentText = expectedSha256 === "absent" || patchFile.isNewFile ? "" : await readProjectTextForPatch(workspace, path);
      const nextText = applyUnifiedPatch(currentText, patchFile);
      changes.push(
        await writeProjectFileChange(
          workspace,
          path,
          Buffer.from(nextText, "utf8"),
          expectedSha256,
          createDirs,
          undefined,
        ),
      );
    }
  } catch (error) {
    await rollbackChangesBestEffort(workspace, changes);
    throw error;
  }

  return recordEdit(workspace, changes);
}

async function writeProjectFileChange(
  workspace: ProjectWorkspace,
  path: string,
  data: Buffer,
  expectedSha256: string | "absent" | undefined,
  createDirs: boolean,
  mode: number | undefined,
): Promise<EditFileChange> {
  const maxBytes = maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes);
  if (data.length > maxBytes) {
    throw new McpToolError("ssh_edit_file_too_large", "New file content exceeds max edit size", {
      path,
      bytes: data.length,
      maxBytes,
    });
  }
  if ((workspace.profile.allowBinaryEdit ?? false) !== true && data.includes(0)) {
    throw new McpToolError("ssh_binary_edit_disabled", "Binary file editing is disabled for this profile", { path });
  }

  const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, path, false);
  const previous = await readOptionalSnapshot(workspace, safePath.remotePath);
  assertExpectedSha256(previous, expectedSha256, true, safePath.remotePath);
  const backup =
    previous !== undefined && (workspace.profile.backupBeforeEdit ?? true)
      ? await createRemoteBackup(workspace.sftp, workspace.profile, workspace.rootPath, previous)
      : undefined;
  await writeRemoteFileAtomic(
    workspace.sftp,
    safePath.remotePath,
    data,
    mode ?? (previous === undefined ? undefined : previous.stats.mode & 0o777),
    createDirs,
  );
  const next = await readRemoteFileSnapshot(workspace.sftp, safePath.remotePath, maxBytes);
  return compactChange({
    path,
    remotePath: safePath.remotePath,
    operation: previous === undefined ? "create" : "modify",
    oldSha256: previous?.sha256,
    newSha256: next.sha256,
    bytes: next.data.length,
    backup,
  });
}

async function deleteProjectFile(workspace: ProjectWorkspace, path: string, expectedSha256: string): Promise<EditRecord> {
  if ((workspace.profile.allowDelete ?? false) !== true) {
    throw new McpToolError("ssh_profile_delete_disabled", "SSH profile deletion is disabled", {
      profileName: workspace.profile.name,
      requiredEnv: `SSH_MCP_SERVER_<N>_ALLOW_DELETE=true`,
    });
  }
  const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, path, true);
  const previous = await readRemoteFileSnapshot(
    workspace.sftp,
    safePath.remotePath,
    maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
  );
  assertExpectedSha256(previous, expectedSha256, true, safePath.remotePath);
  const backup = await createRemoteBackup(workspace.sftp, workspace.profile, workspace.rootPath, previous);
  await sftpUnlink(workspace.sftp, safePath.remotePath);
  return recordEdit(workspace, [
    compactChange({
      path,
      remotePath: safePath.remotePath,
      operation: "delete",
      oldSha256: previous.sha256,
      backup,
    }),
  ]);
}

async function moveProjectFile(
  workspace: ProjectWorkspace,
  fromPath: string,
  toPath: string,
  expectedSha256: string,
  createDirs: boolean,
): Promise<EditRecord> {
  const from = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, fromPath, true);
  const to = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, toPath, false);
  const previous = await readRemoteFileSnapshot(
    workspace.sftp,
    from.remotePath,
    maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
  );
  assertExpectedSha256(previous, expectedSha256, true, from.remotePath);
  if (createDirs) {
    await sftpMkdirRecursive(workspace.sftp, dirnameFromRemotePath(to.remotePath));
  }
  if (await remotePathExists(workspace, to.remotePath)) {
    throw new McpToolError("ssh_move_target_exists", "Move target already exists", { toPath, remotePath: to.remotePath });
  }
  const backup = await createRemoteBackup(workspace.sftp, workspace.profile, workspace.rootPath, previous);
  await sftpRename(workspace.sftp, from.remotePath, to.remotePath);
  return recordEdit(workspace, [
    compactChange({
      path: fromPath,
      remotePath: from.remotePath,
      operation: "move",
      oldSha256: previous.sha256,
      newSha256: previous.sha256,
      bytes: previous.data.length,
      backup,
      movedToPath: toPath,
      movedToRemotePath: to.remotePath,
    }),
  ]);
}

async function rollbackEdit(workspace: ProjectWorkspace, edit: EditRecord): Promise<EditRecord> {
  if (edit.profileName !== workspace.profile.name) {
    throw new McpToolError("ssh_edit_profile_mismatch", "Edit record belongs to a different profile", {
      editId: edit.editId,
      expectedProfile: edit.profileName,
      actualProfile: workspace.profile.name,
    });
  }
  if (edit.rolledBackAt !== undefined) {
    throw new McpToolError("ssh_edit_already_rolled_back", "Edit has already been rolled back", {
      editId: edit.editId,
      rolledBackAt: edit.rolledBackAt,
    });
  }

  const rollbackChanges: EditFileChange[] = [];
  for (const change of [...edit.changes].reverse()) {
    if (change.operation === "create") {
      const current = await readOptionalSnapshot(workspace, change.remotePath);
      if (current !== undefined) {
        assertExpectedSha256(current, change.newSha256, false, change.remotePath);
        await sftpUnlink(workspace.sftp, change.remotePath);
      }
      rollbackChanges.push({ ...change, operation: "delete", oldSha256: change.newSha256, newSha256: undefined });
      continue;
    }

    if (change.operation === "move" && change.movedToRemotePath !== undefined) {
      const moved = await readOptionalSnapshot(workspace, change.movedToRemotePath);
      if (moved !== undefined) {
        assertExpectedSha256(moved, change.newSha256, false, change.movedToRemotePath);
        await sftpUnlink(workspace.sftp, change.movedToRemotePath);
      }
    }

    if (change.backup === undefined) {
      throw new McpToolError("ssh_edit_backup_missing", "Edit record has no backup for rollback", {
        editId: edit.editId,
        path: change.path,
      });
    }
    const backup = await readRemoteFileSnapshot(
      workspace.sftp,
      change.backup.backupPath,
      maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
    );
    await writeRemoteFileAtomic(workspace.sftp, change.remotePath, backup.data, undefined, true);
    rollbackChanges.push({
      path: change.path,
      remotePath: change.remotePath,
      operation: "modify",
      oldSha256: change.newSha256,
      newSha256: backup.sha256,
      bytes: backup.data.length,
    });
  }
  edit.rolledBackAt = new Date().toISOString();
  return recordEdit(workspace, rollbackChanges);
}

async function readProjectTextForPatch(workspace: ProjectWorkspace, path: string): Promise<string> {
  const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, path, true);
  const snapshot = await readRemoteFileSnapshot(
    workspace.sftp,
    safePath.remotePath,
    maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
  );
  if ((workspace.profile.allowBinaryEdit ?? false) !== true && snapshot.data.includes(0)) {
    throw new McpToolError("ssh_binary_edit_disabled", "Binary file editing is disabled for this profile", { path });
  }
  return snapshot.data.toString("utf8");
}

async function readOptionalSnapshot(workspace: ProjectWorkspace, remotePath: string): Promise<RemoteFileSnapshot | undefined> {
  try {
    return await readRemoteFileSnapshot(
      workspace.sftp,
      remotePath,
      maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
    );
  } catch (error) {
    if (error instanceof McpToolError && /no such file|not found|failure/i.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

async function remotePathExists(workspace: ProjectWorkspace, remotePath: string): Promise<boolean> {
  try {
    await sftpStat(workspace.sftp, remotePath, false);
    return true;
  } catch (error) {
    if (error instanceof McpToolError && /no such file|not found|failure/i.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function resolveProjectPathArgs(
  workspace: ProjectWorkspace,
  paths: string[],
  mustExist: boolean,
): Promise<string[]> {
  const resolvedPaths: string[] = [];
  for (const path of paths) {
    const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, path, mustExist);
    resolvedPaths.push(relativeRemotePath(workspace.rootPath, safePath.remotePath));
  }
  return resolvedPaths;
}

async function rollbackChangesBestEffort(workspace: ProjectWorkspace, changes: EditFileChange[]): Promise<void> {
  for (const change of [...changes].reverse()) {
    try {
      if (change.operation === "create") {
        await sftpUnlink(workspace.sftp, change.remotePath);
      } else if (change.backup !== undefined) {
        const backup = await readRemoteFileSnapshot(
          workspace.sftp,
          change.backup.backupPath,
          maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
        );
        await writeRemoteFileAtomic(workspace.sftp, change.remotePath, backup.data, undefined, true);
      }
    } catch {
      // Best-effort rollback keeps the original apply error as the actionable failure.
    }
  }
}

function recordEdit(workspace: ProjectWorkspace, changes: EditFileChange[]): EditRecord {
  const record: EditRecord = {
    editId: randomUUID(),
    profileName: workspace.profile.name,
    projectRoot: workspace.rootPath,
    createdAt: new Date().toISOString(),
    changes,
  };
  editHistory.set(record.editId, record);
  return record;
}

function compactChange(change: EditFileChange): EditFileChange {
  return Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as EditFileChange;
}

function assertPatchSize(patch: string): void {
  const bytes = Buffer.byteLength(patch, "utf8");
  const maxBytes = runtimeConfig.get().defaultMaxPatchBytes;
  if (bytes > maxBytes) {
    throw new McpToolError("ssh_patch_too_large", "Unified patch exceeds max patch size", { bytes, maxBytes });
  }
}

function compactTreeOptions(
  maxDepth: number | undefined,
  maxEntries: number | undefined,
  includeHidden: boolean | undefined,
  ignoreNames: string[] | undefined,
): Parameters<typeof defaultTreeOptions>[0] {
  return {
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
    ...(includeHidden === undefined ? {} : { includeHidden }),
    ...(ignoreNames === undefined ? {} : { ignoreNames }),
  };
}

function buildProjectOpenCommand(rootPath: string): string {
  return buildRemoteCommand(
    [
      "printf 'pwd: '; pwd",
      "printf 'git_root: '; git rev-parse --show-toplevel 2>/dev/null || true",
      "printf 'git_branch: '; git branch --show-current 2>/dev/null || true",
      "printf 'node_package: '; test -f package.json && echo yes || echo no",
      "printf 'python_project: '; test -f pyproject.toml -o -f requirements.txt && echo yes || echo no",
      "printf 'go_project: '; test -f go.mod && echo yes || echo no",
      "printf 'rust_project: '; test -f Cargo.toml && echo yes || echo no",
    ].join("; "),
    rootPath,
  );
}

function buildProjectSearchCommand(
  rootPath: string,
  query: string,
  paths: string[],
  literal: boolean,
  maxResults: number,
  contextLines: number,
): string {
  const rgLiteral = literal ? "--fixed-strings" : "";
  const grepLiteral = literal ? "-F" : "-E";
  const quotedQuery = quotePosixShellArg(query);
  const quotedPaths = paths.length === 0 ? "." : paths.map(quotePosixShellArg).join(" ");
  return buildRemoteCommand(
    `if command -v rg >/dev/null 2>&1; then rg -n --color never ${rgLiteral} -C ${contextLines} -m ${maxResults} -- ${quotedQuery} ${quotedPaths}; else grep -RIn ${grepLiteral} -C ${contextLines} -- ${quotedQuery} ${quotedPaths} | head -n ${maxResults}; fi`,
    rootPath,
  );
}

function buildProjectDiffCommand(rootPath: string, paths: string[]): string {
  const quotedPaths = paths.length === 0 ? "" : ` -- ${paths.map(quotePosixShellArg).join(" ")}`;
  return buildRemoteCommand(
    `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '## status\\n'; git status --short${quotedPaths}; printf '\\n## diff\\n'; git diff --no-ext-diff --src-prefix=a/ --dst-prefix=b/${quotedPaths}; else echo 'not a git repository'; fi`,
    rootPath,
  );
}

function parseSearchMatches(output: string): Array<{ path: string; line?: number; text: string }> {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(?<path>.*?):(?<line>\d+):(?<text>.*)$/.exec(line);
      if (match?.groups === undefined) {
        return { path: "", text: line };
      }
      return {
        path: match.groups.path ?? "",
        line: Number.parseInt(match.groups.line ?? "0", 10),
        text: match.groups.text ?? "",
      };
    });
}

function dirnameFromRemotePath(remotePath: string): string {
  const parts = remotePath.split("/");
  parts.pop();
  const dirname = parts.join("/");
  return dirname.length === 0 ? "." : dirname;
}

function relativeRemotePath(rootPath: string, remotePath: string): string {
  if (remotePath === rootPath) {
    return ".";
  }
  if (remotePath.startsWith(`${rootPath}/`)) {
    return remotePath.slice(rootPath.length + 1);
  }
  return remotePath;
}

function normalizeProfileNameForHistory(profileName: string): string {
  return profileName.trim().replace(/[\s-]+/g, "_").toUpperCase();
}

interface ProfileConnectionInput {
  profileName: string;
  keyboardResponses: string[];
  strictVendor: boolean;
  debug: boolean;
  sessionName?: string | undefined;
  agentForward?: boolean | undefined;
  tryKeyboard?: boolean | undefined;
  keepaliveIntervalMs?: number | undefined;
  keepaliveCountMax?: number | undefined;
  readyTimeoutMs?: number | undefined;
  connectionTimeoutMs?: number | undefined;
  hostHash?: "md5" | "sha1" | "sha256" | undefined;
  expectedHostHash?: string | undefined;
}

interface ConnectedProfileSession {
  profile: {
    name: string;
    aliases: string[];
    host: string;
    port: number;
    username: string;
    displayName?: string;
    defaultDir?: string;
    description?: string;
    platform?: string;
  };
  session: SessionSummary;
}

async function connectProfileSession(input: ProfileConnectionInput): Promise<ConnectedProfileSession> {
  const profile = profiles.get(input.profileName);
  const config = runtimeConfig.get();
  const session = await sessions.connect({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    name: input.sessionName ?? profile.name,
    agentForward: input.agentForward ?? config.defaultAgentForward,
    tryKeyboard: input.tryKeyboard ?? config.defaultTryKeyboard,
    keyboardResponses: input.keyboardResponses,
    keepaliveIntervalMs: input.keepaliveIntervalMs ?? config.defaultKeepaliveIntervalMs,
    keepaliveCountMax: input.keepaliveCountMax ?? config.defaultKeepaliveCountMax,
    readyTimeoutMs: input.readyTimeoutMs ?? config.defaultReadyTimeoutMs,
    connectionTimeoutMs: input.connectionTimeoutMs ?? config.defaultConnectionTimeoutMs,
    strictVendor: input.strictVendor,
    debug: input.debug,
    ...(profile.password === undefined ? {} : { password: profile.password }),
    ...(profile.privateKey === undefined ? {} : { privateKey: profile.privateKey }),
    ...(profile.privateKeyPath === undefined ? {} : { privateKeyPath: profile.privateKeyPath }),
    ...(profile.passphrase === undefined ? {} : { passphrase: profile.passphrase }),
    ...(profile.agent === undefined ? {} : { agent: profile.agent }),
    ...(input.hostHash === undefined ? {} : { hostHash: input.hostHash }),
    ...(input.expectedHostHash === undefined ? {} : { expectedHostHash: input.expectedHostHash }),
  });

  return {
    profile: {
      name: profile.name,
      aliases: profile.aliases,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
      ...(profile.defaultDir === undefined ? {} : { defaultDir: profile.defaultDir }),
      ...(profile.description === undefined ? {} : { description: profile.description }),
      ...(profile.platform === undefined ? {} : { platform: profile.platform }),
    },
    session,
  };
}

function buildRemoteCommand(command: string, workingDirectory: string | undefined): string {
  if (workingDirectory === undefined) {
    return command;
  }

  return `cd ${quotePosixShellArg(workingDirectory)} && ${command}`;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface RemoteCheckInput {
  name: RemoteCheckName;
  title: string;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
  execute: (command: string) => Promise<ExecResult>;
}

async function runRemoteCheck(input: RemoteCheckInput): Promise<{
  name: RemoteCheckName;
  title: string;
  command: string;
  ok: boolean;
  result?: ExecResult;
  error?: string;
}> {
  try {
    const result = await input.execute(input.command);
    return {
      name: input.name,
      title: input.title,
      command: input.command,
      ok: result.exitCode === 0 && !result.timedOut,
      result,
    };
  } catch (error) {
    return {
      name: input.name,
      title: input.title,
      command: input.command,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compactExecPty(input: boolean | z.infer<typeof ptySchema> | undefined): PseudoTtyOptions | boolean | undefined {
  if (typeof input === "boolean" || input === undefined) {
    return input;
  }

  return compactPty(input);
}

function compactPty(input: z.infer<typeof ptySchema> | undefined): PseudoTtyOptions | undefined {
  if (input === undefined) {
    return undefined;
  }

  const pty: PseudoTtyOptions = {};
  if (input.rows !== undefined) {
    pty.rows = input.rows;
  }
  if (input.cols !== undefined) {
    pty.cols = input.cols;
  }
  if (input.height !== undefined) {
    pty.height = input.height;
  }
  if (input.width !== undefined) {
    pty.width = input.width;
  }
  if (input.term !== undefined) {
    pty.term = input.term;
  }
  return pty;
}



export const toolContext = {
  server,
  envPath,
  sessions,
  z,
  setCompactJsonResponse,
  toToolResult,
  profiles,
  runtimeConfig,
  reloadEnvState,
  wireEncodingSchema,
  remoteCheckNameSchema,
  DEFAULT_REMOTE_CHECKS,
  REMOTE_CHECK_COMMANDS,
  registerTool,
  connectProfileSession,
  buildRemoteCommand,
  runRemoteCheck,
  sftpStat,
  statsToJson,
  McpToolError,
  defaultTreeOptions,
  maxEditFileBytes,
  parseUnifiedPatch,
  publicSnapshot,
  readRemoteFileSnapshot,
  readRemoteTree,
  resolveSafeRemotePath,
  sha256,
  editHistory,
  projectRootSchema,
  fileEncodingSchema,
  expectedShaSchema,
  expectedFileSchema,
  projectPathSchema,
  connectProjectWorkspace,
  inspectRemoteProject,
  projectProfileSummary,
  writeProjectFile,
  applySinglePatchFile,
  validateProjectPatch,
  applyProjectPatch,
  deleteProjectFile,
  moveProjectFile,
  rollbackEdit,
  resolveProjectPathArgs,
  assertPatchSize,
  compactTreeOptions,
  buildProjectSearchCommand,
  buildProjectDiffCommand,
  parseSearchMatches,
  normalizeProfileNameForHistory,
  sessionIdSchema,
  ptySchema,
  compactExecPty,
  compactPty,
  entryToJson,
  sftpChmod,
  sftpChown,
  sftpMkdir,
  sftpMkdirRecursive,
  sftpReadFileLimited,
  sftpReadDir,
  sftpReadlink,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  sftpSymlink,
  sftpUtimes,
  sftpWriteFile,
  modeSchema,
  assertNonEmpty,
  transfers,
  positivePortSchema
};

export type ToolContext = typeof toolContext;
