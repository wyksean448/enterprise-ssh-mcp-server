import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileRegistry } from "../src/env-profiles.js";
import { reloadEnvSnapshot, startEnvHotReload } from "../src/env-reload.js";
import { RuntimeConfigRegistry } from "../src/runtime-config.js";

const temporaryDirectories: string[] = [];

async function createEnvFile(content: string): Promise<{ directory: string; envPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ssh-mcp-env-reload-test-"));
  temporaryDirectories.push(directory);
  const envPath = join(directory, ".env");
  await writeFile(envPath, content, "utf8");
  return { directory, envPath };
}

function envContent(port: number, profileName = "lab", username = "deploy"): string {
  return [
    `SSH_MCP_DEFAULT_SSH_PORT=${port}`,
    `SSH_MCP_SERVER_1_NAME=${profileName}`,
    "SSH_MCP_SERVER_1_HOST=ssh.example.com",
    `SSH_MCP_SERVER_1_USER=${username}`,
    "SSH_MCP_SERVER_1_PORT=2222",
    "",
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("atomic .env reload", () => {
  it("reloads runtime defaults and profiles as one snapshot", async () => {
    const { envPath } = await createEnvFile(envContent(22, "old"));
    const runtimeConfig = new RuntimeConfigRegistry(envPath);
    const profiles = new ProfileRegistry(envPath);
    const setCompactJsonResponse = vi.fn();

    await writeFile(envPath, envContent(2222, "new"), "utf8");
    const snapshot = reloadEnvSnapshot({
      envPath,
      runtimeConfig,
      profiles,
      startupToolExposure: {
        toolset: runtimeConfig.get().toolset,
        enableDangerousTools: runtimeConfig.get().enableDangerousTools,
      },
      setCompactJsonResponse,
    });

    expect(snapshot.config.defaultSshPort).toBe(2222);
    expect(snapshot.profiles.map((profile) => profile.name)).toEqual(["NEW"]);
    expect(snapshot.restartRequiredForToolVisibility).toBe(false);
    expect(setCompactJsonResponse).toHaveBeenCalledWith(true);
  });

  it("keeps both previous registries unchanged if either parser rejects the file", async () => {
    const { envPath } = await createEnvFile(envContent(22, "stable"));
    const runtimeConfig = new RuntimeConfigRegistry(envPath);
    const profiles = new ProfileRegistry(envPath);
    const startupToolExposure = {
      toolset: runtimeConfig.get().toolset,
      enableDangerousTools: runtimeConfig.get().enableDangerousTools,
    };

    await writeFile(
      envPath,
      "SSH_MCP_DEFAULT_SSH_PORT=2222\nSSH_MCP_SERVER_1_NAME=broken\nSSH_MCP_SERVER_1_USER=deploy\n",
      "utf8",
    );

    expect(() =>
      reloadEnvSnapshot({
        envPath,
        runtimeConfig,
        profiles,
        startupToolExposure,
        setCompactJsonResponse: vi.fn(),
      }),
    ).toThrow(/missing HOST/i);
    expect(runtimeConfig.get().defaultSshPort).toBe(22);
    expect(profiles.list().map((profile) => profile.name)).toEqual(["STABLE"]);
  });

  it("automatically reloads a changed .env file and can be stopped cleanly", async () => {
    const { envPath } = await createEnvFile(envContent(22, "before"));
    const runtimeConfig = new RuntimeConfigRegistry(envPath);
    const profiles = new ProfileRegistry(envPath);
    const startupToolExposure = {
      toolset: runtimeConfig.get().toolset,
      enableDangerousTools: runtimeConfig.get().enableDangerousTools,
    };
    const onReload = vi.fn();
    const onError = vi.fn();
    const stop = startEnvHotReload({
      envPath,
      pollIntervalMs: 40,
      debounceMs: 20,
      reload: () =>
        reloadEnvSnapshot({
          envPath,
          runtimeConfig,
          profiles,
          startupToolExposure,
          setCompactJsonResponse: vi.fn(),
        }),
      onReload,
      onError,
    });

    try {
      await writeFile(envPath, envContent(2200, "after"), "utf8");
      await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 25 });
      expect(runtimeConfig.get().defaultSshPort).toBe(2200);
      expect(profiles.list().map((profile) => profile.name)).toEqual(["AFTER"]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("redacts InstaBox token usernames in the public profile view", async () => {
    const { envPath } = await createEnvFile(envContent(22, "token-lab", "ibssh_exampletoken"));
    const profiles = new ProfileRegistry(envPath);
    expect(profiles.list()[0]?.username).toBe("ibssh_[REDACTED]");
  });
});
