import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeSshHostKey: vi.fn(),
  runOpenSshCommand: vi.fn(),
}));

vi.mock("../src/ssh-host-key.js", () => ({
  probeSshHostKey: mocks.probeSshHostKey,
}));
vi.mock("../src/openssh-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/openssh-command.js")>();
  return { ...actual, runOpenSshCommand: mocks.runOpenSshCommand };
});

import { runOpenSshCommandWithTemporaryHostCa } from "../src/openssh-temporary.js";

const caKey = Buffer.concat([
  (() => { const b = Buffer.from("ssh-ed25519"); const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); })(),
  (() => { const b = Buffer.alloc(32, 9); const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); })(),
]);
const fingerprint = `SHA256:${createHash("sha256").update(caKey).digest("base64").replace(/=+$/, "")}`;
const knownHostsEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${caKey.toString("base64")}`;
const baseInput = {
  host: "ssh.instabox.sh",
  usernameEnvVar: "SSH_MCP_INSTABOX_TOKEN",
  port: 2222,
  command: "uname -a",
  timeoutMs: 10_000,
  maxOutputBytes: 4096,
};

beforeEach(() => {
  process.env.SSH_MCP_INSTABOX_TOKEN = "ibssh_testtoken";
  process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS = JSON.stringify({ "ssh.instabox.sh:2222": fingerprint });
  mocks.probeSshHostKey.mockReset();
  mocks.runOpenSshCommand.mockReset();
  mocks.probeSshHostKey.mockResolvedValue({
    keyType: "ssh-ed25519-cert-v01@openssh.com",
    fingerprint: "SHA256:host-certificate",
    sha256Hex: "ab".repeat(32),
    ssh2Compatible: false,
    certificateAuthority: {
      keyType: "ssh-ed25519",
      fingerprint,
      sha256Hex: "cd".repeat(32),
      knownHostsEntry,
    },
  });
  mocks.runOpenSshCommand.mockImplementation(async (input: { knownHostsPath: string }) => {
    const content = await readFile(input.knownHostsPath, "utf8");
    expect(content).toBe(knownHostsEntry + "\n");
    return {
      host: "ssh.instabox.sh",
      port: 2222,
      username: "ibssh_[REDACTED]",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 3,
      stdout: "Linux test",
      stderr: "",
      outputTruncated: false,
    };
  });
});

afterEach(() => {
  delete process.env.SSH_MCP_INSTABOX_TOKEN;
  delete process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS;
});

describe("temporary OpenSSH host CA trust", () => {
  it("uses a dedicated known_hosts file and deletes it after the command", async () => {
    const result = await runOpenSshCommandWithTemporaryHostCa(baseInput);
    const calledWith = mocks.runOpenSshCommand.mock.calls[0]?.[0] as { knownHostsPath: string };
    expect(result).toMatchObject({
      trustMode: "temporary-host-ca",
      trustStoreDeleted: true,
      verifiedFingerprint: fingerprint,
      exitCode: 0,
    });
    expect(existsSync(calledWith.knownHostsPath)).toBe(false);
    expect(mocks.runOpenSshCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects before probing if the local CA pin is missing", async () => {
    delete process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS;
    await expect(runOpenSshCommandWithTemporaryHostCa(baseInput)).rejects.toMatchObject({
      code: "ssh_host_ca_not_configured",
    });
    expect(mocks.probeSshHostKey).not.toHaveBeenCalled();
    expect(mocks.runOpenSshCommand).not.toHaveBeenCalled();
  });

  it("rejects if the live CA fingerprint differs from the trusted fingerprint", async () => {
    mocks.probeSshHostKey.mockResolvedValueOnce({
      keyType: "ssh-ed25519-cert-v01@openssh.com",
      fingerprint: "SHA256:host-certificate",
      sha256Hex: "ab".repeat(32),
      ssh2Compatible: false,
      certificateAuthority: {
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:unexpected",
        sha256Hex: "ef".repeat(32),
        knownHostsEntry,
      },
    });
    await expect(runOpenSshCommandWithTemporaryHostCa(baseInput)).rejects.toMatchObject({
      code: "ssh_host_ca_fingerprint_mismatch",
    });
    expect(mocks.runOpenSshCommand).not.toHaveBeenCalled();
  });

  it("rejects non-certificate endpoints in temporary CA mode", async () => {
    mocks.probeSshHostKey.mockResolvedValueOnce({
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:host-key",
      sha256Hex: "ab".repeat(32),
      ssh2Compatible: true,
    });
    await expect(runOpenSshCommandWithTemporaryHostCa(baseInput)).rejects.toMatchObject({
      code: "ssh_host_ca_missing",
    });
    expect(mocks.runOpenSshCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed hosts and missing local credentials before probing the network", async () => {
    await expect(runOpenSshCommandWithTemporaryHostCa({
      ...baseInput,
      host: "-oProxyCommand=bad",
    })).rejects.toMatchObject({ code: "ssh_target_invalid" });
    expect(mocks.probeSshHostKey).not.toHaveBeenCalled();

    delete process.env.SSH_MCP_INSTABOX_TOKEN;
    await expect(runOpenSshCommandWithTemporaryHostCa(baseInput)).rejects.toMatchObject({
      code: "ssh_username_env_not_set",
    });
    expect(mocks.probeSshHostKey).not.toHaveBeenCalled();
  });

  it("rejects inline InstaBox bearer tokens before probing the network", async () => {
    await expect(runOpenSshCommandWithTemporaryHostCa({
      ...baseInput,
      host: "ibssh_inline_test_token@ssh.instabox.sh",
      usernameEnvVar: undefined,
    })).rejects.toMatchObject({ code: "instabox_token_env_required" });
    expect(mocks.probeSshHostKey).not.toHaveBeenCalled();
  });

  it("runs with a one-shot credential but still refuses an unpinned host CA", async () => {
    delete process.env.SSH_MCP_INSTABOX_TOKEN;
    const input = {
      ...baseInput,
      usernameEnvVar: undefined,
      ephemeralToken: "ibssh_test_fixture_one_shot",
    };
    const result = await runOpenSshCommandWithTemporaryHostCa(input);
    expect(result.exitCode).toBe(0);
    expect(mocks.runOpenSshCommand).toHaveBeenCalledWith(expect.objectContaining({
      ephemeralToken: input.ephemeralToken,
      knownHostsPath: expect.any(String),
    }));
    delete process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS;
    mocks.probeSshHostKey.mockClear();
    mocks.runOpenSshCommand.mockClear();
    await expect(runOpenSshCommandWithTemporaryHostCa(input)).rejects.toMatchObject({
      code: "ssh_host_ca_not_configured",
    });
    expect(mocks.probeSshHostKey).not.toHaveBeenCalled();
    expect(mocks.runOpenSshCommand).not.toHaveBeenCalled();
  });
});
