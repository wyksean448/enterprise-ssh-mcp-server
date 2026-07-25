#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PseudoTtyOptions } from "ssh2";

import { defaultEnvPath, ProfileRegistry, type SshServerProfile } from "./env-profiles.js";
import { RuntimeConfigRegistry } from "./runtime-config.js";
import { SessionRegistry } from "./session-registry.js";
import type { ExecResult, SessionSummary, SshSession } from "./ssh-session.js";
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
} from "./sftp-ops.js";
import { TransferManager } from "./transfer-manager.js";
import { assertNonEmpty, McpToolError, setCompactJsonResponse, toToolResult } from "./tool-result.js";
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
} from "./remote-edit.js";

const SERVER_INSTRUCTIONS = [
  "This server provides SSH/SFTP tools for configured remote hosts.",
  "For quick remote inspection or health checks, prefer ssh_check_profile.",
  "For one-shot commands on a configured profile, prefer ssh_run_profile instead of ssh_connect_profile + ssh_exec.",
  "Use ssh_connect_profile plus session tools only when the user explicitly needs a persistent session, shell, SFTP workflow, transfer job, or tunnel.",
  "Do not use local shell commands to simulate remote SSH checks when an SSH profile tool can do the work.",
  "Dangerous tools such as tunnels, rm, chmod, chown, and disconnect_all are hidden unless explicitly enabled by runtime config.",
].join(" ");

const server = new McpServer(
  {
    name: "enterprise-ssh-mcp-server",
    version: "0.3.0",
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

const envPath = defaultEnvPath();
const profiles = new ProfileRegistry(envPath);
const runtimeConfig = new RuntimeConfigRegistry(envPath);
setCompactJsonResponse(runtimeConfig.get().compactJson);
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

const AGENT_TOOL_NAMES = new Set([
  "ssh_get_config",
  "ssh_reload_config",
  "ssh_list_profiles",
  "ssh_reload_profiles",
  "ssh_connect_profile",
  "ssh_check_profile",
  "ssh_run_profile",
  "ssh_project_open",
  "ssh_project_tree",
  "ssh_project_search",
  "ssh_project_diff",
  "ssh_project_run_checks",
  "ssh_project_validate_patch",
  "ssh_project_apply_patch",
  "ssh_project_stat",
  "ssh_file_read",
  "ssh_file_patch",
  "ssh_edit_history",
  "ssh_edit_rollback",
  "ssh_list_sessions",
  "ssh_disconnect",
  "ssh_exec",
  "ssh_shell_open",
  "ssh_shell_write",
  "ssh_shell_read",
  "ssh_shell_close",
  "sftp_list",
  "sftp_stat",
  "sftp_read_file",
  "sftp_download_start",
  "sftp_download_profile",
  "sftp_transfer_status",
  "sftp_transfer_list",
  "sftp_transfer_cancel",
]);

const DANGEROUS_TOOL_NAMES = new Set([
  "ssh_disconnect_all",
  "ssh_tunnel_local_start",
  "ssh_tunnel_remote_start",
  "ssh_tunnel_stop",
  "sftp_rm",
  "sftp_write_file",
  "sftp_mkdir",
  "sftp_rename",
  "sftp_chmod",
  "sftp_chown",
  "sftp_touch",
  "sftp_symlink",
  "sftp_upload_start",
  "sftp_upload_profile",
  "ssh_file_write",
  "ssh_file_delete",
  "ssh_file_move",
]);

const READ_ONLY_TOOL_NAMES = new Set([
  "ssh_get_config",
  "ssh_list_profiles",
  "ssh_check_profile",
  "ssh_project_open",
  "ssh_project_tree",
  "ssh_project_search",
  "ssh_project_diff",
  "ssh_project_stat",
  "ssh_project_validate_patch",
  "ssh_file_read",
  "ssh_edit_history",
  "ssh_list_sessions",
  "ssh_shell_read",
  "ssh_shell_list",
  "sftp_list",
  "sftp_stat",
  "sftp_read_file",
  "sftp_readlink",
  "sftp_realpath",
  "sftp_download_start",
  "sftp_download_profile",
  "sftp_transfer_status",
  "sftp_transfer_list",
]);

const LOCAL_ONLY_TOOL_NAMES = new Set([
  "ssh_get_config",
  "ssh_reload_config",
  "ssh_list_profiles",
  "ssh_reload_profiles",
  "ssh_edit_history",
  "ssh_list_sessions",
  "sftp_transfer_status",
  "sftp_transfer_list",
  "sftp_transfer_cancel",
]);

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

  return server.registerTool(name, { ...config, annotations: toolAnnotations(name, config.annotations) }, cb);
}

function toolAnnotations(name: string, annotations: ToolAnnotations | undefined): ToolAnnotations {
  const readOnlyHint = READ_ONLY_TOOL_NAMES.has(name);
  return {
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : DANGEROUS_TOOL_NAMES.has(name),
    openWorldHint: !LOCAL_ONLY_TOOL_NAMES.has(name),
    ...annotations,
  };
}

registerTool(
  "ssh_get_config",
  {
    title: "Get SSH MCP runtime config",
    description: "Return non-secret runtime defaults loaded from the MCP .env file.",
    inputSchema: {},
  },
  async () => toToolResult(async () => ({ ok: true, config: runtimeConfig.get() })),
);

registerTool(
  "ssh_reload_config",
  {
    title: "Reload SSH MCP runtime config",
    description: "Reload non-secret runtime defaults from the MCP .env file.",
    inputSchema: {},
  },
  async () =>
    toToolResult(async () => {
      const config = runtimeConfig.reload();
      setCompactJsonResponse(config.compactJson);
      return {
        ok: true,
        config,
        note: "Tool visibility changes require restarting the MCP server because clients cache the tool list.",
      };
    }),
);

registerTool(
  "ssh_list_profiles",
  {
    title: "List SSH profiles",
    description: "List SSH server profiles loaded from the MCP server .env file. Secret values are never returned.",
    inputSchema: {},
  },
  async () =>
    toToolResult(async () => ({
      ok: true,
      envPath: profiles.sourcePath(),
      profiles: profiles.list(),
    })),
);

registerTool(
  "ssh_reload_profiles",
  {
    title: "Reload SSH profiles",
    description: "Reload SSH server profiles from the MCP server .env file without restarting the MCP server.",
    inputSchema: {},
  },
  async () =>
    toToolResult(async () => ({
      ok: true,
      envPath: profiles.sourcePath(),
      profiles: profiles.reload(),
    })),
);

registerTool(
  "ssh_connect_profile",
  {
    title: "Open SSH profile session",
    description: "Open a persistent SSH session using an SSH_MCP_SERVER_<N>_* profile from .env.",
    inputSchema: {
      profileName: z.string().min(1),
      sessionName: z.string().min(1).optional(),
      tryKeyboard: z.boolean().optional(),
      keyboardResponses: z.array(z.string()).default([]),
      agentForward: z.boolean().optional(),
      keepaliveIntervalMs: z.number().int().min(0).optional(),
      keepaliveCountMax: z.number().int().min(1).optional(),
      readyTimeoutMs: z.number().int().min(1_000).optional(),
      connectionTimeoutMs: z.number().int().min(1_000).optional(),
      hostHash: z.enum(["md5", "sha1", "sha256"]).optional(),
      expectedHostHash: z.string().optional(),
      strictVendor: z.boolean().default(true),
      debug: z.boolean().default(false),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const connected = await connectProfileSession({
        profileName: args.profileName,
        sessionName: args.sessionName,
        agentForward: args.agentForward,
        tryKeyboard: args.tryKeyboard,
        keyboardResponses: args.keyboardResponses,
        keepaliveIntervalMs: args.keepaliveIntervalMs,
        keepaliveCountMax: args.keepaliveCountMax,
        readyTimeoutMs: args.readyTimeoutMs,
        connectionTimeoutMs: args.connectionTimeoutMs,
        strictVendor: args.strictVendor,
        debug: args.debug,
        hostHash: args.hostHash,
        expectedHostHash: args.expectedHostHash,
      });
      return {
        ok: true,
        profile: connected.profile,
        session: connected.session,
      };
    }),
);

registerTool(
  "ssh_run_profile",
  {
    title: "Run command on SSH profile",
    description:
      "Use this first for one-shot remote commands on a configured SSH profile. Prefer this over connect + exec when the user only asks to run a command or inspect a server.",
    inputSchema: {
      profileName: z.string().min(1),
      command: z.string().min(1),
      workingDirectory: z.string().min(1).optional(),
      keepSession: z.boolean().default(false),
      outputEncoding: wireEncodingSchema,
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const config = runtimeConfig.get();
      const connected = await connectProfileSession({
        profileName: args.profileName,
        keyboardResponses: [],
        strictVendor: true,
        debug: false,
      });
      const command = buildRemoteCommand(args.command, args.workingDirectory);

      try {
        const result = await sessions.get(connected.session.id).exec({
          command,
          stdinEncoding: "utf8",
          outputEncoding: args.outputEncoding,
          timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
        });

        return {
          ok: true,
          profile: connected.profile,
          session: connected.session,
          keptSession: args.keepSession,
          result,
        };
      } finally {
        if (!args.keepSession) {
          await sessions.disconnect(connected.session.id);
        }
      }
    }),
);

registerTool(
  "ssh_check_profile",
  {
    title: "Check SSH profile host",
    description:
      "Agent-friendly one-shot remote health check: connect to a named profile, run safe built-in inspection commands, return structured results, and disconnect.",
    inputSchema: {
      profileName: z.string().min(1),
      checks: z.array(remoteCheckNameSchema).default(DEFAULT_REMOTE_CHECKS),
      workingDirectory: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const config = runtimeConfig.get();
      const connected = await connectProfileSession({
        profileName: args.profileName,
        keyboardResponses: [],
        strictVendor: true,
        debug: false,
      });
      const session = sessions.get(connected.session.id);
      const selectedChecks = [...new Set(args.checks)];

      try {
        const checks = [];
        for (const checkName of selectedChecks) {
          const check = REMOTE_CHECK_COMMANDS[checkName];
          checks.push(
            await runRemoteCheck({
              name: checkName,
              title: check.title,
              command: buildRemoteCommand(check.command, args.workingDirectory),
              timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
              maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
              execute: (command) =>
                session.exec({
                  command,
                  stdinEncoding: "utf8",
                  outputEncoding: "utf8",
                  timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
                  maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
                }),
            }),
          );
        }

        return {
          ok: true,
          profile: connected.profile,
          session: connected.session,
          checks,
        };
      } finally {
        await sessions.disconnect(connected.session.id);
      }
    }),
);

registerTool(
  "ssh_project_open",
  {
    title: "Open SSH project",
    description: "Resolve and inspect the editable project root for a configured SSH profile.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        return {
          ok: true,
          profile: projectProfileSummary(workspace.profile),
          project: await inspectRemoteProject(workspace.session, workspace.rootPath),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_tree",
  {
    title: "Read SSH project tree",
    description: "Return a bounded remote project tree rooted inside the profile edit root/default directory.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
      maxDepth: z.number().int().min(1).max(12).optional(),
      maxEntries: z.number().int().min(1).max(10_000).optional(),
      includeHidden: z.boolean().optional(),
      ignoreNames: z.array(z.string().min(1)).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        return {
          ok: true,
          tree: await readRemoteTree(
            workspace.sftp,
            workspace.rootPath,
            defaultTreeOptions(compactTreeOptions(args.maxDepth, args.maxEntries, args.includeHidden, args.ignoreNames)),
          ),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_search",
  {
    title: "Search SSH project",
    description: "Search text in a remote project using rg when available, with grep fallback.",
    inputSchema: {
      profileName: z.string().min(1),
      query: z.string().min(1),
      projectRoot: projectRootSchema,
      paths: z.array(projectPathSchema).default([]),
      literal: z.boolean().default(true),
      maxResults: z.number().int().min(1).max(1000).default(100),
      contextLines: z.number().int().min(0).max(5).default(0),
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        const config = runtimeConfig.get();
        const paths = await resolveProjectPathArgs(workspace, args.paths, true);
        const result = await workspace.session.exec({
          command: buildProjectSearchCommand(workspace.rootPath, args.query, paths, args.literal, args.maxResults, args.contextLines),
          stdinEncoding: "utf8",
          outputEncoding: "utf8",
          timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
        });
        return {
          ok: true,
          projectRoot: workspace.rootPath,
          matches: parseSearchMatches(result.stdout.text ?? ""),
          truncated: result.stdout.truncated,
          result,
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_stat",
  {
    title: "Stat SSH project path",
    description: "Return metadata for a file or directory inside the project root, with sha256 for editable files.",
    inputSchema: {
      profileName: z.string().min(1),
      path: projectPathSchema,
      projectRoot: projectRootSchema,
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, args.path, true);
        const stats = await sftpStat(workspace.sftp, safePath.remotePath, true);
        const payload: { ok: true; path: string; remotePath: string; stats: object; sha256?: string } = {
          ok: true,
          path: args.path,
          remotePath: safePath.remotePath,
          stats: statsToJson(stats),
        };
        if (stats.isFile() && stats.size <= maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes)) {
          payload.sha256 = (await readRemoteFileSnapshot(workspace.sftp, safePath.remotePath, stats.size)).sha256;
        }
        return payload;
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_file_read",
  {
    title: "Read SSH project file",
    description: "Read a bounded file inside the project root and return content plus sha256 for safe edits.",
    inputSchema: {
      profileName: z.string().min(1),
      path: projectPathSchema,
      projectRoot: projectRootSchema,
      encoding: fileEncodingSchema,
      maxBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        const safePath = await resolveSafeRemotePath(workspace.sftp, workspace.profile, workspace.rootPath, args.path, true);
        const snapshot = await readRemoteFileSnapshot(
          workspace.sftp,
          safePath.remotePath,
          args.maxBytes ?? maxEditFileBytes(workspace.profile, runtimeConfig.get().defaultMaxEditFileBytes),
        );
        return { ok: true, file: publicSnapshot(snapshot, args.encoding) };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_file_patch",
  {
    title: "Patch SSH project file",
    description: "Apply a unified diff to one file inside the project root using sha256 concurrency protection and atomic write.",
    inputSchema: {
      profileName: z.string().min(1),
      path: projectPathSchema,
      projectRoot: projectRootSchema,
      unifiedPatch: z.string().min(1),
      expectedSha256: expectedShaSchema,
      createDirs: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      assertPatchSize(args.unifiedPatch);
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, true);
      try {
        const patchFiles = parseUnifiedPatch(args.unifiedPatch);
        if (patchFiles.length !== 1) {
          throw new McpToolError("ssh_file_patch_file_count_invalid", "ssh_file_patch expects exactly one file in unifiedPatch", {
            fileCount: patchFiles.length,
          });
        }
        return {
          ok: true,
          edit: await applySinglePatchFile(workspace, args.path, patchFiles[0]!, args.expectedSha256, args.createDirs),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_validate_patch",
  {
    title: "Validate SSH project patch",
    description: "Validate that a multi-file unified diff applies cleanly without modifying remote files.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
      unifiedPatch: z.string().min(1),
      expectedFiles: z.array(expectedFileSchema).default([]),
    },
  },
  async (args) =>
    toToolResult(async () => {
      assertPatchSize(args.unifiedPatch);
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        return {
          ok: true,
          validation: await validateProjectPatch(workspace, parseUnifiedPatch(args.unifiedPatch), args.expectedFiles),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_apply_patch",
  {
    title: "Apply SSH project patch",
    description: "Apply a multi-file unified diff inside the project root with backups, sha256 protection, and rollback on failure.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
      unifiedPatch: z.string().min(1),
      expectedFiles: z.array(expectedFileSchema).min(1),
      createDirs: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      assertPatchSize(args.unifiedPatch);
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, true);
      try {
        return {
          ok: true,
          edit: await applyProjectPatch(
            workspace,
            parseUnifiedPatch(args.unifiedPatch),
            args.expectedFiles,
            args.createDirs,
          ),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_file_write",
  {
    title: "Write SSH project file",
    description: "Overwrite or create one project file with sha256/absent protection and atomic write.",
    inputSchema: {
      profileName: z.string().min(1),
      path: projectPathSchema,
      projectRoot: projectRootSchema,
      data: z.string(),
      encoding: fileEncodingSchema,
      expectedSha256: expectedShaSchema.optional(),
      createDirs: z.boolean().default(false),
      mode: z.number().int().min(0).max(0o7777).optional(),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, true);
      try {
        return {
          ok: true,
          edit: await writeProjectFile(
            workspace,
            args.path,
            args.encoding === "base64" ? Buffer.from(args.data, "base64") : Buffer.from(args.data, "utf8"),
            args.expectedSha256,
            args.createDirs,
            args.mode,
          ),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_file_delete",
  {
    title: "Delete SSH project file",
    description: "Delete one project file after sha256 verification. Requires profile ALLOW_DELETE=true.",
    inputSchema: {
      profileName: z.string().min(1),
      path: projectPathSchema,
      projectRoot: projectRootSchema,
      expectedSha256: z.string().length(64),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, true);
      try {
        return { ok: true, edit: await deleteProjectFile(workspace, args.path, args.expectedSha256) };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_file_move",
  {
    title: "Move SSH project file",
    description: "Move or rename one project file inside the project root. Requires profile ALLOW_EDIT=true.",
    inputSchema: {
      profileName: z.string().min(1),
      fromPath: projectPathSchema,
      toPath: projectPathSchema,
      projectRoot: projectRootSchema,
      expectedSha256: z.string().length(64),
      createDirs: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, true);
      try {
        return {
          ok: true,
          edit: await moveProjectFile(workspace, args.fromPath, args.toPath, args.expectedSha256, args.createDirs),
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_diff",
  {
    title: "Read SSH project diff",
    description: "Return git status and diff for the remote project when it is a git repository.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
      paths: z.array(projectPathSchema).default([]),
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        const config = runtimeConfig.get();
        const paths = await resolveProjectPathArgs(workspace, args.paths, false);
        const result = await workspace.session.exec({
          command: buildProjectDiffCommand(workspace.rootPath, paths),
          stdinEncoding: "utf8",
          outputEncoding: "utf8",
          timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
        });
        return { ok: true, projectRoot: workspace.rootPath, result };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_project_run_checks",
  {
    title: "Run SSH project checks",
    description: "Run explicit project verification commands from the project root.",
    inputSchema: {
      profileName: z.string().min(1),
      projectRoot: projectRootSchema,
      checks: z.array(z.string().min(1)).min(1),
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const workspace = await connectProjectWorkspace(args.profileName, args.projectRoot, false);
      try {
        const config = runtimeConfig.get();
        const results = [];
        for (const check of args.checks) {
          results.push(
            await workspace.session.exec({
              command: buildRemoteCommand(check, workspace.rootPath),
              stdinEncoding: "utf8",
              outputEncoding: "utf8",
              timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
              maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
            }),
          );
        }
        return {
          ok: true,
          projectRoot: workspace.rootPath,
          passed: results.every((result) => result.exitCode === 0 && !result.timedOut),
          results,
        };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_edit_history",
  {
    title: "List SSH edit history",
    description: "List in-memory edit records created by this MCP server process.",
    inputSchema: {
      profileName: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      edits: [...editHistory.values()]
        .filter((edit) => args.profileName === undefined || edit.profileName === normalizeProfileNameForHistory(args.profileName))
        .slice(-args.limit),
    })),
);

registerTool(
  "ssh_edit_rollback",
  {
    title: "Rollback SSH edit",
    description: "Rollback an edit created by this MCP server process using stored backup paths.",
    inputSchema: {
      profileName: z.string().min(1),
      editId: z.string().min(1),
    },
    annotations: { destructiveHint: true },
  },
  async (args) =>
    toToolResult(async () => {
      const edit = editHistory.get(args.editId);
      if (edit === undefined) {
        throw new McpToolError("ssh_edit_not_found", "SSH edit id was not found", { editId: args.editId });
      }
      const workspace = await connectProjectWorkspace(args.profileName, edit.projectRoot, true);
      try {
        return { ok: true, rollback: await rollbackEdit(workspace, edit) };
      } finally {
        await sessions.disconnect(workspace.sessionId);
      }
    }),
);

registerTool(
  "ssh_connect",
  {
    title: "Open SSH session",
    description: "Open a persistent SSH connection. The returned sessionId is reused by exec, shell, SFTP, transfer, and tunnel tools.",
    inputSchema: {
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535).optional(),
      username: z.string().min(1),
      name: z.string().min(1).optional(),
      password: z.string().optional(),
      privateKey: z.string().optional(),
      privateKeyPath: z.string().optional(),
      passphrase: z.string().optional(),
      agent: z.string().optional(),
      agentForward: z.boolean().optional(),
      tryKeyboard: z.boolean().optional(),
      keyboardResponses: z.array(z.string()).default([]),
      keepaliveIntervalMs: z.number().int().min(0).optional(),
      keepaliveCountMax: z.number().int().min(1).optional(),
      readyTimeoutMs: z.number().int().min(1_000).optional(),
      connectionTimeoutMs: z.number().int().min(1_000).optional(),
      hostHash: z.enum(["md5", "sha1", "sha256"]).optional(),
      expectedHostHash: z.string().optional(),
      strictVendor: z.boolean().default(true),
      debug: z.boolean().default(false),
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      session: await sessions.connect({
        host: args.host,
        port: args.port ?? runtimeConfig.get().defaultSshPort,
        username: args.username,
        agentForward: args.agentForward ?? runtimeConfig.get().defaultAgentForward,
        tryKeyboard: args.tryKeyboard ?? runtimeConfig.get().defaultTryKeyboard,
        keyboardResponses: args.keyboardResponses,
        keepaliveIntervalMs: args.keepaliveIntervalMs ?? runtimeConfig.get().defaultKeepaliveIntervalMs,
        keepaliveCountMax: args.keepaliveCountMax ?? runtimeConfig.get().defaultKeepaliveCountMax,
        readyTimeoutMs: args.readyTimeoutMs ?? runtimeConfig.get().defaultReadyTimeoutMs,
        connectionTimeoutMs: args.connectionTimeoutMs ?? runtimeConfig.get().defaultConnectionTimeoutMs,
        strictVendor: args.strictVendor,
        debug: args.debug,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.password === undefined ? {} : { password: args.password }),
        ...(args.privateKey === undefined ? {} : { privateKey: args.privateKey }),
        ...(args.privateKeyPath === undefined ? {} : { privateKeyPath: args.privateKeyPath }),
        ...(args.passphrase === undefined ? {} : { passphrase: args.passphrase }),
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        ...(args.hostHash === undefined ? {} : { hostHash: args.hostHash }),
        ...(args.expectedHostHash === undefined ? {} : { expectedHostHash: args.expectedHostHash }),
      }),
    })),
);

registerTool(
  "ssh_list_sessions",
  {
    title: "List SSH sessions",
    description: "List persistent SSH sessions held by this MCP server process.",
    inputSchema: {},
  },
  async () => toToolResult(async () => ({ ok: true, sessions: sessions.list() })),
);

registerTool(
  "ssh_disconnect",
  {
    title: "Disconnect SSH session",
    description: "Close one SSH session and all shells, SFTP handles, and tunnels attached to it.",
    inputSchema: { sessionId: sessionIdSchema },
  },
  async (args) => toToolResult(async () => ({ ok: true, session: await sessions.disconnect(args.sessionId) })),
);

registerTool(
  "ssh_disconnect_all",
  {
    title: "Disconnect all SSH sessions",
    description: "Close every SSH session held by this MCP server process.",
    inputSchema: {},
  },
  async () => toToolResult(async () => ({ ok: true, sessions: await sessions.disconnectAll() })),
);

registerTool(
  "ssh_exec",
  {
    title: "Execute remote command",
    description:
      "Run a command on an existing persistent SSH session and capture bounded stdout/stderr. Requires sessionId; use ssh_run_profile for one-shot profile commands.",
    inputSchema: {
      sessionId: sessionIdSchema,
      command: z.string().min(1),
      env: z.record(z.string()).optional(),
      stdin: z.string().optional(),
      stdinEncoding: wireEncodingSchema,
      outputEncoding: wireEncodingSchema,
      timeoutMs: z.number().int().min(1).optional(),
      maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
      pty: z.union([z.boolean(), ptySchema]).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const pty = compactExecPty(args.pty);
      const config = runtimeConfig.get();
      return {
        ok: true,
        result: await sessions.get(args.sessionId).exec({
          command: args.command,
          stdinEncoding: args.stdinEncoding,
          outputEncoding: args.outputEncoding,
          timeoutMs: args.timeoutMs ?? config.defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? config.defaultMaxOutputBytes,
          ...(args.env === undefined ? {} : { env: args.env }),
          ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
          ...(pty === undefined ? {} : { pty }),
        }),
      };
    }),
);

registerTool(
  "ssh_rekey",
  {
    title: "Rekey SSH session",
    description: "Request an SSH transport rekey for long-lived sessions.",
    inputSchema: { sessionId: sessionIdSchema },
  },
  async (args) => toToolResult(async () => sessions.get(args.sessionId).rekey()),
);

registerTool(
  "ssh_shell_open",
  {
    title: "Open interactive shell",
    description: "Open a persistent interactive shell channel with an optional pseudo-terminal.",
    inputSchema: {
      sessionId: sessionIdSchema,
      env: z.record(z.string()).optional(),
      allocatePty: z.boolean().optional(),
      pty: ptySchema.optional(),
      ringBufferBytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const pty = compactPty(args.pty);
      const config = runtimeConfig.get();
      return {
        ok: true,
        shell: await sessions.get(args.sessionId).openShell({
          allocatePty: args.allocatePty ?? config.defaultShellAllocatePty,
          ringBufferBytes: args.ringBufferBytes ?? config.defaultShellRingBufferBytes,
          ...(args.env === undefined ? {} : { env: args.env }),
          ...(pty === undefined ? {} : { pty }),
        }),
      };
    }),
);

registerTool(
  "ssh_shell_list",
  {
    title: "List shells",
    description: "List interactive shell channels in one SSH session.",
    inputSchema: { sessionId: sessionIdSchema },
  },
  async (args) => toToolResult(async () => ({ ok: true, shells: sessions.get(args.sessionId).listShells() })),
);

registerTool(
  "ssh_shell_write",
  {
    title: "Write shell input",
    description: "Write UTF-8 or base64 input to a persistent interactive shell.",
    inputSchema: {
      sessionId: sessionIdSchema,
      shellId: z.string().min(1),
      data: z.string(),
      encoding: wireEncodingSchema,
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      shell: sessions.get(args.sessionId).writeShell(args.shellId, args.data, args.encoding),
    })),
);

registerTool(
  "ssh_shell_read",
  {
    title: "Read shell output",
    description: "Read buffered output from a persistent interactive shell.",
    inputSchema: {
      sessionId: sessionIdSchema,
      shellId: z.string().min(1),
      maxBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
      encoding: wireEncodingSchema,
      drain: z.boolean().default(true),
    },
  },
  async (args) =>
    toToolResult(async () =>
      sessions.get(args.sessionId).readShell({
        shellId: args.shellId,
        maxBytes: args.maxBytes ?? runtimeConfig.get().defaultShellReadMaxBytes,
        encoding: args.encoding,
        drain: args.drain,
      }),
    ),
);

registerTool(
  "ssh_shell_resize",
  {
    title: "Resize shell PTY",
    description: "Resize the pseudo-terminal for an interactive shell.",
    inputSchema: {
      sessionId: sessionIdSchema,
      shellId: z.string().min(1),
      rows: z.number().int().min(1),
      cols: z.number().int().min(1),
      height: z.number().int().min(0).default(0),
      width: z.number().int().min(0).default(0),
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      shell: sessions.get(args.sessionId).resizeShell(args.shellId, args.rows, args.cols, args.height, args.width),
    })),
);

registerTool(
  "ssh_shell_close",
  {
    title: "Close shell",
    description: "Close an interactive shell channel.",
    inputSchema: { sessionId: sessionIdSchema, shellId: z.string().min(1) },
  },
  async (args) =>
    toToolResult(async () => ({ ok: true, shell: sessions.get(args.sessionId).closeShell(args.shellId) })),
);

registerTool(
  "sftp_list",
  {
    title: "List remote directory",
    description: "List SFTP directory entries with type, mode, owner, and size metadata.",
    inputSchema: { sessionId: sessionIdSchema, remotePath: z.string().min(1) },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      return { ok: true, entries: (await sftpReadDir(sftp, args.remotePath)).map(entryToJson) };
    }),
);

registerTool(
  "sftp_stat",
  {
    title: "Stat remote path",
    description: "Get SFTP stat/lstat metadata for a remote path.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      followSymlinks: z.boolean().default(true),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      return { ok: true, stats: statsToJson(await sftpStat(sftp, args.remotePath, args.followSymlinks)) };
    }),
);

registerTool(
  "sftp_read_file",
  {
    title: "Read small remote file",
    description: "Read a bounded remote file into memory. Use sftp_download_start for large files.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      encoding: wireEncodingSchema,
      maxBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      return {
        ok: true,
        file: await sftpReadFileLimited(
          sftp,
          args.remotePath,
          args.encoding,
          args.maxBytes ?? runtimeConfig.get().defaultSftpReadMaxBytes,
        ),
      };
    }),
);

registerTool(
  "sftp_write_file",
  {
    title: "Write small remote file",
    description: "Write UTF-8 or base64 data to a remote file. Use sftp_upload_start for large files.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      data: z.string(),
      encoding: wireEncodingSchema,
      flag: z.enum(["w", "wx", "a", "ax"]).default("w"),
      mode: z.number().int().min(0).max(0o7777).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      const data = args.encoding === "base64" ? Buffer.from(args.data, "base64") : Buffer.from(args.data, "utf8");
      await sftpWriteFile(sftp, args.remotePath, data, args.mode, args.flag);
      return { ok: true, remotePath: args.remotePath, bytesWritten: data.length };
    }),
);

registerTool(
  "sftp_mkdir",
  {
    title: "Create remote directory",
    description: "Create a remote directory, optionally recursively.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      recursive: z.boolean().default(false),
      mode: modeSchema.optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      const attrs = args.mode === undefined ? undefined : { mode: args.mode };
      if (args.recursive) {
        await sftpMkdirRecursive(sftp, args.remotePath, attrs);
      } else {
        await sftpMkdir(sftp, args.remotePath, attrs);
      }
      return { ok: true, remotePath: args.remotePath };
    }),
);

registerTool(
  "sftp_rm",
  {
    title: "Remove remote path",
    description: "Remove a remote file, symlink, or directory. Directories require recursive=true.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      recursive: z.boolean().default(false),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      await sftpRemove(sftp, args.remotePath, args.recursive);
      return { ok: true, remotePath: args.remotePath };
    }),
);

registerTool(
  "sftp_rename",
  {
    title: "Rename remote path",
    description: "Rename or move a remote path.",
    inputSchema: {
      sessionId: sessionIdSchema,
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      await sftpRename(sftp, args.sourcePath, args.destinationPath);
      return { ok: true, sourcePath: args.sourcePath, destinationPath: args.destinationPath };
    }),
);

registerTool(
  "sftp_chmod",
  {
    title: "Change remote mode",
    description: "Change permissions on a remote path.",
    inputSchema: { sessionId: sessionIdSchema, remotePath: z.string().min(1), mode: modeSchema },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      await sftpChmod(sftp, args.remotePath, args.mode);
      return { ok: true, remotePath: args.remotePath, mode: args.mode };
    }),
);

registerTool(
  "sftp_chown",
  {
    title: "Change remote owner",
    description: "Change uid/gid ownership on a remote path.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      uid: z.number().int().min(0),
      gid: z.number().int().min(0),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      await sftpChown(sftp, args.remotePath, args.uid, args.gid);
      return { ok: true, remotePath: args.remotePath, uid: args.uid, gid: args.gid };
    }),
);

registerTool(
  "sftp_touch",
  {
    title: "Touch remote path",
    description: "Set remote atime/mtime on a path.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      atimeIso: z.string().datetime().optional(),
      mtimeIso: z.string().datetime().optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      const now = new Date();
      const atime = args.atimeIso === undefined ? now : new Date(args.atimeIso);
      const mtime = args.mtimeIso === undefined ? now : new Date(args.mtimeIso);
      await sftpUtimes(sftp, args.remotePath, atime, mtime);
      return { ok: true, remotePath: args.remotePath, atime: atime.toISOString(), mtime: mtime.toISOString() };
    }),
);

registerTool(
  "sftp_symlink",
  {
    title: "Create remote symlink",
    description: "Create a symbolic link on the remote host.",
    inputSchema: {
      sessionId: sessionIdSchema,
      targetPath: z.string().min(1),
      linkPath: z.string().min(1),
    },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      await sftpSymlink(sftp, args.targetPath, args.linkPath);
      return { ok: true, targetPath: args.targetPath, linkPath: args.linkPath };
    }),
);

registerTool(
  "sftp_readlink",
  {
    title: "Read remote symlink",
    description: "Read a symbolic link target on the remote host.",
    inputSchema: { sessionId: sessionIdSchema, remotePath: z.string().min(1) },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      return { ok: true, remotePath: args.remotePath, targetPath: await sftpReadlink(sftp, args.remotePath) };
    }),
);

registerTool(
  "sftp_realpath",
  {
    title: "Resolve remote path",
    description: "Resolve a remote path to an absolute canonical path.",
    inputSchema: { sessionId: sessionIdSchema, remotePath: z.string().min(1) },
  },
  async (args) =>
    toToolResult(async () => {
      const sftp = await sessions.get(args.sessionId).getSftp();
      return { ok: true, remotePath: args.remotePath, realPath: await sftpRealpath(sftp, args.remotePath) };
    }),
);

registerTool(
  "sftp_upload_start",
  {
    title: "Start large upload",
    description: "Start a background SFTP upload job with progress, cancellation, and resume support.",
    inputSchema: {
      sessionId: sessionIdSchema,
      localPath: z.string().min(1),
      remotePath: z.string().min(1),
      resume: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      atomic: z.boolean().optional(),
      remoteTempPath: z.string().min(1).optional(),
      mode: z.number().int().min(0).max(0o7777).optional(),
      chunkSizeBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      assertNonEmpty(args.localPath, "localPath");
      assertNonEmpty(args.remotePath, "remotePath");
      const session = sessions.get(args.sessionId);
      const config = runtimeConfig.get();
      return {
        ok: true,
        transfer: transfers.startUpload(session, {
          sessionId: args.sessionId,
          localPath: args.localPath,
          remotePath: args.remotePath,
          resume: args.resume ?? config.defaultTransferResume,
          overwrite: args.overwrite ?? config.defaultTransferOverwrite,
          atomic: args.atomic ?? config.defaultTransferAtomic,
          chunkSizeBytes: args.chunkSizeBytes ?? config.defaultTransferChunkSizeBytes,
          ...(args.remoteTempPath === undefined ? {} : { remoteTempPath: args.remoteTempPath }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        }),
      };
    }),
);

registerTool(
  "sftp_upload_profile",
  {
    title: "Upload to SSH profile",
    description: "Agent-friendly upload: connect to a named profile and start a resumable background SFTP upload job.",
    inputSchema: {
      profileName: z.string().min(1),
      localPath: z.string().min(1),
      remotePath: z.string().min(1),
      resume: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      atomic: z.boolean().optional(),
      remoteTempPath: z.string().min(1).optional(),
      mode: z.number().int().min(0).max(0o7777).optional(),
      chunkSizeBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      assertNonEmpty(args.localPath, "localPath");
      assertNonEmpty(args.remotePath, "remotePath");
      const config = runtimeConfig.get();
      const connected = await connectProfileSession({
        profileName: args.profileName,
        keyboardResponses: [],
        strictVendor: true,
        debug: false,
      });
      const session = sessions.get(connected.session.id);

      return {
        ok: true,
        profile: connected.profile,
        session: connected.session,
        transfer: transfers.startUpload(session, {
          sessionId: connected.session.id,
          localPath: args.localPath,
          remotePath: args.remotePath,
          resume: args.resume ?? config.defaultTransferResume,
          overwrite: args.overwrite ?? config.defaultTransferOverwrite,
          atomic: args.atomic ?? config.defaultTransferAtomic,
          chunkSizeBytes: args.chunkSizeBytes ?? config.defaultTransferChunkSizeBytes,
          ...(args.remoteTempPath === undefined ? {} : { remoteTempPath: args.remoteTempPath }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        }),
      };
    }),
);

registerTool(
  "sftp_download_start",
  {
    title: "Start large download",
    description: "Start a background SFTP download job with progress, cancellation, and resume support.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remotePath: z.string().min(1),
      localPath: z.string().min(1),
      resume: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      atomic: z.boolean().optional(),
      localTempPath: z.string().min(1).optional(),
      chunkSizeBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      assertNonEmpty(args.localPath, "localPath");
      assertNonEmpty(args.remotePath, "remotePath");
      const session = sessions.get(args.sessionId);
      const config = runtimeConfig.get();
      return {
        ok: true,
        transfer: transfers.startDownload(session, {
          sessionId: args.sessionId,
          remotePath: args.remotePath,
          localPath: args.localPath,
          resume: args.resume ?? config.defaultTransferResume,
          overwrite: args.overwrite ?? config.defaultTransferOverwrite,
          atomic: args.atomic ?? config.defaultTransferAtomic,
          chunkSizeBytes: args.chunkSizeBytes ?? config.defaultTransferChunkSizeBytes,
          ...(args.localTempPath === undefined ? {} : { localTempPath: args.localTempPath }),
        }),
      };
    }),
);

registerTool(
  "sftp_download_profile",
  {
    title: "Download from SSH profile",
    description: "Agent-friendly download: connect to a named profile and start a resumable background SFTP download job.",
    inputSchema: {
      profileName: z.string().min(1),
      remotePath: z.string().min(1),
      localPath: z.string().min(1),
      resume: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      atomic: z.boolean().optional(),
      localTempPath: z.string().min(1).optional(),
      chunkSizeBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).optional(),
    },
  },
  async (args) =>
    toToolResult(async () => {
      assertNonEmpty(args.localPath, "localPath");
      assertNonEmpty(args.remotePath, "remotePath");
      const config = runtimeConfig.get();
      const connected = await connectProfileSession({
        profileName: args.profileName,
        keyboardResponses: [],
        strictVendor: true,
        debug: false,
      });
      const session = sessions.get(connected.session.id);

      return {
        ok: true,
        profile: connected.profile,
        session: connected.session,
        transfer: transfers.startDownload(session, {
          sessionId: connected.session.id,
          remotePath: args.remotePath,
          localPath: args.localPath,
          resume: args.resume ?? config.defaultTransferResume,
          overwrite: args.overwrite ?? config.defaultTransferOverwrite,
          atomic: args.atomic ?? config.defaultTransferAtomic,
          chunkSizeBytes: args.chunkSizeBytes ?? config.defaultTransferChunkSizeBytes,
          ...(args.localTempPath === undefined ? {} : { localTempPath: args.localTempPath }),
        }),
      };
    }),
);

registerTool(
  "sftp_transfer_status",
  {
    title: "Get transfer status",
    description: "Get progress, ETA, and final state for a background upload/download job.",
    inputSchema: { transferId: z.string().min(1) },
  },
  async (args) => toToolResult(async () => ({ ok: true, transfer: transfers.get(args.transferId) })),
);

registerTool(
  "sftp_transfer_list",
  {
    title: "List transfers",
    description: "List background transfer jobs, optionally filtered by SSH session.",
    inputSchema: { sessionId: sessionIdSchema.optional() },
  },
  async (args) => toToolResult(async () => ({ ok: true, transfers: transfers.list(args.sessionId) })),
);

registerTool(
  "sftp_transfer_cancel",
  {
    title: "Cancel transfer",
    description: "Cancel a running or queued background transfer job.",
    inputSchema: { transferId: z.string().min(1) },
  },
  async (args) => toToolResult(async () => ({ ok: true, transfer: transfers.cancel(args.transferId) })),
);

registerTool(
  "ssh_tunnel_local_start",
  {
    title: "Start local port forward",
    description: "Listen locally and forward accepted TCP connections through SSH to a remote target.",
    inputSchema: {
      sessionId: sessionIdSchema,
      localHost: z.string().min(1).optional(),
      localPort: positivePortSchema.default(0),
      targetHost: z.string().min(1),
      targetPort: z.number().int().min(1).max(65_535),
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      tunnel: await sessions.get(args.sessionId).startLocalForward({
        localHost: args.localHost ?? runtimeConfig.get().defaultLocalTunnelHost,
        localPort: args.localPort,
        targetHost: args.targetHost,
        targetPort: args.targetPort,
      }),
    })),
);

registerTool(
  "ssh_tunnel_remote_start",
  {
    title: "Start remote port forward",
    description: "Bind a remote TCP port through SSH and forward incoming connections to a local target.",
    inputSchema: {
      sessionId: sessionIdSchema,
      remoteHost: z.string().min(1).optional(),
      remotePort: positivePortSchema.default(0),
      targetHost: z.string().min(1),
      targetPort: z.number().int().min(1).max(65_535),
    },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      tunnel: await sessions.get(args.sessionId).startRemoteForward({
        remoteHost: args.remoteHost ?? runtimeConfig.get().defaultRemoteTunnelHost,
        remotePort: args.remotePort,
        targetHost: args.targetHost,
        targetPort: args.targetPort,
      }),
    })),
);

registerTool(
  "ssh_tunnel_list",
  {
    title: "List SSH tunnels",
    description: "List local and remote port forwards for one SSH session.",
    inputSchema: { sessionId: sessionIdSchema },
  },
  async (args) => toToolResult(async () => ({ ok: true, tunnels: sessions.get(args.sessionId).listTunnels() })),
);

registerTool(
  "ssh_tunnel_stop",
  {
    title: "Stop SSH tunnel",
    description: "Stop a local or remote port forward.",
    inputSchema: { sessionId: sessionIdSchema, tunnelId: z.string().min(1) },
  },
  async (args) =>
    toToolResult(async () => ({
      ok: true,
      tunnel: await sessions.get(args.sessionId).stopTunnel(args.tunnelId),
    })),
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async (): Promise<void> => {
  await sessions.disconnectAll();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

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

