import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpToolError } from "./tool-result.js";
import { isInstaboxSshTokenTarget, parseSshTarget, redactSshUsername, validateSshHostname, type SshTarget } from "./ssh-target.js";

export interface OpenSshCommandInput {
  host: string;
  username?: string;
  usernameEnvVar?: string;
  /** One-shot InstaBox credential; the MCP client may log this tool argument. */
  ephemeralToken?: string;
  port: number;
  command: string;
  identityFile?: string;
  knownHostsPath?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface OpenSshCommandResult {
  host: string;
  port: number;
  username: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

function validateHost(host: string): void {
  validateSshHostname(host);
}

export function buildOpenSshArgs(input: OpenSshCommandInput, host: string, username: string): string[] {
  if (isInstaboxSshTokenTarget({ host, username })) {
    throw new McpToolError(
      "instabox_token_requires_temporary_config",
      "InstaBox token targets must use runOpenSshCommand's temporary config-file path so the bearer token is not exposed in the SSH process command line",
    );
  }

  const args = [
    "-p", String(input.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(input.timeoutMs / 1_000))}`,
    "-o", "ServerAliveInterval=10",
    "-o", "ServerAliveCountMax=3",
  ];

  if (input.knownHostsPath !== undefined) {
    args.push(
      "-o", `UserKnownHostsFile=${input.knownHostsPath}`,
      "-o", "GlobalKnownHostsFile=none",
    );
  }
  if (input.identityFile !== undefined) {
    args.push("-i", input.identityFile);
  }
  args.push(`${username}@${host}`, input.command);
  return args;
}

export function resolveOpenSshTarget(input: OpenSshCommandInput, environment: NodeJS.ProcessEnv = process.env): SshTarget {
  if (input.ephemeralToken !== undefined) {
    if (input.usernameEnvVar !== undefined || input.username !== undefined || input.host.includes("@")) {
      throw new McpToolError("ssh_target_username_conflict", "Choose exactly one username or token source");
    }
    if (input.host.toLowerCase().trim() !== "ssh.instabox.sh" || !/^ibssh_[A-Za-z0-9_-]+$/.test(input.ephemeralToken)) {
      throw new McpToolError("instabox_token_invalid", "One-shot InstaBox token or host is invalid");
    }
    return parseSshTarget({ host: input.host, username: input.ephemeralToken });
  }
  if (input.usernameEnvVar === undefined) {
    return parseSshTarget({ host: input.host, username: input.username });
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.usernameEnvVar)) {
    throw new McpToolError("invalid_argument", "usernameEnvVar must be a valid environment variable name", {
      field: "usernameEnvVar",
    });
  }
  if (input.username !== undefined || input.host.includes("@")) {
    throw new McpToolError(
      "ssh_target_username_conflict",
      "When usernameEnvVar is set, provide host without an embedded or separate username",
    );
  }

  const username = environment[input.usernameEnvVar];
  if (username === undefined || username.trim().length === 0) {
    throw new McpToolError("ssh_username_env_not_set", "The configured SSH username environment variable is not set", {
      variableName: input.usernameEnvVar,
    });
  }
  return parseSshTarget({ host: input.host, username });
}

/**
 * Run one command through the system OpenSSH client. Strict host-key checking
 * is mandatory, so an unknown/untrusted host is rejected before userauth.
 * This is a one-shot command path, not a persistent SSH session.
 */
export async function runOpenSshCommand(input: OpenSshCommandInput): Promise<OpenSshCommandResult> {
  const target = resolveOpenSshTarget(input);
  validateHost(target.host);

  if (input.command.trim().length === 0) {
    throw new McpToolError("invalid_argument", "Remote command must not be empty", { field: "command" });
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new McpToolError("invalid_argument", "SSH port must be 1-65535", { field: "port" });
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 86_400_000) {
    throw new McpToolError("invalid_argument", "SSH command timeout must be between 1ms and 24 hours", { field: "timeoutMs" });
  }
  if (!Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 64 * 1024 * 1024) {
    throw new McpToolError("invalid_argument", "SSH command output limit must be between 1 byte and 64 MiB", { field: "maxOutputBytes" });
  }
  if (isInstaboxSshTokenTarget(target) && input.identityFile !== undefined) {
    throw new McpToolError(
      "instabox_token_auth_conflict",
      "InstaBox SSH token authentication uses the username; do not attach a private-key file to this connection",
      { host: target.host, port: input.port },
    );
  }
  if (target.host.toLowerCase() === "ssh.instabox.sh") {
    if (input.usernameEnvVar === undefined && input.ephemeralToken === undefined) {
      throw new McpToolError(
        "instabox_token_env_required",
        "For InstaBox, use usernameEnvVar or an explicit one-shot ephemeralToken. MCP clients may log request arguments.",
      );
    }
    if (!/^ibssh_/i.test(target.username)) {
      throw new McpToolError(
        "instabox_token_invalid",
        "The configured InstaBox SSH token must use the expected ibssh_ token format",
      );
    }
  }

  let temporaryConfigDirectory: string | undefined;
  const start = Date.now();

  try {
    let args: string[];
    const needsIsolatedConfig = input.knownHostsPath !== undefined
      || input.usernameEnvVar !== undefined
      || input.ephemeralToken !== undefined
      || isInstaboxSshTokenTarget(target);

    if (needsIsolatedConfig) {
      // Keep environment-provided usernames/tokens out of process arguments.
      // An isolated config also prevents a user's SSH config (ProxyCommand,
      // HostName aliases, RemoteCommand, etc.) from changing temporary-trust
      // behavior. The file lives only for this child process invocation.
      temporaryConfigDirectory = await mkdtemp(join(tmpdir(), "ssh-mcp-openssh-"));
      const configPath = join(temporaryConfigDirectory, "config");
      const configLines = [
        `Host ${target.host}`,
        `  HostName ${target.host}`,
        `  User ${target.username}`,
        `  Port ${input.port}`,
      ];
      if (isInstaboxSshTokenTarget(target)) {
        configLines.push("  IdentitiesOnly yes", "  IdentityAgent none", "  PubkeyAuthentication no");
      }
      configLines.push("");
      await writeFile(configPath, configLines.join("\n"), { encoding: "utf8", mode: 0o600 });

      args = [
        "-F", configPath,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `ConnectTimeout=${Math.max(1, Math.ceil(input.timeoutMs / 1_000))}`,
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3",
      ];
      if (input.knownHostsPath !== undefined) {
        args.push("-o", `UserKnownHostsFile=${input.knownHostsPath}`, "-o", "GlobalKnownHostsFile=none");
      }
      if (input.identityFile !== undefined) {
        args.push("-i", input.identityFile);
      }
      args.push(target.host, input.command);
    } else {
      args = buildOpenSshArgs(input, target.host, target.username);
    }

    return await new Promise<OpenSshCommandResult>((resolve, reject) => {
    const windowsSshPath = join(process.env.WINDIR ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    const sshExecutable = process.platform !== "win32"
      ? "ssh"
      : existsSync(windowsSshPath) ? windowsSshPath : "ssh.exe";
    const child = spawn(sshExecutable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const finishError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new McpToolError("openssh_spawn_failed", "Could not start or run the system OpenSSH client", {
        host: target.host,
        port: input.port,
        username: redactSshUsername(target.username),
        errorCode: (error as NodeJS.ErrnoException).code ?? "unknown",
      }));
    };

    const capture = (destination: Buffer[], chunk: Buffer): void => {
      if (settled) {
        return;
      }
      const remaining = Math.max(0, input.maxOutputBytes - capturedBytes);
      const accepted = chunk.subarray(0, remaining);
      if (accepted.length > 0) {
        destination.push(accepted);
        capturedBytes += accepted.length;
      }
      if (accepted.length < chunk.length) {
        outputTruncated = true;
        child.kill();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.once("error", finishError);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const sanitize = (value: string): string => value.split(target.username).join(redactSshUsername(target.username));

      resolve({
        host: target.host,
        port: input.port,
        username: redactSshUsername(target.username),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - start,
        stdout: sanitize(stdout),
        stderr: sanitize(stderr),
        outputTruncated,
      });
    });
    });
  } finally {
    if (temporaryConfigDirectory !== undefined) {
      await rm(temporaryConfigDirectory, { recursive: true, force: true });
    }
  }
}
