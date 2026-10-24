import type { ToolContext } from "../app/tool-context.js";

export function registerSftpTools(ctx: Pick<ToolContext, "z" | "entryToJson" | "sftpChmod" | "sftpChown" | "sftpMkdir" | "sftpMkdirRecursive" | "sftpReadFileLimited" | "sftpReadDir" | "sftpReadlink" | "sftpRealpath" | "sftpRemove" | "sftpRename" | "sftpStat" | "sftpSymlink" | "sftpUtimes" | "sftpWriteFile" | "statsToJson" | "toToolResult" | "runtimeConfig" | "sessions" | "sessionIdSchema" | "wireEncodingSchema" | "modeSchema" | "registerTool">): void {
  const { z, entryToJson, sftpChmod, sftpChown, sftpMkdir, sftpMkdirRecursive, sftpReadFileLimited, sftpReadDir, sftpReadlink, sftpRealpath, sftpRemove, sftpRename, sftpStat, sftpSymlink, sftpUtimes, sftpWriteFile, statsToJson, toToolResult, runtimeConfig, sessions, sessionIdSchema, wireEncodingSchema, modeSchema, registerTool } = ctx;

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
}
