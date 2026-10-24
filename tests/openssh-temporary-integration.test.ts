import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeSshHostKey: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../src/ssh-host-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ssh-host-key.js")>();
  return { ...actual, probeSshHostKey: mocks.probeSshHostKey };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});

import { fingerprintSshHostKey } from "../src/ssh-host-key.js";
import { runOpenSshCommand } from "../src/openssh-command.js";
import { runOpenSshCommandWithTemporaryHostCa } from "../src/openssh-temporary.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  return child;
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

const caKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 21))]);
const caFingerprint = fingerprintSshHostKey(caKey).fingerprint;
const knownHostsEntry = `@cert-authority [ssh.instabox.sh]:2222 ssh-ed25519 ${caKey.toString("base64")}`;
const token = "ibssh_integration_test_secret";
const input = {
  host: "ssh.instabox.sh",
  usernameEnvVar: "SSH_MCP_INSTABOX_TOKEN",
  port: 2222,
  command: "uname -a",
  timeoutMs: 10_000,
  maxOutputBytes: 4096,
};

let temporaryPaths: string[] = [];

beforeEach(() => {
  mocks.probeSshHostKey.mockReset();
  mocks.spawn.mockReset();
  temporaryPaths = [];
  process.env.SSH_MCP_INSTABOX_TOKEN = token;
  process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS = JSON.stringify({ "ssh.instabox.sh:2222": caFingerprint });
  mocks.probeSshHostKey.mockResolvedValue({
    keyType: "ssh-ed25519-cert-v01@openssh.com",
    fingerprint: "SHA256:host-certificate",
    sha256Hex: "ab".repeat(32),
    ssh2Compatible: false,
    certificateAuthority: {
      keyType: "ssh-ed25519",
      fingerprint: caFingerprint,
      sha256Hex: fingerprintSshHostKey(caKey).sha256Hex,
      knownHostsEntry,
    },
  });
});

afterEach(() => {
  delete process.env.SSH_MCP_INSTABOX_TOKEN;
  delete process.env.SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS;
});

describe("temporary OpenSSH end-to-end adapter", () => {
  it("uses isolated trust/config files, hides the token from argv, and cleans both files after success", async () => {
    let configPath = "";
    let knownHostsPath = "";
    let spawnedArgs: string[] = [];

    mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
      spawnedArgs = args;
      const configFlag = args.indexOf("-F");
      configPath = args[configFlag + 1] as string;
      const trustArg = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
      if (trustArg === undefined) throw new Error("isolated known_hosts path was not passed");
      knownHostsPath = trustArg.slice("UserKnownHostsFile=".length);
      temporaryPaths.push(configPath, knownHostsPath);

      expect(readFileSync(configPath, "utf8")).toContain(`User ${token}`);
      expect(readFileSync(configPath, "utf8")).toContain("Host ssh.instabox.sh");
      expect(readFileSync(configPath, "utf8")).toContain("HostName ssh.instabox.sh");
      expect(readFileSync(knownHostsPath, "utf8")).toBe(knownHostsEntry + "\n");
      expect(args.join("\u0000")).not.toContain(token);
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).toContain("GlobalKnownHostsFile=none");

      const child = makeChild();
      queueMicrotask(() => {
        child.stdout.write("Linux fake-host 6.1\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    const result = await runOpenSshCommandWithTemporaryHostCa(input);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "Linux fake-host 6.1\n",
      trustMode: "temporary-host-ca",
      trustStoreDeleted: true,
      verifiedFingerprint: caFingerprint,
    });
    expect(temporaryPaths).toHaveLength(2);
    expect(temporaryPaths.every((path) => !existsSync(path))).toBe(true);
    expect(spawnedArgs.at(-2)).toBe("ssh.instabox.sh");
    expect(spawnedArgs.at(-1)).toBe("uname -a");
  });

  it("cleans both temporary directories when the OpenSSH executable cannot start", async () => {
    let configPath = "";
    let knownHostsPath = "";
    mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
      configPath = args[args.indexOf("-F") + 1] as string;
      const trustArg = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
      if (trustArg === undefined) throw new Error("isolated known_hosts path was not passed");
      knownHostsPath = trustArg.slice("UserKnownHostsFile=".length);
      const child = makeChild();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("missing ssh"), { code: "ENOENT" })));
      return child;
    });

    await expect(runOpenSshCommandWithTemporaryHostCa(input)).rejects.toMatchObject({
      code: "openssh_spawn_failed",
    });
    expect(configPath).not.toBe("");
    expect(knownHostsPath).not.toBe("");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(knownHostsPath)).toBe(false);
  });

  it("keeps an environment-provided username out of argv for non-InstaBox hosts too", async () => {
    const secretUsername = "private%h_user_value";
    process.env.SSH_MCP_TEST_USERNAME = secretUsername;
    let configPath = "";
    let observedConfig = "";
    let spawnedArgs: string[] = [];
    mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
      spawnedArgs = args;
      configPath = args[args.indexOf("-F") + 1] as string;
      observedConfig = readFileSync(configPath, "utf8");
      const child = makeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    try {
      const result = await runOpenSshCommand({
        host: "ssh.example.com",
        usernameEnvVar: "SSH_MCP_TEST_USERNAME",
        port: 22,
        command: "true",
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
      });
      expect(result.exitCode).toBe(0);
      expect(spawnedArgs.join("\u0000")).not.toContain(secretUsername);
      expect(observedConfig).toContain("User private%h_user_value");
      expect(existsSync(configPath)).toBe(false);
    } finally {
      delete process.env.SSH_MCP_TEST_USERNAME;
    }
  });

  it("reports timeout and terminates the child process", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const result = await runOpenSshCommand({
      host: "ssh.example.com",
      username: "deploy",
      port: 22,
      command: "sleep 10",
      timeoutMs: 15,
      maxOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("caps combined stdout/stderr bytes and marks output as truncated", async () => {
    const child = makeChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write("0123456789");
        child.stdout.end();
        child.stderr.end();
      });
      return child;
    });
    const result = await runOpenSshCommand({
      host: "ssh.example.com",
      username: "deploy",
      port: 22,
      command: "printf output",
      timeoutMs: 1_000,
      maxOutputBytes: 5,
    });
    expect(result.stdout).toBe("01234");
    expect(result.outputTruncated).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
