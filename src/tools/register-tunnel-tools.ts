import type { ToolContext } from "../app/tool-context.js";

export function registerTunnelTools(ctx: Pick<ToolContext, "z" | "toToolResult" | "runtimeConfig" | "sessions" | "sessionIdSchema" | "positivePortSchema" | "registerTool">): void {
  const { z, toToolResult, runtimeConfig, sessions, sessionIdSchema, positivePortSchema, registerTool } = ctx;

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
}
