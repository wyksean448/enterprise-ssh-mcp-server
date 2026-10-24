import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { fingerprintSshHostKey } from "./ssh-host-key.js";
import { getTrustedHostCaFingerprint } from "./host-ca-trust-config.js";
import { McpToolError } from "./tool-result.js";

export interface TrustOpenSshHostCaInput {
  host: string;
  port: number;
  knownHostsEntry: string;
  knownHostsPath?: string;
}

export interface TrustOpenSshHostCaResult {
  host: string;
  port: number;
  fingerprint: string;
  knownHostsPath: string;
  added: boolean;
  alreadyTrusted: boolean;
}

export async function trustOpenSshHostCa(input: TrustOpenSshHostCaInput): Promise<TrustOpenSshHostCaResult> {
  if (
    input.host.length === 0
    || input.host.startsWith("-")
    || /\s/.test(input.host)
    || input.host.includes("@")
    || input.host.includes("/")
    || input.host.includes("\\")
    || input.host.includes("://")
  ) {
    throw new McpToolError("ssh_host_ca_invalid", "Provide a hostname/IP without a username, URL scheme, path, or whitespace", {
      field: "host",
    });
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new McpToolError("ssh_host_ca_invalid", "SSH port must be 1-65535", { field: "port" });
  }
  if (input.knownHostsEntry.includes("\n") || input.knownHostsEntry.includes("\r")) {
    throw new McpToolError("ssh_host_ca_invalid", "knownHostsEntry must contain exactly one line");
  }

  const fields = input.knownHostsEntry.trim().split(/\s+/);
  const hostPattern = input.port === 22 ? input.host : `[${input.host}]:${input.port}`;
  if (
    fields.length !== 4
    || fields[0] !== "@cert-authority"
    || fields[1] !== hostPattern
  ) {
    throw new McpToolError(
      "ssh_host_ca_invalid",
      "knownHostsEntry must be a single @cert-authority line for the specified host and port",
      { hostPattern },
    );
  }

  const keyBlob = Buffer.from(fields[3] as string, "base64");
  if (keyBlob.length === 0 || keyBlob.toString("base64").replace(/=+$/, "") !== (fields[3] as string).replace(/=+$/, "")) {
    throw new McpToolError("ssh_host_ca_invalid", "CA public key is not valid canonical base64");
  }
  const keyFingerprint = fingerprintSshHostKey(keyBlob);
  if (keyFingerprint.keyType !== fields[2]) {
    throw new McpToolError("ssh_host_ca_invalid", "CA key type does not match the supplied public key blob");
  }
  const trustedFingerprint = getTrustedHostCaFingerprint(input.host, input.port);
  if (trustedFingerprint !== keyFingerprint.fingerprint) {
    throw new McpToolError(
      "ssh_host_ca_fingerprint_mismatch",
      "The CA public key in knownHostsEntry does not match the fingerprint pinned in the local MCP configuration",
      { observedFingerprint: keyFingerprint.fingerprint, configuredFingerprint: trustedFingerprint },
    );
  }

  const knownHostsPath = input.knownHostsPath ?? join(homedir(), ".ssh", "known_hosts");
  const entry = input.knownHostsEntry.trim();
  let existing = "";
  try {
    existing = await readFile(knownHostsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new McpToolError("ssh_host_ca_store_read_failed", "Could not read the OpenSSH known_hosts file", {
        knownHostsPath,
      });
    }
  }

  const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sameHostCaLines = lines.filter((line) => line.startsWith(`@cert-authority ${hostPattern} `));
  if (sameHostCaLines.includes(entry)) {
    return {
      host: input.host,
      port: input.port,
      fingerprint: keyFingerprint.fingerprint,
      knownHostsPath,
      added: false,
      alreadyTrusted: true,
    };
  }
  if (sameHostCaLines.length > 0) {
    throw new McpToolError(
      "ssh_host_ca_conflict",
      "A different @cert-authority entry already exists for this host and port; refusing to add a second CA automatically",
      { host: input.host, port: input.port, knownHostsPath },
    );
  }

  await mkdir(dirname(knownHostsPath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    await appendFile(knownHostsPath, `${prefix}${entry}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    throw new McpToolError("ssh_host_ca_store_write_failed", "Could not append the confirmed CA entry to known_hosts", {
      knownHostsPath,
    });
  }

  return {
    host: input.host,
    port: input.port,
    fingerprint: keyFingerprint.fingerprint,
    knownHostsPath,
    added: true,
    alreadyTrusted: false,
  };
}
