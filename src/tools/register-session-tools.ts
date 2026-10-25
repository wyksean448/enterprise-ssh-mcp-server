import type { ToolContext } from "../app/tool-context.js";
import { isInstaboxSshTokenTarget, parseSshTarget } from "../ssh-target.js";
import { probeSshHostKey } from "../ssh-host-key.js";
import { runOpenSshCommand } from "../openssh-command.js";
import { runOpenSshCommandWithTemporaryHostCa } from "../openssh-temporary.js";
import { trustOpenSshHostCa } from "../openssh-trust.js";
import { McpToolError } from "../tool-result.js";

export function registerSessionTools(ctx: Pick<ToolContext, "z" | "toToolResult" | "runtimeConfig" | "sessions" | "sessionIdSchema" | "wireEncodingSchema" | "ptySchema" | "registerTool" | "compactExecPty" | "compactPty">): void {
  const { z, toToolResult, runtimeConfig, sessions, sessionIdSchema, wireEncodingSchema, ptySchema, registerTool, compactExecPty, compactPty } = ctx;

  registerTool(
    "ssh_run_openssh_temporary",
    {
      title: "Run one-shot command with temporary host trust",
      description: "One-shot native OpenSSH with isolated temporary host CA trust, requiring a locally pinned CA fingerprint. For InstaBox, use usernameEnvVar (no credential in arguments) or opt-in ephemeralToken for one-time use without setup. The latter may be retained in MCP client/tool request logs even though the server does not persist it. No persistent session or permanent known_hosts changes.",
      inputSchema: {
        host: z.string().min(1).describe("Hostname/IP; username@hostname is supported only when usernameEnvVar is omitted. For InstaBox, provide hostname only and use usernameEnvVar."),
        username: z.string().min(1).optional(),
        usernameEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("Read the SSH username/token from this local MCP process environment variable instead of passing it in tool arguments."),
        ephemeralToken: z.string().regex(/^ibssh_[A-Za-z0-9_-]+$/).optional().describe("Explicit one-shot InstaBox credential. Mutually exclusive with username/usernameEnvVar. WARNING: MCP clients may log this sensitive argument."),
        port: z.number().int().min(1).max(65_535).optional(),
        command: z.string().min(1),
        identityFile: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
        maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
      },
    },
    async (args) =>
      toToolResult(async () => ({
        ok: true,
        result: await runOpenSshCommandWithTemporaryHostCa({
          host: args.host,
          port: args.port ?? runtimeConfig.get().defaultSshPort,
          command: args.command,
          timeoutMs: args.timeoutMs ?? runtimeConfig.get().defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? runtimeConfig.get().defaultMaxOutputBytes,
          ...(args.username === undefined ? {} : { username: args.username }),
          ...(args.usernameEnvVar === undefined ? {} : { usernameEnvVar: args.usernameEnvVar }),
          ...(args.ephemeralToken === undefined ? {} : { ephemeralToken: args.ephemeralToken }),
          ...(args.identityFile === undefined ? {} : { identityFile: args.identityFile }),
        }),
      })),
  );

  registerTool(
    "ssh_trust_host_ca",
    {
      title: "Trust an OpenSSH host CA",
      description: "Append an @cert-authority entry to the local OpenSSH known_hosts file only when the CA public key matches the host-specific fingerprint pinned in SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS. This tool cannot create or override trust pins; call only when the user requests permanent trust.",
      inputSchema: {
        host: z.string().min(1),
        port: z.number().int().min(1).max(65_535),
        knownHostsEntry: z.string().min(1),
      },
    },
    async (args) =>
      toToolResult(async () => ({
        ok: true,
        result: await trustOpenSshHostCa(args),
      })),
  );

  registerTool(
    "ssh_run_openssh",
    {
      title: "Run one-shot command via OpenSSH",
      description: "Run one remote command with native OpenSSH and strict known_hosts verification. For InstaBox use usernameEnvVar or opt-in ephemeralToken for one request without setup. The token is kept out of the native SSH process argv, but MCP clients may log a one-shot token argument.",
      inputSchema: {
        host: z.string().min(1).describe("Hostname/IP or username@hostname; no URL scheme or path."),
        username: z.string().min(1).optional(),
        usernameEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("Read the SSH username/token from this local MCP process environment variable instead of passing it in tool arguments."),
        ephemeralToken: z.string().regex(/^ibssh_[A-Za-z0-9_-]+$/).optional().describe("Explicit one-shot InstaBox credential. Mutually exclusive with username/usernameEnvVar. WARNING: MCP clients may log this sensitive argument."),
        port: z.number().int().min(1).max(65_535).optional(),
        command: z.string().min(1),
        identityFile: z.string().min(1).optional(),
        knownHostsPath: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
        maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
      },
    },
    async (args) =>
      toToolResult(async () => ({
        ok: true,
        result: await runOpenSshCommand({
          host: args.host,
          port: args.port ?? runtimeConfig.get().defaultSshPort,
          command: args.command,
          timeoutMs: args.timeoutMs ?? runtimeConfig.get().defaultExecTimeoutMs,
          maxOutputBytes: args.maxOutputBytes ?? runtimeConfig.get().defaultMaxOutputBytes,
          ...(args.username === undefined ? {} : { username: args.username }),
          ...(args.usernameEnvVar === undefined ? {} : { usernameEnvVar: args.usernameEnvVar }),
          ...(args.ephemeralToken === undefined ? {} : { ephemeralToken: args.ephemeralToken }),
          ...(args.identityFile === undefined ? {} : { identityFile: args.identityFile }),
          ...(args.knownHostsPath === undefined ? {} : { knownHostsPath: args.knownHostsPath }),
        }),
      })),
  );

  registerTool(
    "ssh_probe_host_key",
    {
      title: "Probe SSH host key",
      description: "Inspect the SSH host key fingerprint without authenticating. The observed fingerprint is not automatically trusted; verify it before using it to connect with credentials or InstaBox SSH tokens.",
      inputSchema: {
        host: z.string().min(1).describe("Hostname/IP only; do not include username@, a URL scheme, or a path."),
        port: z.number().int().min(1).max(65_535).optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      },
    },
    async (args) =>
      toToolResult(async () => {
        const host = args.host.trim();
        if (host.length === 0 || /\s/.test(host) || host.includes("@") || host.includes("/") || host.includes("\\") || host.includes("://")) {
          throw new McpToolError("ssh_host_key_probe_invalid", "Provide a hostname/IP only, without a username, URL scheme, or path", {
            field: "host",
          });
        }
        const port = args.port ?? runtimeConfig.get().defaultSshPort;
        const fingerprint = await probeSshHostKey({
          host,
          port,
          timeoutMs: args.timeoutMs ?? runtimeConfig.get().defaultConnectionTimeoutMs,
        });
        return {
          ok: true,
          host,
          port,
          ...fingerprint,
          hostHash: "sha256",
          connectionBackendSupported: fingerprint.ssh2Compatible,
          note: fingerprint.ssh2Compatible
            ? "No authentication was attempted and this fingerprint has not been trusted automatically. Verify it via a trusted source before using sha256Hex as expectedHostHash."
            : "An OpenSSH host certificate was observed. The current ssh2 session backend cannot negotiate this certificate algorithm, so ssh_connect cannot connect to this endpoint yet. No authentication was attempted.",
        };
      }),
  );

  registerTool(
    "ssh_connect",
    {
      title: "Open SSH session",
      description: "Open a persistent SSH connection without requiring a saved Profile. Set host to a hostname/IP and username separately, or use host='username@hostname' and omit username. InstaBox token usernames are recognized, but the current ssh2 transport cannot negotiate InstaBox's OpenSSH host-certificate algorithm; it refuses the connection without sending the token. The returned sessionId is reused by exec, shell, SFTP, transfer, and tunnel tools for compatible SSH servers.",
      inputSchema: {
        host: z.string().min(1).describe("SSH hostname/IP, or user@hostname (for example user@ssh.example.com). Do not include ssh:// or a port here."),
        port: z.number().int().min(1).max(65_535).optional(),
        username: z.string().min(1).optional(),
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
      toToolResult(async () => {
        const target = parseSshTarget({ host: args.host, username: args.username });
        if (isInstaboxSshTokenTarget(target)) {
          throw new McpToolError(
            "ssh_host_certificate_unsupported",
            "InstaBox presents an OpenSSH host certificate that the current ssh2 session backend cannot negotiate. This is a transport compatibility limitation, not an authentication failure; the token was not sent. A native OpenSSH backend is required.",
            { host: target.host, port: args.port ?? runtimeConfig.get().defaultSshPort },
          );
        }
        return {
          ok: true,
          session: await sessions.connect({
            host: target.host,
            port: args.port ?? runtimeConfig.get().defaultSshPort,
            username: target.username,
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
        };
      }),
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
}
