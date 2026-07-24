import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/runtime-config.js";

describe("runtime config", () => {
  it("loads non-secret defaults from .env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-mcp-runtime-config-test-"));
    const envPath = join(tempDir, ".env");

    try {
      await writeFile(
        envPath,
        `
SSH_MCP_DEFAULT_KEEPALIVE_INTERVAL_MS=15000
SSH_MCP_TOOLSET=agent
SSH_MCP_COMPACT_JSON=true
SSH_MCP_ENABLE_DANGEROUS_TOOLS=false
SSH_MCP_DEFAULT_KEEPALIVE_COUNT_MAX=5
SSH_MCP_DEFAULT_EXEC_TIMEOUT_MS=120000
SSH_MCP_DEFAULT_MAX_OUTPUT_BYTES=2097152
SSH_MCP_DEFAULT_SHELL_ALLOCATE_PTY=false
SSH_MCP_DEFAULT_TRANSFER_CHUNK_SIZE_BYTES=4194304
SSH_MCP_DEFAULT_TRANSFER_RESUME=yes
SSH_MCP_DEFAULT_TRANSFER_OVERWRITE=no
SSH_MCP_DEFAULT_LOCAL_TUNNEL_HOST=localhost
`,
        "utf8",
      );

      expect(loadRuntimeConfig(envPath)).toMatchObject({
        toolset: "agent",
        compactJson: true,
        enableDangerousTools: false,
        defaultKeepaliveIntervalMs: 15_000,
        defaultKeepaliveCountMax: 5,
        defaultExecTimeoutMs: 120_000,
        defaultMaxOutputBytes: 2_097_152,
        defaultShellAllocatePty: false,
        defaultTransferChunkSizeBytes: 4_194_304,
        defaultTransferResume: true,
        defaultTransferOverwrite: false,
        defaultLocalTunnelHost: "localhost",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid configured ranges", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-mcp-runtime-config-test-"));
    const envPath = join(tempDir, ".env");

    try {
      await writeFile(envPath, "SSH_MCP_DEFAULT_TRANSFER_CHUNK_SIZE_BYTES=1", "utf8");

      expect(() => loadRuntimeConfig(envPath)).toThrow("outside the allowed range");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
