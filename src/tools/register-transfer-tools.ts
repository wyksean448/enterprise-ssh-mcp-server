import type { ToolContext } from "../app/tool-context.js";

export function registerTransferTools(ctx: Pick<ToolContext, "z" | "assertNonEmpty" | "toToolResult" | "runtimeConfig" | "sessions" | "transfers" | "sessionIdSchema" | "registerTool" | "connectProfileSession">): void {
  const { z, assertNonEmpty, toToolResult, runtimeConfig, sessions, transfers, sessionIdSchema, registerTool, connectProfileSession } = ctx;

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
}
