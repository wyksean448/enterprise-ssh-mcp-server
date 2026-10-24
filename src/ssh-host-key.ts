import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "ssh2";

import { McpToolError } from "./tool-result.js";
import { validateSshHostname } from "./ssh-target.js";

export interface SshHostKeyFingerprint {
  keyType: string;
  fingerprint: string;
  sha256Hex: string;
  ssh2Compatible: boolean;
  certificateAuthority?: {
    keyType: string;
    fingerprint: string;
    sha256Hex: string;
    knownHostsEntry: string;
  };
}

export interface ProbeSshHostKeyInput {
  host: string;
  port: number;
  timeoutMs: number;
}

export function fingerprintSshHostKey(key: Buffer): SshHostKeyFingerprint {
  if (key.length < 4) {
    throw new McpToolError("ssh_host_key_invalid", "SSH host key blob is too short");
  }

  const typeLength = key.readUInt32BE(0);
  if (typeLength < 1 || typeLength > key.length - 4) {
    throw new McpToolError("ssh_host_key_invalid", "SSH host key blob has an invalid key type");
  }

  const keyType = key.subarray(4, 4 + typeLength).toString("utf8");
  const digest = createHash("sha256").update(key).digest();
  return {
    keyType,
    fingerprint: `SHA256:${digest.toString("base64").replace(/=+$/, "")}`,
    sha256Hex: digest.toString("hex"),
    ssh2Compatible: !keyType.endsWith("-cert-v01@openssh.com"),
  };
}

interface SshString {
  value: Buffer;
  nextOffset: number;
}

function readSshString(buffer: Buffer, offset: number): SshString {
  if (offset + 4 > buffer.length) {
    throw new McpToolError("ssh_host_certificate_invalid", "SSH host certificate is truncated");
  }
  const length = buffer.readUInt32BE(offset);
  const valueStart = offset + 4;
  const nextOffset = valueStart + length;
  if (nextOffset > buffer.length) {
    throw new McpToolError("ssh_host_certificate_invalid", "SSH host certificate contains an invalid field length");
  }
  return { value: buffer.subarray(valueStart, nextOffset), nextOffset };
}

function skipSshString(buffer: Buffer, offset: number): number {
  return readSshString(buffer, offset).nextOffset;
}

/** Extract the signing CA public key from an OpenSSH host certificate. */
export function extractCertificateAuthorityKey(certificate: Buffer): Buffer | undefined {
  const typeField = readSshString(certificate, 0);
  const certificateType = typeField.value.toString("utf8");
  const suffix = "-cert-v01@openssh.com";
  if (!certificateType.endsWith(suffix)) {
    return undefined;
  }

  const baseType = certificateType.slice(0, -suffix.length);
  let offset = skipSshString(certificate, typeField.nextOffset); // nonce

  if (baseType === "ssh-ed25519" || baseType.startsWith("sk-ssh-ed25519@")) {
    offset = skipSshString(certificate, offset);
    if (baseType.startsWith("sk-ssh-ed25519@")) {
      offset = skipSshString(certificate, offset); // application
    }
  } else if (baseType.startsWith("ecdsa-sha2-") || baseType.startsWith("sk-ecdsa-sha2-")) {
    offset = skipSshString(certificate, offset); // curve
    offset = skipSshString(certificate, offset); // public point
    if (baseType.startsWith("sk-ecdsa-sha2-")) {
      offset = skipSshString(certificate, offset); // application
    }
  } else if (baseType === "ssh-rsa") {
    offset = skipSshString(certificate, offset); // exponent
    offset = skipSshString(certificate, offset); // modulus
  } else if (baseType === "ssh-dss") {
    for (let i = 0; i < 4; i += 1) {
      offset = skipSshString(certificate, offset);
    }
  } else {
    throw new McpToolError(
      "ssh_host_certificate_unsupported",
      "Cannot parse the public-key fields of this OpenSSH certificate type",
      { certificateType },
    );
  }

  offset += 8; // serial
  if (offset + 4 > certificate.length) {
    throw new McpToolError("ssh_host_certificate_invalid", "SSH host certificate is truncated before certificate type");
  }
  const certificateKind = certificate.readUInt32BE(offset);
  offset += 4;
  if (certificateKind !== 2) {
    throw new McpToolError("ssh_host_certificate_not_host", "Presented OpenSSH certificate is not a host certificate", {
      certificateKind,
    });
  }

  offset = skipSshString(certificate, offset); // key id
  offset = skipSshString(certificate, offset); // principals
  offset += 16; // valid after + valid before
  offset = skipSshString(certificate, offset); // critical options
  offset = skipSshString(certificate, offset); // extensions
  offset = skipSshString(certificate, offset); // reserved
  return readSshString(certificate, offset).value;
}

function parseKeyScanOutput(output: string, input: ProbeSshHostKeyInput): SshHostKeyFingerprint {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));

  if (line === undefined) {
    throw new McpToolError("ssh_host_key_probe_failed", "ssh-keyscan did not return a host key", {
      host: input.host,
      port: input.port,
    });
  }

  const fields = line.split(/\s+/);
  const keyIndex = fields.findIndex((field) => field.startsWith("ssh-") || field.startsWith("ecdsa-") || field.startsWith("sk-"));
  if (keyIndex < 0 || fields[keyIndex + 1] === undefined) {
    throw new McpToolError("ssh_host_key_probe_failed", "ssh-keyscan returned an unrecognized host key line", {
      host: input.host,
      port: input.port,
    });
  }

  const keyBlob = Buffer.from(fields[keyIndex + 1] as string, "base64");
  const observed = fingerprintSshHostKey(keyBlob);
  const caKey = extractCertificateAuthorityKey(keyBlob);
  if (caKey === undefined) {
    return observed;
  }

  const ca = fingerprintSshHostKey(caKey);
  const knownHostsHost = input.port === 22 ? input.host : `[${input.host}]:${input.port}`;
  return {
    ...observed,
    certificateAuthority: {
      keyType: ca.keyType,
      fingerprint: ca.fingerprint,
      sha256Hex: ca.sha256Hex,
      knownHostsEntry: `@cert-authority ${knownHostsHost} ${ca.keyType} ${caKey.toString("base64")}`,
    },
  };
}

async function probeWithOpenSshKeyscan(input: ProbeSshHostKeyInput): Promise<SshHostKeyFingerprint> {
  const keyscanExecutable = process.platform === "win32"
    ? join(process.env.WINDIR ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keyscan.exe")
    : "ssh-keyscan";
  const executable = process.platform === "win32" && !existsSync(keyscanExecutable)
    ? "ssh-keyscan.exe"
    : keyscanExecutable;
  return await new Promise<SshHostKeyFingerprint>((resolve, reject) => {
    execFile(
      executable,
      ["-c", "-T", String(Math.max(1, Math.ceil(input.timeoutMs / 1_000))), "-p", String(input.port), input.host],
      // ssh-keyscan can make several parallel attempts for certificate host
      // key algorithms; give the child a little more time than one socket.
      { timeout: input.timeoutMs + 5_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (stdout.trim().length > 0) {
          try {
            resolve(parseKeyScanOutput(stdout, input));
          } catch (parseError) {
            reject(parseError);
          }
          return;
        }

        const stderr = (error as (NodeJS.ErrnoException & { stderr?: string }) | null)?.stderr?.trim();
        reject(new McpToolError(
          "ssh_host_certificate_probe_failed",
          stderr || error?.message || "OpenSSH ssh-keyscan could not read the host certificate",
          { host: input.host, port: input.port },
        ));
      },
    );
  });
}

/**
 * Negotiate SSH only far enough to inspect the presented host key. The
 * verifier deliberately rejects the key, so no SSH user-authentication
 * request or caller credential is sent during this probe. OpenSSH keyscan is
 * used only when the ssh2 backend cannot negotiate a certificate host key.
 */
export async function probeSshHostKey(input: ProbeSshHostKeyInput): Promise<SshHostKeyFingerprint> {
  validateSshHostname(input.host);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new McpToolError("ssh_host_key_probe_invalid", "SSH port must be between 1 and 65535", { field: "port" });
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new McpToolError("ssh_host_key_probe_invalid", "SSH probe timeout must be positive", { field: "timeoutMs" });
  }

  const client = new Client();

  return await new Promise<SshHostKeyFingerprint>((resolve, reject) => {
    let observed: SshHostKeyFingerprint | undefined;
    let settled = false;
    let fallbackNeeded = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    client.on("error", (error: Error) => {
      if (observed !== undefined) {
        finish(() => resolve(observed as SshHostKeyFingerprint));
        client.end();
        return;
      }

      if (/no matching host key format/i.test(error.message)) {
        fallbackNeeded = true;
        client.end();
        return;
      }

      finish(() => reject(new McpToolError("ssh_host_key_probe_failed", error.message, {
        host: input.host,
        port: input.port,
      })));
    });

    client.once("ready", () => {
      client.end();
      finish(() => reject(new McpToolError(
        "ssh_host_key_probe_unexpected_ready",
        "Host-key probe unexpectedly reached an authenticated SSH session",
        { host: input.host, port: input.port },
      )));
    });

    client.once("close", () => {
      if (fallbackNeeded && !settled) {
        settled = true;
        void probeWithOpenSshKeyscan(input).then(resolve, reject);
        return;
      }
      if (observed !== undefined) {
        finish(() => resolve(observed as SshHostKeyFingerprint));
      } else if (!settled) {
        finish(() => reject(new McpToolError(
          "ssh_host_key_probe_failed",
          "SSH connection closed before a host key could be inspected",
          { host: input.host, port: input.port },
        )));
      }
    });

    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: "ssh-host-key-probe",
        readyTimeout: input.timeoutMs,
        timeout: input.timeoutMs,
        hostVerifier: (key: Buffer): boolean => {
          observed = fingerprintSshHostKey(key);
          return false;
        },
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      client.end();
    }
  });
}
