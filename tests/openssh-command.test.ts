import { describe, expect, it } from "vitest";

import { buildOpenSshArgs, resolveOpenSshTarget, runOpenSshCommand, type OpenSshCommandInput } from "../src/openssh-command.js";

const baseInput: OpenSshCommandInput = {
  host: "ssh.example.com",
  username: "deploy",
  port: 22,
  command: "uname -a",
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
};

describe("native OpenSSH command adapter", () => {
  it("always requires strict host-key checking and batch mode", () => {
    const args = buildOpenSshArgs(baseInput, "ssh.example.com", "deploy");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=5");
    expect(args.at(-2)).toBe("deploy@ssh.example.com");
    expect(args.at(-1)).toBe("uname -a");
  });

  it("prevents building a command line that exposes an InstaBox token", () => {
    const input: OpenSshCommandInput = {
      ...baseInput,
      host: "ibssh_exampletoken@ssh.instabox.sh",
      username: undefined,
      port: 2222,
    };
    expect(() => buildOpenSshArgs(input, "ssh.instabox.sh", "ibssh_exampletoken")).toThrowError(
      expect.objectContaining({ code: "instabox_token_requires_temporary_config" }),
    );
  });

  it("supports a dedicated known_hosts file and identity file", () => {
    const args = buildOpenSshArgs({
      ...baseInput,
      identityFile: "C:/Users/test/.ssh/id_ed25519",
      knownHostsPath: "C:/Users/test/.ssh/known_hosts_instabox",
    }, "ssh.example.com", "deploy");
    expect(args).toContain("C:/Users/test/.ssh/id_ed25519");
    expect(args).toContain("UserKnownHostsFile=C:/Users/test/.ssh/known_hosts_instabox");
  });

  it("resolves a token username from the local process environment without passing it in tool arguments", () => {
    const input: OpenSshCommandInput = {
      ...baseInput,
      host: "ssh.instabox.sh",
      username: undefined,
      usernameEnvVar: "SSH_MCP_INSTABOX_TOKEN",
      port: 2222,
    };
    expect(resolveOpenSshTarget(input, { SSH_MCP_INSTABOX_TOKEN: "ibssh_localtest" })).toEqual({
      host: "ssh.instabox.sh",
      username: "ibssh_localtest",
    });
    expect(() => resolveOpenSshTarget(input, {})).toThrowError(
      expect.objectContaining({ code: "ssh_username_env_not_set" }),
    );
    expect(() => resolveOpenSshTarget({ ...input, host: "ibssh_localtest@ssh.instabox.sh" }, {
      SSH_MCP_INSTABOX_TOKEN: "ibssh_localtest",
    })).toThrowError(expect.objectContaining({ code: "ssh_target_username_conflict" }));
  });

  it("rejects option-like hosts and conflicting token/key authentication", async () => {
    await expect(runOpenSshCommand({ ...baseInput, host: "-oProxyCommand=bad" })).rejects.toThrow(
      expect.objectContaining({ code: "ssh_target_invalid" }),
    );
    await expect(runOpenSshCommand({
      ...baseInput,
      host: "ibssh_exampletoken@ssh.instabox.sh",
      username: undefined,
      port: 2222,
      identityFile: "C:/Users/test/.ssh/id_ed25519",
    })).rejects.toThrow(expect.objectContaining({ code: "instabox_token_auth_conflict" }));
  });

  it("requires InstaBox bearer tokens to come from the local environment", async () => {
    await expect(runOpenSshCommand({
      ...baseInput,
      host: "ibssh_inline_test_token@ssh.instabox.sh",
      username: undefined,
      port: 2222,
    })).rejects.toMatchObject({ code: "instabox_token_env_required" });

    process.env.SSH_MCP_TEST_TOKEN = "not-an-instabox-token";
    try {
      await expect(runOpenSshCommand({
        ...baseInput,
        host: "ssh.instabox.sh",
        username: undefined,
        usernameEnvVar: "SSH_MCP_TEST_TOKEN",
        port: 2222,
      })).rejects.toMatchObject({ code: "instabox_token_invalid" });
    } finally {
      delete process.env.SSH_MCP_TEST_TOKEN;
    }
  });
});
