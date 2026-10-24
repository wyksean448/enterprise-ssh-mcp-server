import { McpToolError } from "./tool-result.js";

export interface SshTargetInput {
  host: string;
  username?: string | undefined;
}

export interface SshTarget {
  host: string;
  username: string;
}

/** InstaBox SSH tokens are bearer credentials encoded as the SSH username. */
export function redactSshUsername(username: string): string {
  return /^ibssh_/i.test(username) ? "ibssh_[REDACTED]" : username;
}

export function isInstaboxSshTokenTarget(target: SshTarget): boolean {
  return target.host.toLowerCase() === "ssh.instabox.sh" && /^ibssh_/i.test(target.username);
}

/** Reject option-like hosts and characters that could alter SSH config/CLI parsing. */
export function validateSshHostname(host: string): void {
  if (
    host.length === 0
    || host.startsWith("-")
    || /\s/.test(host)
    || host.includes("@")
    || host.includes("/")
    || host.includes("\\")
    || host.includes("://")
    || !/^[A-Za-z0-9._:-]+$/.test(host)
  ) {
    throw new McpToolError(
      "ssh_target_invalid",
      "SSH host must be a hostname/IP without option prefixes, URL schemes, paths, whitespace, or shell/config metacharacters",
      { field: "host" },
    );
  }
}

/**
 * Accept either separate host/username fields or the common SSH target form
 * "username@hostname". This parses the target only; it does not authenticate
 * the caller or establish trust in the remote host key.
 */
export function parseSshTarget(input: SshTargetInput): SshTarget {
  const rawHost = input.host.trim();
  const suppliedUsername = input.username?.trim();

  if (rawHost.length === 0) {
    throw new McpToolError("ssh_target_invalid", "SSH host must not be empty", { field: "host" });
  }
  if (/\s/.test(rawHost) || rawHost.includes("://") || rawHost.includes("/") || rawHost.includes("\\")) {
    throw new McpToolError(
      "ssh_target_invalid",
      "SSH host must be a hostname/IP, optionally prefixed with username@; do not include a URL scheme, path, or whitespace",
      { field: "host" },
    );
  }

  const firstAt = rawHost.indexOf("@");
  if (firstAt >= 0) {
    if (firstAt === 0 || firstAt === rawHost.length - 1 || rawHost.indexOf("@", firstAt + 1) >= 0) {
      throw new McpToolError("ssh_target_invalid", "Expected SSH target in username@hostname format", { field: "host" });
    }

    const embeddedUsername = rawHost.slice(0, firstAt);
    const hostname = rawHost.slice(firstAt + 1);
    validateSshHostname(hostname);
    if (suppliedUsername !== undefined && suppliedUsername.length > 0 && suppliedUsername !== embeddedUsername) {
      throw new McpToolError(
        "ssh_target_username_conflict",
        "The username in host does not match the separately supplied username",
        { embeddedUsername, suppliedUsername },
      );
    }

    return { host: hostname, username: embeddedUsername };
  }

  if (suppliedUsername === undefined || suppliedUsername.length === 0) {
    throw new McpToolError(
      "ssh_target_username_required",
      "Provide username separately, or set host to username@hostname",
      { field: "username" },
    );
  }

  validateSshHostname(rawHost);

  if (suppliedUsername.includes("@") || /\s/.test(suppliedUsername)) {
    throw new McpToolError("ssh_target_invalid", "SSH username must not contain @ or whitespace", { field: "username" });
  }

  return { host: rawHost, username: suppliedUsername };
}
