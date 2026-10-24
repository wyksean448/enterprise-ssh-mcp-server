import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { extractCertificateAuthorityKey, fingerprintSshHostKey, probeSshHostKey } from "../src/ssh-host-key.js";

function fakeHostKey(type: string, suffix: string): Buffer {
  const typeBytes = Buffer.from(type, "utf8");
  const suffixBytes = Buffer.from(suffix, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(typeBytes.length, 0);
  return Buffer.concat([length, typeBytes, suffixBytes]);
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function fakeEd25519HostCertificate(): { certificate: Buffer; caKey: Buffer } {
  const caKey = Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(Buffer.alloc(32, 2)),
  ]);
  const uint32 = (value: number): Buffer => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value, 0);
    return result;
  };
  const zero64 = Buffer.alloc(8);
  const certificate = Buffer.concat([
    sshString("ssh-ed25519-cert-v01@openssh.com"),
    sshString("nonce"),
    sshString(Buffer.alloc(32, 1)),
    zero64, // serial
    uint32(2), // host certificate
    sshString("test-cert"),
    sshString(Buffer.alloc(0)), // principals
    zero64, // valid after
    zero64, // valid before
    sshString(Buffer.alloc(0)), // critical options
    sshString(Buffer.alloc(0)), // extensions
    sshString(Buffer.alloc(0)), // reserved
    sshString(caKey),
    sshString(Buffer.alloc(0)), // signature
  ]);
  return { certificate, caKey };
}

describe("SSH host key fingerprints", () => {
  it("returns OpenSSH SHA-256 fingerprint and the hex pin accepted by ssh2", () => {
    const key = fakeHostKey("ssh-ed25519", "test-key-data");
    const digest = createHash("sha256").update(key).digest();
    const fingerprint = fingerprintSshHostKey(key);

    expect(fingerprint.keyType).toBe("ssh-ed25519");
    expect(fingerprint.fingerprint).toBe(`SHA256:${digest.toString("base64").replace(/=+$/, "")}`);
    expect(fingerprint.sha256Hex).toBe(digest.toString("hex"));
  });

  it("rejects truncated or malformed SSH host key blobs", () => {
    expect(() => fingerprintSshHostKey(Buffer.from([0, 0, 0]))).toThrowError(
      expect.objectContaining({ code: "ssh_host_key_invalid" }),
    );

    const invalidTypeLength = Buffer.alloc(4);
    invalidTypeLength.writeUInt32BE(999, 0);
    expect(() => fingerprintSshHostKey(invalidTypeLength)).toThrowError(
      expect.objectContaining({ code: "ssh_host_key_invalid" }),
    );
  });

  it("extracts the CA key from an OpenSSH host certificate without trusting it", () => {
    const { certificate, caKey } = fakeEd25519HostCertificate();
    const extracted = extractCertificateAuthorityKey(certificate);
    expect(extracted).toEqual(caKey);
    expect(fingerprintSshHostKey(extracted as Buffer).keyType).toBe("ssh-ed25519");
    expect(fingerprintSshHostKey(certificate).ssh2Compatible).toBe(false);
  });

  it("rejects option-like hosts before starting a network probe", async () => {
    await expect(probeSshHostKey({ host: "-oProxyCommand=bad", port: 22, timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "ssh_target_invalid",
    });
  });
});
