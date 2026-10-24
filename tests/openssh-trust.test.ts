import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintSshHostKey } from "../src/ssh-host-key.js";
import { trustOpenSshHostCa } from "../src/openssh-trust.js";

const temporaryDirectories: string[] = [];
const trustConfigEnv = "SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS";

function pinCa(host: string, port: number, fingerprint: string): void {
  const current = process.env[trustConfigEnv];
  const pins = current === undefined ? {} : JSON.parse(current) as Record<string, string>;
  pins[`${host.toLowerCase()}:${port}`] = fingerprint;
  process.env[trustConfigEnv] = JSON.stringify(pins);
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function fakeCaKey(): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 7))]);
}

async function tempKnownHosts(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ssh-mcp-known-hosts-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "known_hosts");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  delete process.env[trustConfigEnv];
});

describe("OpenSSH host CA trust", () => {
  it("adds a CA entry only when the explicit confirmation matches its fingerprint", async () => {
    const knownHostsPath = await tempKnownHosts();
    const caKey = fakeCaKey();
    const fingerprint = fingerprintSshHostKey(caKey).fingerprint;
    const knownHostsEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${caKey.toString("base64")}`;
    pinCa("ssh.instabox.sh", 2222, fingerprint);

    const result = await trustOpenSshHostCa({
      host: "ssh.instabox.sh",
      port: 2222,
      knownHostsEntry,
      knownHostsPath,
    });

    expect(result).toMatchObject({ added: true, alreadyTrusted: false, fingerprint, knownHostsPath });
    expect(await readFile(knownHostsPath, "utf8")).toBe(knownHostsEntry + "\n");
  });

  it("is idempotent for the same entry", async () => {
    const knownHostsPath = await tempKnownHosts();
    const caKey = fakeCaKey();
    const fingerprint = fingerprintSshHostKey(caKey).fingerprint;
    const knownHostsEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${caKey.toString("base64")}`;
    pinCa("ssh.instabox.sh", 2222, fingerprint);
    const input = {
      host: "ssh.instabox.sh",
      port: 2222,
      knownHostsEntry,
      knownHostsPath,
    };

    expect((await trustOpenSshHostCa(input)).added).toBe(true);
    expect(await trustOpenSshHostCa(input)).toMatchObject({ added: false, alreadyTrusted: true });
    expect((await readFile(knownHostsPath, "utf8")).split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  });

  it("rejects a CA that differs from the local pin and a host-pattern mismatch", async () => {
    const knownHostsPath = await tempKnownHosts();
    const caKey = fakeCaKey();
    const fingerprint = fingerprintSshHostKey(caKey).fingerprint;
    const knownHostsEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${caKey.toString("base64")}`;
    const otherKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 19))]);
    const otherEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${otherKey.toString("base64")}`;
    pinCa("ssh.instabox.sh", 2222, fingerprint);

    await expect(trustOpenSshHostCa({
      host: "ssh.instabox.sh",
      port: 2222,
      knownHostsEntry: otherEntry,
      knownHostsPath,
    })).rejects.toMatchObject({ code: "ssh_host_ca_fingerprint_mismatch" });

    await expect(trustOpenSshHostCa({
      host: "other.example.com",
      port: 2222,
      knownHostsEntry,
      knownHostsPath,
    })).rejects.toMatchObject({ code: "ssh_host_ca_invalid" });
  });

  it("refuses to add a different CA when one is already trusted for the same host", async () => {
    const knownHostsPath = await tempKnownHosts();
    const firstKey = fakeCaKey();
    const secondKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 8))]);
    const firstFingerprint = fingerprintSshHostKey(firstKey).fingerprint;
    const secondFingerprint = fingerprintSshHostKey(secondKey).fingerprint;
    pinCa("ssh.instabox.sh", 2222, firstFingerprint);

    await trustOpenSshHostCa({
      host: "ssh.instabox.sh",
      port: 2222,
      knownHostsEntry: `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${firstKey.toString("base64")}`,
      knownHostsPath,
    });

    pinCa("ssh.instabox.sh", 2222, secondFingerprint);
    await expect(trustOpenSshHostCa({
      host: "ssh.instabox.sh",
      port: 2222,
      knownHostsEntry: `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${secondKey.toString("base64")}`,
      knownHostsPath,
    })).rejects.toMatchObject({ code: "ssh_host_ca_conflict" });
  });
});
