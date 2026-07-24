#!/usr/bin/env node
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PseudoTtyOptions } from "ssh2";

import { defaultEnvPath, ProfileRegistry } from "./env-profiles.js";
import { RuntimeConfigRegistry } from "./runtime-config.js";
import { SessionRegistry } from "./session-registry.js";
import type { ExecResult, SessionSummary } from "./ssh-session.js";
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
  sftpUtimes,
  sftpWriteFile,
  statsToJson,
} from "./sftp-ops.js";
import { TransferManager } from "./transfer-manager.js";
import { assertNonEmpty, setCompactJsonResponse, toToolResult } from "./tool-result.js";

const server = new McpServer({
  name: "enterprise-ssh-mcp-server",
  version: "0.1.2",
});

const envPath = defaultEnvPath();
const profiles = new ProfileRegistry(envPath);
const runtimeConfig = new RuntimeConfigRegistry(envPath);
setCompactJsonResponse(runtimeConfig.get().compactJson);
const sessions = new SessionRegistry();
const transfers = new TransferManager();

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
  "sftp_write_file",
  "sftp_mkdir",
  "sftp_upload_start",
  "sftp_upload_profile",
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
  "sftp_chmod",
  "sftp_chown",
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

  return server.registerTool(name, config, cb);
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
    description: "Open a persistent SSH session using an SSH_SERVER_<PROFILE>_* profile from .env.",
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

