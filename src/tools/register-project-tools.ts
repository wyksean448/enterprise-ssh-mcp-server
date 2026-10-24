import type { ToolContext } from "../app/tool-context.js";

export function registerProjectTools(ctx: Pick<ToolContext, "z" | "sftpStat" | "statsToJson" | "McpToolError" | "toToolResult" | "defaultTreeOptions" | "maxEditFileBytes" | "parseUnifiedPatch" | "publicSnapshot" | "readRemoteFileSnapshot" | "readRemoteTree" | "resolveSafeRemotePath" | "sha256" | "runtimeConfig" | "sessions" | "editHistory" | "projectRootSchema" | "fileEncodingSchema" | "expectedShaSchema" | "expectedFileSchema" | "projectPathSchema" | "registerTool" | "connectProjectWorkspace" | "inspectRemoteProject" | "projectProfileSummary" | "writeProjectFile" | "applySinglePatchFile" | "validateProjectPatch" | "applyProjectPatch" | "deleteProjectFile" | "moveProjectFile" | "rollbackEdit" | "resolveProjectPathArgs" | "assertPatchSize" | "compactTreeOptions" | "buildProjectSearchCommand" | "buildProjectDiffCommand" | "parseSearchMatches" | "normalizeProfileNameForHistory" | "buildRemoteCommand">): void {
  const { z, sftpStat, statsToJson, McpToolError, toToolResult, defaultTreeOptions, maxEditFileBytes, parseUnifiedPatch, publicSnapshot, readRemoteFileSnapshot, readRemoteTree, resolveSafeRemotePath, sha256, runtimeConfig, sessions, editHistory, projectRootSchema, fileEncodingSchema, expectedShaSchema, expectedFileSchema, projectPathSchema, registerTool, connectProjectWorkspace, inspectRemoteProject, projectProfileSummary, writeProjectFile, applySinglePatchFile, validateProjectPatch, applyProjectPatch, deleteProjectFile, moveProjectFile, rollbackEdit, resolveProjectPathArgs, assertPatchSize, compactTreeOptions, buildProjectSearchCommand, buildProjectDiffCommand, parseSearchMatches, normalizeProfileNameForHistory, buildRemoteCommand } = ctx;

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
}
