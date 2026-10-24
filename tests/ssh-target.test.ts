import { describe, expect, it } from "vitest";

import { isInstaboxSshTokenTarget, parseSshTarget, redactSshUsername } from "../src/ssh-target.js";

describe("parseSshTarget", () => {
  it("parses a username embedded in an SSH config HostName value", () => {
    expect(
      parseSshTarget({
        host: "ibssh_test_fixture_not_a_real_token@ssh.instabox.sh",
      }),
    ).toEqual({
      host: "ssh.instabox.sh",
      username: "ibssh_test_fixture_not_a_real_token",
    });
  });

  it("continues to accept a plain hostname with a separate username", () => {
    expect(parseSshTarget({ host: "ssh.example.com", username: "deploy" })).toEqual({
      host: "ssh.example.com",
      username: "deploy",
    });
  });

  it("accepts matching embedded and separately supplied usernames", () => {
    expect(parseSshTarget({ host: "deploy@ssh.example.com", username: "deploy" })).toEqual({
      host: "ssh.example.com",
      username: "deploy",
    });
  });

  it("rejects a missing username when the host has no embedded username", () => {
    expect(() => parseSshTarget({ host: "ssh.example.com" })).toThrowError(
      expect.objectContaining({ code: "ssh_target_username_required" }),
    );
  });

  it("rejects conflicting usernames instead of guessing which one is correct", () => {
    expect(() => parseSshTarget({ host: "deploy@ssh.example.com", username: "admin" })).toThrowError(
      expect.objectContaining({ code: "ssh_target_username_conflict" }),
    );
  });

  it.each(["@ssh.example.com", "deploy@", "one@two@ssh.example.com", "ssh://ssh.example.com", "ssh.example.com/path"])(
    "rejects malformed SSH target %s",
    (host) => {
      expect(() => parseSshTarget({ host, username: "deploy" })).toThrowError(
        expect.objectContaining({ code: "ssh_target_invalid" }),
      );
    },
  );

  it.each(["-oProxyCommand=bad", "ssh*.example.com", "bad#host", "host%h.example.com"])(
    "rejects option-like or config-metacharacter host %s",
    (host) => {
      expect(() => parseSshTarget({ host, username: "deploy" })).toThrowError(
        expect.objectContaining({ code: "ssh_target_invalid" }),
      );
    },
  );

  it("trims surrounding whitespace from target and username", () => {
    expect(parseSshTarget({ host: "  ssh.example.com  ", username: " deploy " })).toEqual({
      host: "ssh.example.com",
      username: "deploy",
    });
  });

  it("recognizes InstaBox SSH token targets without requiring a key or password", () => {
    expect(
      isInstaboxSshTokenTarget(
        parseSshTarget({ host: "ibssh_exampletoken@ssh.instabox.sh" }),
      ),
    ).toBe(true);
    expect(isInstaboxSshTokenTarget({ host: "ssh.example.com", username: "ibssh_exampletoken" })).toBe(false);
  });

  it("redacts InstaBox token usernames before they are returned or logged", () => {
    expect(redactSshUsername("ibssh_exampletoken")).toBe("ibssh_[REDACTED]");
    expect(redactSshUsername("IBSSH_exampletoken")).toBe("ibssh_[REDACTED]");
    expect(redactSshUsername("deploy")).toBe("deploy");
  });
});
