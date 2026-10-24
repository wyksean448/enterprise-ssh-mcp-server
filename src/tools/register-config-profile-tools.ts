import type { ToolContext } from "../app/tool-context.js";

export function registerConfigProfileTools(ctx: Pick<ToolContext, "z" | "toToolResult" | "profiles" | "runtimeConfig" | "reloadEnvState" | "sessions" | "wireEncodingSchema" | "remoteCheckNameSchema" | "DEFAULT_REMOTE_CHECKS" | "REMOTE_CHECK_COMMANDS" | "registerTool" | "connectProfileSession" | "buildRemoteCommand" | "runRemoteCheck">): void {
  const { z, toToolResult, profiles, runtimeConfig, reloadEnvState, sessions, wireEncodingSchema, remoteCheckNameSchema, DEFAULT_REMOTE_CHECKS, REMOTE_CHECK_COMMANDS, registerTool, connectProfileSession, buildRemoteCommand, runRemoteCheck } = ctx;

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
      description: "Atomically reload runtime defaults and SSH profiles from the MCP .env file without restarting. Tool visibility still reflects startup settings and may require an MCP restart.",
      inputSchema: {},
    },
    async () =>
      toToolResult(async () => {
        const snapshot = reloadEnvState();
        return {
          ok: true,
          config: snapshot.config,
          profilesReloaded: snapshot.profiles.length,
          restartRequiredForToolVisibility: snapshot.restartRequiredForToolVisibility,
          note: "Runtime defaults and profiles were reloaded as one validated snapshot. If toolset or dangerous-tool visibility settings differ from startup, restart the MCP server to apply them.",
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
      description: "Atomically reload SSH profiles and runtime defaults from the MCP server .env file without restarting the MCP server.",
      inputSchema: {},
    },
    async () =>
      toToolResult(async () => {
        const snapshot = reloadEnvState();
        return {
          ok: true,
          envPath: profiles.sourcePath(),
          profiles: snapshot.profiles,
          runtimeConfigReloaded: true,
          restartRequiredForToolVisibility: snapshot.restartRequiredForToolVisibility,
        };
      }),
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
}
