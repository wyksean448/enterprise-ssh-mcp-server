import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseEnvFile, parseProfiles, ProfileRegistry, publicProfile } from "../src/env-profiles.js";

describe("env profile parsing", () => {
  it("parses indexed SSH_MCP_SERVER profiles with uniform field names", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_HOST=prod.example.com
SSH_MCP_SERVER_1_PORT=22
SSH_MCP_SERVER_1_NAME=prod
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_PASSWORD="change-me"
SSH_MCP_SERVER_1_ALIASES=production,example-prod
SSH_MCP_SERVER_1_DEFAULT_DIR=/opt/example-app
SSH_MCP_SERVER_1_DESCRIPTION="production server"
SSH_MCP_SERVER_1_PLATFORM=linux
SSH_MCP_SERVER_1_ALLOW_EDIT=true
SSH_MCP_SERVER_1_EDIT_ROOT=/opt/example-app
SSH_MCP_SERVER_1_MAX_EDIT_FILE_BYTES=2097152
SSH_MCP_SERVER_1_BACKUP_BEFORE_EDIT=true
SSH_MCP_SERVER_1_BACKUP_DIR=.mcp-backups
SSH_MCP_SERVER_1_ALLOW_DELETE=false
SSH_MCP_SERVER_1_ALLOW_BINARY_EDIT=false

SSH_MCP_SERVER_2_HOST=staging.example.com
SSH_MCP_SERVER_2_USER=deploy
SSH_MCP_SERVER_2_NAME=staging
SSH_MCP_SERVER_2_DISPLAY_NAME="Staging Server"
`);

    const profiles = parseProfiles(variables, "test.env");

    expect(profiles.get("PROD")).toMatchObject({
      name: "PROD",
      aliases: ["production", "example-prod"],
      host: "prod.example.com",
      port: 22,
      username: "root",
      password: "change-me",
      defaultDir: "/opt/example-app",
      description: "production server",
      platform: "linux",
      allowEdit: true,
      editRoot: "/opt/example-app",
      maxEditFileBytes: 2_097_152,
      backupBeforeEdit: true,
      backupDir: ".mcp-backups",
      allowDelete: false,
      allowBinaryEdit: false,
    });
    expect(profiles.get("STAGING")).toMatchObject({
      name: "STAGING",
      displayName: "Staging Server",
      host: "staging.example.com",
      port: 22,
      username: "deploy",
    });
  });

  it("parses indexed profile names regardless of .env field order", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_IP=example.com
SSH_MCP_SERVER_1_NAME=prod
`);

    const profiles = parseProfiles(variables, "test.env");

    expect(profiles.get("PROD")).toMatchObject({
      name: "PROD",
      host: "example.com",
      username: "root",
    });
    expect(profiles.has("SERVER_1")).toBe(false);
  });

  it("rejects legacy SSH_SERVER profiles", () => {
    const variables = parseEnvFile(`
SSH_SERVER_EXAMPLE_PROD_HOST=prod.example.com
SSH_SERVER_EXAMPLE_PROD_NAME=prod
SSH_SERVER_EXAMPLE_PROD_ALIASES=example-prod,prod,production
SSH_SERVER_EXAMPLE_PROD_USER=root
SSH_SERVER_EXAMPLE_PROD_PASSWORD="change-me"
SSH_SERVER_EXAMPLE_PROD_PORT=22
SSH_SERVER_EXAMPLE_PROD_DEFAULT_DIR=/opt/example-app
SSH_SERVER_EXAMPLE_PROD_DESCRIPTION="example production server"
SSH_SERVER_EXAMPLE_PROD_PLATFORM=linux
`);

    expect(() => parseProfiles(variables, "test.env")).toThrow("Unsupported SSH profile env schema");
  });

  it("rejects invalid indexed SSH profile keys", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_0_NAME=prod
SSH_MCP_SERVER_0_HOST=example.com
SSH_MCP_SERVER_0_USER=root
`);

    expect(() => parseProfiles(variables, "test.env")).toThrow("Invalid SSH profile env key");
  });

  it("requires NAME for indexed SSH profiles", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_HOST=example.com
SSH_MCP_SERVER_1_USER=root
`);

    expect(() => parseProfiles(variables, "test.env")).toThrow("SSH profile is missing NAME");
  });

  it("rejects invalid profile edit config values", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_NAME=prod
SSH_MCP_SERVER_1_HOST=example.com
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_ALLOW_EDIT=maybe
`);

    expect(() => parseProfiles(variables, "test.env")).toThrow("SSH profile boolean field is invalid");
  });

  it("does not expose secrets in public profiles", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_NAME=example
SSH_MCP_SERVER_1_HOST=example.com
SSH_MCP_SERVER_1_ALIASES=example-prod
SSH_MCP_SERVER_1_USERNAME=deploy
SSH_MCP_SERVER_1_PASSWORD=example-password
SSH_MCP_SERVER_1_PRIVATE_KEY="example-private-key"
SSH_MCP_SERVER_1_PRIVATE_KEY_PATH=C:/keys/example
SSH_MCP_SERVER_1_PASSPHRASE=example-passphrase
SSH_MCP_SERVER_1_AGENT=pageant
`);

    const profile = parseProfiles(variables, "test.env").get("EXAMPLE");
    expect(profile).toBeDefined();
    const publicValue = publicProfile(profile!);

    expect(publicValue).toMatchObject({
      name: "EXAMPLE",
      aliases: ["example-prod"],
      host: "example.com",
      username: "deploy",
      hasPassword: true,
      hasPrivateKey: true,
      hasPrivateKeyPath: true,
      hasPassphrase: true,
      hasAgent: true,
    });
    expect(JSON.stringify(publicValue)).not.toContain("example-password");
    expect(JSON.stringify(publicValue)).not.toContain("example-private-key");
  });

  it("resolves profiles by formal name and aliases", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-mcp-profile-test-"));
    const envPath = join(tempDir, ".env");

    try {
      await writeFile(
        envPath,
        `
SSH_MCP_SERVER_1_NAME=prod
SSH_MCP_SERVER_1_HOST=example.com
SSH_MCP_SERVER_1_DISPLAY_NAME="Production Server"
SSH_MCP_SERVER_1_ALIASES=example-prod,production
SSH_MCP_SERVER_1_USER=root
`,
        "utf8",
      );

      const registry = new ProfileRegistry(envPath);

      expect(registry.get("PROD").name).toBe("PROD");
      expect(registry.get("prod").name).toBe("PROD");
      expect(registry.get("example-prod").name).toBe("PROD");
      expect(() => registry.get("Production Server")).toThrow("SSH profile was not found in .env");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
