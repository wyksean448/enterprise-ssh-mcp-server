import { existsSync, readFileSync } from "node:fs";

import { parseEnvFile } from "./env-profiles.js";
import { McpToolError } from "./tool-result.js";

export interface RuntimeConfig {
  envPath: string;
  toolset: Toolset;
  compactJson: boolean;
  enableDangerousTools: boolean;
  defaultSshPort: number;
  defaultAgentForward: boolean;
  defaultTryKeyboard: boolean;
  defaultKeepaliveIntervalMs: number;
  defaultKeepaliveCountMax: number;
  defaultReadyTimeoutMs: number;
  defaultConnectionTimeoutMs: number;
  defaultExecTimeoutMs: number;
  defaultMaxOutputBytes: number;
  defaultShellAllocatePty: boolean;
  defaultShellRingBufferBytes: number;
  defaultShellReadMaxBytes: number;
  defaultSftpReadMaxBytes: number;
  defaultTransferChunkSizeBytes: number;
  defaultTransferResume: boolean;
  defaultTransferOverwrite: boolean;
  defaultTransferAtomic: boolean;
  defaultLocalTunnelHost: string;
  defaultRemoteTunnelHost: string;
}

export type Toolset = "agent" | "full";

const DEFAULT_CONFIG: Omit<RuntimeConfig, "envPath"> = {
  toolset: "agent",
  compactJson: true,
  enableDangerousTools: false,
  defaultSshPort: 22,
  defaultAgentForward: false,
  defaultTryKeyboard: false,
  defaultKeepaliveIntervalMs: 10_000,
  defaultKeepaliveCountMax: 3,
  defaultReadyTimeoutMs: 20_000,
  defaultConnectionTimeoutMs: 30_000,
  defaultExecTimeoutMs: 60_000,
  defaultMaxOutputBytes: 1024 * 1024,
  defaultShellAllocatePty: true,
  defaultShellRingBufferBytes: 1024 * 1024,
  defaultShellReadMaxBytes: 256 * 1024,
  defaultSftpReadMaxBytes: 1024 * 1024,
  defaultTransferChunkSizeBytes: 1024 * 1024,
  defaultTransferResume: true,
  defaultTransferOverwrite: false,
  defaultTransferAtomic: false,
  defaultLocalTunnelHost: "127.0.0.1",
  defaultRemoteTunnelHost: "127.0.0.1",
};

export class RuntimeConfigRegistry {
  private readonly envPath: string;
  private config: RuntimeConfig;

  public constructor(envPath: string) {
    this.envPath = envPath;
    this.config = loadRuntimeConfig(envPath);
  }

  public get(): RuntimeConfig {
    return this.config;
  }

  public reload(): RuntimeConfig {
    this.config = loadRuntimeConfig(this.envPath);
    return this.config;
  }
}

export function loadRuntimeConfig(envPath: string): RuntimeConfig {
  const variables = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : new Map<string, string>();

  return {
    envPath,
    toolset: readToolset(variables, "SSH_MCP_TOOLSET", DEFAULT_CONFIG.toolset),
    compactJson: readBoolean(variables, "SSH_MCP_COMPACT_JSON", DEFAULT_CONFIG.compactJson),
    enableDangerousTools: readBoolean(
      variables,
      "SSH_MCP_ENABLE_DANGEROUS_TOOLS",
      DEFAULT_CONFIG.enableDangerousTools,
    ),
    defaultSshPort: readInteger(variables, "SSH_MCP_DEFAULT_SSH_PORT", DEFAULT_CONFIG.defaultSshPort, 1, 65_535),
    defaultAgentForward: readBoolean(
      variables,
      "SSH_MCP_DEFAULT_AGENT_FORWARD",
      DEFAULT_CONFIG.defaultAgentForward,
    ),
    defaultTryKeyboard: readBoolean(variables, "SSH_MCP_DEFAULT_TRY_KEYBOARD", DEFAULT_CONFIG.defaultTryKeyboard),
    defaultKeepaliveIntervalMs: readInteger(
      variables,
      "SSH_MCP_DEFAULT_KEEPALIVE_INTERVAL_MS",
      DEFAULT_CONFIG.defaultKeepaliveIntervalMs,
      0,
      3_600_000,
    ),
    defaultKeepaliveCountMax: readInteger(
      variables,
      "SSH_MCP_DEFAULT_KEEPALIVE_COUNT_MAX",
      DEFAULT_CONFIG.defaultKeepaliveCountMax,
      1,
      100,
    ),
    defaultReadyTimeoutMs: readInteger(
      variables,
      "SSH_MCP_DEFAULT_READY_TIMEOUT_MS",
      DEFAULT_CONFIG.defaultReadyTimeoutMs,
      1_000,
      3_600_000,
    ),
    defaultConnectionTimeoutMs: readInteger(
      variables,
      "SSH_MCP_DEFAULT_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONFIG.defaultConnectionTimeoutMs,
      1_000,
      3_600_000,
    ),
    defaultExecTimeoutMs: readInteger(
      variables,
      "SSH_MCP_DEFAULT_EXEC_TIMEOUT_MS",
      DEFAULT_CONFIG.defaultExecTimeoutMs,
      1,
      86_400_000,
    ),
    defaultMaxOutputBytes: readInteger(
      variables,
      "SSH_MCP_DEFAULT_MAX_OUTPUT_BYTES",
      DEFAULT_CONFIG.defaultMaxOutputBytes,
      1,
      64 * 1024 * 1024,
    ),
    defaultShellAllocatePty: readBoolean(
      variables,
      "SSH_MCP_DEFAULT_SHELL_ALLOCATE_PTY",
      DEFAULT_CONFIG.defaultShellAllocatePty,
    ),
    defaultShellRingBufferBytes: readInteger(
      variables,
      "SSH_MCP_DEFAULT_SHELL_RING_BUFFER_BYTES",
      DEFAULT_CONFIG.defaultShellRingBufferBytes,
      1024,
      64 * 1024 * 1024,
    ),
    defaultShellReadMaxBytes: readInteger(
      variables,
      "SSH_MCP_DEFAULT_SHELL_READ_MAX_BYTES",
      DEFAULT_CONFIG.defaultShellReadMaxBytes,
      1,
      64 * 1024 * 1024,
    ),
    defaultSftpReadMaxBytes: readInteger(
      variables,
      "SSH_MCP_DEFAULT_SFTP_READ_MAX_BYTES",
      DEFAULT_CONFIG.defaultSftpReadMaxBytes,
      1,
      64 * 1024 * 1024,
    ),
    defaultTransferChunkSizeBytes: readInteger(
      variables,
      "SSH_MCP_DEFAULT_TRANSFER_CHUNK_SIZE_BYTES",
      DEFAULT_CONFIG.defaultTransferChunkSizeBytes,
      16 * 1024,
      16 * 1024 * 1024,
    ),
    defaultTransferResume: readBoolean(
      variables,
      "SSH_MCP_DEFAULT_TRANSFER_RESUME",
      DEFAULT_CONFIG.defaultTransferResume,
    ),
    defaultTransferOverwrite: readBoolean(
      variables,
      "SSH_MCP_DEFAULT_TRANSFER_OVERWRITE",
      DEFAULT_CONFIG.defaultTransferOverwrite,
    ),
    defaultTransferAtomic: readBoolean(
      variables,
      "SSH_MCP_DEFAULT_TRANSFER_ATOMIC",
      DEFAULT_CONFIG.defaultTransferAtomic,
    ),
    defaultLocalTunnelHost: readString(
      variables,
      "SSH_MCP_DEFAULT_LOCAL_TUNNEL_HOST",
      DEFAULT_CONFIG.defaultLocalTunnelHost,
    ),
    defaultRemoteTunnelHost: readString(
      variables,
      "SSH_MCP_DEFAULT_REMOTE_TUNNEL_HOST",
      DEFAULT_CONFIG.defaultRemoteTunnelHost,
    ),
  };
}

function readString(variables: Map<string, string>, key: string, fallback: string): string {
  const value = variables.get(key);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function readToolset(variables: Map<string, string>, key: string, fallback: Toolset): Toolset {
  const value = variables.get(key);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "agent" || normalized === "full") {
    return normalized;
  }

  throw new McpToolError("invalid_runtime_config", "Runtime config value must be a supported toolset", {
    key,
    value,
    supportedToolsets: ["agent", "full"],
  });
}

function readInteger(
  variables: Map<string, string>,
  key: string,
  fallback: number,
  minInclusive: number,
  maxInclusive: number,
): number {
  const value = variables.get(key);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new McpToolError("invalid_runtime_config", "Runtime config value must be an integer", { key, value });
  }
  if (parsed < minInclusive || parsed > maxInclusive) {
    throw new McpToolError("invalid_runtime_config", "Runtime config value is outside the allowed range", {
      key,
      value,
      minInclusive,
      maxInclusive,
    });
  }
  return parsed;
}

function readBoolean(variables: Map<string, string>, key: string, fallback: boolean): boolean {
  const value = variables.get(key);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new McpToolError("invalid_runtime_config", "Runtime config value must be boolean-like", { key, value });
}
