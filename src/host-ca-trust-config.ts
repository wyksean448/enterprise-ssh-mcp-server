import { McpToolError } from "./tool-result.js";

export const TRUSTED_HOST_CA_FINGERPRINTS_ENV = "SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS";

const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function hostCaTrustKey(host: string, port: number): string {
  const normalizedHost = host.trim().toLowerCase();
  const hostPart = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `${hostPart}:${port}`;
}

/**
 * Read a user-pinned host CA fingerprint from the local MCP process environment.
 * Tool arguments must never be allowed to supply the trust anchor themselves.
 *
 * Example:
 * SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS={"ssh.instabox.sh:2222":"SHA256:..."}
 */
export function getTrustedHostCaFingerprint(
  host: string,
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const raw = environment[TRUSTED_HOST_CA_FINGERPRINTS_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    throw new McpToolError(
      "ssh_host_ca_not_configured",
      `No trusted host CA fingerprint is configured. Set ${TRUSTED_HOST_CA_FINGERPRINTS_ENV} in the local MCP client environment using a fingerprint verified through an independent trusted source.`,
      { host, port, environmentVariable: TRUSTED_HOST_CA_FINGERPRINTS_ENV },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpToolError(
      "ssh_host_ca_config_invalid",
      `${TRUSTED_HOST_CA_FINGERPRINTS_ENV} must contain a JSON object mapping host:port to SHA256 fingerprints`,
      { environmentVariable: TRUSTED_HOST_CA_FINGERPRINTS_ENV },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpToolError(
      "ssh_host_ca_config_invalid",
      `${TRUSTED_HOST_CA_FINGERPRINTS_ENV} must contain a JSON object mapping host:port to SHA256 fingerprints`,
      { environmentVariable: TRUSTED_HOST_CA_FINGERPRINTS_ENV },
    );
  }

  const key = hostCaTrustKey(host, port);
  const value = (parsed as Record<string, unknown>)[key];
  if (value === undefined) {
    throw new McpToolError(
      "ssh_host_ca_not_configured",
      `No pinned CA fingerprint is configured for ${key}. Add it to ${TRUSTED_HOST_CA_FINGERPRINTS_ENV} only after independently verifying the fingerprint.`,
      { host, port, configKey: key, environmentVariable: TRUSTED_HOST_CA_FINGERPRINTS_ENV },
    );
  }
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new McpToolError(
      "ssh_host_ca_config_invalid",
      `The pinned CA fingerprint for ${key} must be a complete SHA256:<base64> fingerprint`,
      { host, port, configKey: key, environmentVariable: TRUSTED_HOST_CA_FINGERPRINTS_ENV },
    );
  }

  return value;
}
