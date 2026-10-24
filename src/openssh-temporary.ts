import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeSshHostKey } from "./ssh-host-key.js";
import { resolveOpenSshTarget, runOpenSshCommand, type OpenSshCommandResult } from "./openssh-command.js";
import { getTrustedHostCaFingerprint } from "./host-ca-trust-config.js";
import { isInstaboxSshTokenTarget } from "./ssh-target.js";
import { McpToolError } from "./tool-result.js";

export interface TemporaryOpenSshCommandInput {
  host: string;
  username?: string;
  usernameEnvVar?: string;
  port: number;
  command: string;
  identityFile?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface TemporaryOpenSshCommandResult extends OpenSshCommandResult {
  trustMode: "temporary-host-ca";
  trustStoreDeleted: true;
  verifiedFingerprint: string;
}

/**
 * Run a one-shot OpenSSH command using a private, temporary known_hosts file.
 * The host CA must be pinned in the local MCP process environment using
 * SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS. Tool arguments cannot supply or
 * override the trust anchor. The trust file is deleted in a finally block.
 */
export async function runOpenSshCommandWithTemporaryHostCa(
  input: TemporaryOpenSshCommandInput,
): Promise<TemporaryOpenSshCommandResult> {
  // Parse and validate the target (including resolving a local username env
  // var) before any network probe. This prevents malformed hosts reaching
  // ssh-keyscan and avoids probing a host when the local credential is absent.
  const target = resolveOpenSshTarget(input);
  const host = target.host;
  if (host.toLowerCase() === "ssh.instabox.sh") {
    if (input.usernameEnvVar === undefined) {
      throw new McpToolError(
        "instabox_token_env_required",
        "For InstaBox, read the SSH token from the local MCP process environment via usernameEnvVar; do not pass the bearer token in tool arguments",
      );
    }
    if (!isInstaboxSshTokenTarget(target)) {
      throw new McpToolError(
        "instabox_token_invalid",
        "The configured InstaBox SSH token must use the expected ibssh_ token format",
      );
    }
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
  if (input.command.trim().length === 0) {
    throw new McpToolError("invalid_argument", "Remote command must not be empty", { field: "command" });
  }
  const expectedHostCaFingerprint = getTrustedHostCaFingerprint(host, input.port);
  const probe = await probeSshHostKey({ host, port: input.port, timeoutMs: Math.min(input.timeoutMs, 30_000) });
  const ca = probe.certificateAuthority;
  if (ca === undefined) {
    throw new McpToolError(
      "ssh_host_ca_missing",
      "This endpoint did not present an OpenSSH host certificate. Temporary CA trust mode only supports host-certificate endpoints.",
      { host, port: input.port, observedKeyType: probe.keyType },
    );
  }
  if (
    ca.fingerprint !== expectedHostCaFingerprint
  ) {
    throw new McpToolError(
      "ssh_host_ca_fingerprint_mismatch",
      "The live host CA fingerprint does not match the fingerprint pinned in the local MCP configuration",
      {
        host,
        port: input.port,
        observedFingerprint: ca.fingerprint,
        configuredFingerprint: expectedHostCaFingerprint,
      },
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ssh-mcp-temporary-trust-"));
  const knownHostsPath = join(temporaryDirectory, "known_hosts");
  try {
    await writeFile(knownHostsPath, `${ca.knownHostsEntry}\n`, { encoding: "utf8", mode: 0o600 });
    const result = await runOpenSshCommand({
      host: input.host,
      port: input.port,
      command: input.command,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      knownHostsPath,
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.usernameEnvVar === undefined ? {} : { usernameEnvVar: input.usernameEnvVar }),
      ...(input.identityFile === undefined ? {} : { identityFile: input.identityFile }),
    });
    return {
      ...result,
      trustMode: "temporary-host-ca",
      trustStoreDeleted: true,
      verifiedFingerprint: ca.fingerprint,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
