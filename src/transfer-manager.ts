import { createReadStream, createWriteStream, type ReadStream as LocalReadStream, type WriteStream as LocalWriteStream } from "node:fs";
import { mkdir, rename as renameLocal, stat as statLocal } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  SFTPWrapper,
  WriteStream as RemoteWriteStream,
  ReadStream as RemoteReadStream,
  WriteStreamOptions,
} from "ssh2";

import { isMissingPathError, sftpRename, sftpStat } from "./sftp-ops.js";
import type { SshSession } from "./ssh-session.js";
import { McpToolError } from "./tool-result.js";

export type TransferKind = "upload" | "download";
export type TransferState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface UploadStartInput {
  sessionId: string;
  localPath: string;
  remotePath: string;
  resume: boolean;
  overwrite: boolean;
  atomic: boolean;
  remoteTempPath?: string;
  mode?: number;
  chunkSizeBytes: number;
}

export interface DownloadStartInput {
  sessionId: string;
  remotePath: string;
  localPath: string;
  resume: boolean;
  overwrite: boolean;
  atomic: boolean;
  localTempPath?: string;
  chunkSizeBytes: number;
}

export interface TransferSummary {
  id: string;
  sessionId: string;
  kind: TransferKind;
  state: TransferState;
  localPath: string;
  remotePath: string;
  totalBytes: number;
  transferredBytes: number;
  resumeOffsetBytes: number;
  percent: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  atomic: boolean;
  tempPath?: string;
}

interface TransferJob {
  id: string;
  sessionId: string;
  kind: TransferKind;
  state: TransferState;
  localPath: string;
  remotePath: string;
  totalBytes: number;
  transferredBytes: number;
  resumeOffsetBytes: number;
  createdAt: string;
  updatedAt: string;
  atomic: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  tempPath?: string;
  cancelRequested: boolean;
  localStream?: LocalReadStream | LocalWriteStream;
  remoteStream?: RemoteReadStream | RemoteWriteStream;
}

export class TransferManager {
  private readonly jobs = new Map<string, TransferJob>();

  public startUpload(session: SshSession, input: UploadStartInput): TransferSummary {
    const job = createBaseJob(input.sessionId, "upload", resolve(input.localPath), input.remotePath, input.atomic);
    if (input.remoteTempPath !== undefined) {
      job.tempPath = input.remoteTempPath;
    }
    this.jobs.set(job.id, job);
    void this.runUpload(session, input, job);
    return summarizeJob(job);
  }

  public startDownload(session: SshSession, input: DownloadStartInput): TransferSummary {
    const job = createBaseJob(input.sessionId, "download", resolve(input.localPath), input.remotePath, input.atomic);
    if (input.localTempPath !== undefined) {
      job.tempPath = resolve(input.localTempPath);
    }
    this.jobs.set(job.id, job);
    void this.runDownload(session, input, job);
    return summarizeJob(job);
  }

  public get(transferId: string): TransferSummary {
    return summarizeJob(this.getJob(transferId));
  }

  public list(sessionId?: string): TransferSummary[] {
    return [...this.jobs.values()]
      .filter((job) => sessionId === undefined || job.sessionId === sessionId)
      .map((job) => summarizeJob(job));
  }

  public cancel(transferId: string): TransferSummary {
    const job = this.getJob(transferId);
    if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
      return summarizeJob(job);
    }

    job.cancelRequested = true;
    job.state = "cancelled";
    job.updatedAt = new Date().toISOString();
    job.localStream?.destroy();
    job.remoteStream?.destroy();
    return summarizeJob(job);
  }

  private async runUpload(session: SshSession, input: UploadStartInput, job: TransferJob): Promise<void> {
    try {
      this.markRunning(job);
      const sftp = await session.getSftp();
      const localStats = await statLocal(job.localPath);
      if (!localStats.isFile()) {
        throw new McpToolError("local_path_not_file", "Local upload path is not a file", { localPath: job.localPath });
      }

      job.totalBytes = localStats.size;
      const targetRemotePath = input.atomic ? job.tempPath ?? `${input.remotePath}.mcp-uploading` : input.remotePath;
      if (input.atomic) {
        job.tempPath = targetRemotePath;
      }
      const resumeOffset = await resolveRemoteResumeOffset(sftp, targetRemotePath, input.remotePath, localStats.size, input);
      job.resumeOffsetBytes = resumeOffset;
      job.transferredBytes = resumeOffset;
      job.updatedAt = new Date().toISOString();

      if (job.cancelRequested) {
        this.markCancelled(job);
        return;
      }

      const localStream = createReadStream(job.localPath, {
        start: resumeOffset,
        highWaterMark: input.chunkSizeBytes,
      });
      const flags = resumeOffset > 0 ? "r+" : "w";
      const writeOptions: WriteStreamOptions =
        input.mode === undefined
          ? {
              flags,
              start: resumeOffset,
              highWaterMark: input.chunkSizeBytes,
            }
          : {
              flags,
              start: resumeOffset,
              mode: input.mode,
              highWaterMark: input.chunkSizeBytes,
            };
      const remoteStream = sftp.createWriteStream(targetRemotePath, writeOptions);
      job.localStream = localStream;
      job.remoteStream = remoteStream;
      localStream.on("data", (chunk: Buffer | string) => {
        job.transferredBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        job.updatedAt = new Date().toISOString();
      });

      await pipeline(localStream, remoteStream);

      if (job.cancelRequested) {
        this.markCancelled(job);
        return;
      }

      if (input.atomic) {
        await ensureRemoteOverwritePolicy(sftp, input.remotePath, input.overwrite);
        await sftpRename(sftp, targetRemotePath, input.remotePath);
      }

      this.markCompleted(job);
    } catch (error) {
      this.markFailedOrCancelled(job, error);
    } finally {
      delete job.localStream;
      delete job.remoteStream;
    }
  }

  private async runDownload(session: SshSession, input: DownloadStartInput, job: TransferJob): Promise<void> {
    try {
      this.markRunning(job);
      const sftp = await session.getSftp();
      const remoteStats = await sftpStat(sftp, input.remotePath, true);
      if (!remoteStats.isFile()) {
        throw new McpToolError("remote_path_not_file", "Remote download path is not a file", {
          remotePath: input.remotePath,
        });
      }

      const targetLocalPath = input.atomic ? job.tempPath ?? `${job.localPath}.mcp-downloading` : job.localPath;
      if (input.atomic) {
        job.tempPath = targetLocalPath;
      }
      await mkdir(dirname(targetLocalPath), { recursive: true });
      job.totalBytes = remoteStats.size;
      const resumeOffset = await resolveLocalResumeOffset(targetLocalPath, remoteStats.size, input);
      job.resumeOffsetBytes = resumeOffset;
      job.transferredBytes = resumeOffset;
      job.updatedAt = new Date().toISOString();

      if (job.cancelRequested) {
        this.markCancelled(job);
        return;
      }

      const remoteStream = sftp.createReadStream(input.remotePath, {
        start: resumeOffset,
        highWaterMark: input.chunkSizeBytes,
      });
      const localStream = createWriteStream(targetLocalPath, {
        flags: resumeOffset > 0 ? "r+" : "w",
        start: resumeOffset,
        highWaterMark: input.chunkSizeBytes,
      });
      job.localStream = localStream;
      job.remoteStream = remoteStream;
      remoteStream.on("data", (chunk: Buffer | string) => {
        job.transferredBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        job.updatedAt = new Date().toISOString();
      });

      await pipeline(remoteStream, localStream);

      if (job.cancelRequested) {
        this.markCancelled(job);
        return;
      }

      if (input.atomic) {
        await ensureLocalOverwritePolicy(job.localPath, input.overwrite);
        await renameLocal(targetLocalPath, job.localPath);
      }

      this.markCompleted(job);
    } catch (error) {
      this.markFailedOrCancelled(job, error);
    } finally {
      delete job.localStream;
      delete job.remoteStream;
    }
  }

  private getJob(transferId: string): TransferJob {
    const job = this.jobs.get(transferId);
    if (job === undefined) {
      throw new McpToolError("transfer_not_found", "Transfer job id was not found", { transferId });
    }
    return job;
  }

  private markRunning(job: TransferJob): void {
    job.state = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
  }

  private markCompleted(job: TransferJob): void {
    job.state = "completed";
    job.transferredBytes = job.totalBytes;
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
  }

  private markCancelled(job: TransferJob): void {
    job.state = "cancelled";
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
  }

  private markFailedOrCancelled(job: TransferJob, error: Error): void {
    if (job.cancelRequested || job.state === "cancelled") {
      this.markCancelled(job);
      return;
    }

    job.state = "failed";
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
  }
}

async function resolveRemoteResumeOffset(
  sftp: SFTPWrapper,
  targetRemotePath: string,
  finalRemotePath: string,
  localSize: number,
  input: UploadStartInput,
): Promise<number> {
  if (!input.resume) {
    await ensureRemoteOverwritePolicy(sftp, input.atomic ? finalRemotePath : targetRemotePath, input.overwrite);
    return 0;
  }

  if (input.atomic) {
    await ensureRemoteOverwritePolicy(sftp, finalRemotePath, input.overwrite);
  }

  try {
    const stats = await sftpStat(sftp, targetRemotePath, true);
    if (stats.size > localSize) {
      throw new McpToolError("remote_file_larger_than_local", "Remote file is larger than the local upload source", {
        remotePath: targetRemotePath,
        remoteBytes: stats.size,
        localBytes: localSize,
      });
    }
    return stats.size;
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }
}

async function resolveLocalResumeOffset(localPath: string, remoteSize: number, input: DownloadStartInput): Promise<number> {
  if (!input.resume) {
    await ensureLocalOverwritePolicy(localPath, input.overwrite);
    return 0;
  }

  try {
    const stats = await statLocal(localPath);
    if (stats.size > remoteSize) {
      throw new McpToolError("local_file_larger_than_remote", "Local file is larger than the remote download source", {
        localPath,
        localBytes: stats.size,
        remoteBytes: remoteSize,
      });
    }
    return stats.size;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function ensureRemoteOverwritePolicy(sftp: SFTPWrapper, remotePath: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    return;
  }

  try {
    await sftpStat(sftp, remotePath, true);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  throw new McpToolError("remote_path_exists", "Remote path exists and overwrite=false", { remotePath });
}

async function ensureLocalOverwritePolicy(localPath: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    return;
  }

  try {
    await statLocal(localPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new McpToolError("local_path_exists", "Local path exists and overwrite=false", { localPath });
}

function createBaseJob(
  sessionId: string,
  kind: TransferKind,
  localPath: string,
  remotePath: string,
  atomic: boolean,
): TransferJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    sessionId,
    kind,
    state: "queued",
    localPath,
    remotePath,
    totalBytes: 0,
    transferredBytes: 0,
    resumeOffsetBytes: 0,
    createdAt: now,
    updatedAt: now,
    atomic,
    cancelRequested: false,
  };
}

function summarizeJob(job: TransferJob): TransferSummary {
  const elapsedSeconds = job.startedAt === undefined ? 0 : Math.max((Date.now() - Date.parse(job.startedAt)) / 1_000, 0.001);
  const bytesThisRun = Math.max(job.transferredBytes - job.resumeOffsetBytes, 0);
  const bytesPerSecond = job.state === "running" ? Math.round(bytesThisRun / elapsedSeconds) : 0;
  const remainingBytes = Math.max(job.totalBytes - job.transferredBytes, 0);
  const summary: TransferSummary = {
    id: job.id,
    sessionId: job.sessionId,
    kind: job.kind,
    state: job.state,
    localPath: job.localPath,
    remotePath: job.remotePath,
    totalBytes: job.totalBytes,
    transferredBytes: job.transferredBytes,
    resumeOffsetBytes: job.resumeOffsetBytes,
    percent: job.totalBytes === 0 ? 0 : Number(((job.transferredBytes / job.totalBytes) * 100).toFixed(2)),
    bytesPerSecond,
    etaSeconds: bytesPerSecond > 0 ? Math.ceil(remainingBytes / bytesPerSecond) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    atomic: job.atomic,
  };

  if (job.startedAt !== undefined) {
    summary.startedAt = job.startedAt;
  }
  if (job.finishedAt !== undefined) {
    summary.finishedAt = job.finishedAt;
  }
  if (job.error !== undefined) {
    summary.error = job.error;
  }
  if (job.tempPath !== undefined) {
    summary.tempPath = job.tempPath;
  }
  return summary;
}
