import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseEnvFile, parseProfiles, ProfileRegistry, publicProfile } from "../src/env-profiles.js";

describe("env profile parsing", () => {
  it("parses indexed SSH_MCP_SERVER profiles with uniform field names", () => {
    const variables = parseEnvFile(`
SSH_MCP_SERVER_1_IP=140.143.165.206
SSH_MCP_SERVER_1_PORT=22
SSH_MCP_SERVER_1_NAME=prod
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_PASSWORD="change-me"
SSH_MCP_SERVER_1_ALIASES=production,ai-chat-prod
SSH_MCP_SERVER_1_DEFAULT_DIR=/opt/ai-chat
SSH_MCP_SERVER_1_DESCRIPTION="production server"
SSH_MCP_SERVER_1_PLATFORM=linux

SSH_MCP_SERVER_2_HOST=staging.example.com
SSH_MCP_SERVER_2_USER=deploy
SSH_MCP_SERVER_2_NAME=staging
SSH_MCP_SERVER_2_DISPLAY_NAME="Staging Server"
`);

    const profiles = parseProfiles(variables, "test.env");

    expect(profiles.get("PROD")).toMatchObject({
      name: "PROD",
      aliases: ["production", "ai-chat-prod"],
      host: "140.143.165.206",
      port: 22,
      username: "root",
      password: "change-me",
      defaultDir: "/opt/ai-chat",
      description: "production server",
      platform: "linux",
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

  it("parses SSH_SERVER profiles with quoted values and underscores", () => {
    const variables = parseEnvFile(`
SSH_SERVER_AI_CHAT_PROD_HOST=140.143.165.206
SSH_SERVER_AI_CHAT_PROD_NAME=prod
SSH_SERVER_AI_CHAT_PROD_ALIASES=ai-chat-prod,prod,production
SSH_SERVER_AI_CHAT_PROD_USER=root
SSH_SERVER_AI_CHAT_PROD_PASSWORD="p.ku5#x6"
SSH_SERVER_AI_CHAT_PROD_PORT=22
SSH_SERVER_AI_CHAT_PROD_DEFAULT_DIR=/opt/ai-chat
SSH_SERVER_AI_CHAT_PROD_DESCRIPTION="ai-chat production server"
SSH_SERVER_AI_CHAT_PROD_PLATFORM=linux
`);

    const profiles = parseProfiles(variables, "test.env");
    const profile = profiles.get("AI_CHAT_PROD");

    expect(profile).toMatchObject({
      name: "AI_CHAT_PROD",
      displayName: "prod",
      aliases: ["ai-chat-prod", "prod", "production"],
      host: "140.143.165.206",
      port: 22,
      username: "root",
      password: "p.ku5#x6",
      defaultDir: "/opt/ai-chat",
      description: "ai-chat production server",
      platform: "linux",
    });
  });

  it("does not expose secrets in public profiles", () => {
    const variables = parseEnvFile(`
SSH_SERVER_EXAMPLE_HOST=example.com
SSH_SERVER_EXAMPLE_NAME=example
SSH_SERVER_EXAMPLE_ALIASES=example,example-prod
SSH_SERVER_EXAMPLE_USERNAME=deploy
SSH_SERVER_EXAMPLE_PASSWORD=secret
SSH_SERVER_EXAMPLE_PRIVATE_KEY="private-key"
SSH_SERVER_EXAMPLE_PRIVATE_KEY_PATH=C:/keys/example
SSH_SERVER_EXAMPLE_PASSPHRASE=passphrase
SSH_SERVER_EXAMPLE_AGENT=pageant
`);

    const profile = parseProfiles(variables, "test.env").get("EXAMPLE");
    expect(profile).toBeDefined();
    const publicValue = publicProfile(profile!);

    expect(publicValue).toMatchObject({
      name: "EXAMPLE",
      displayName: "example",
      aliases: ["example", "example-prod"],
      host: "example.com",
      username: "deploy",
      hasPassword: true,
      hasPrivateKey: true,
      hasPrivateKeyPath: true,
      hasPassphrase: true,
      hasAgent: true,
    });
    expect(JSON.stringify(publicValue)).not.toContain("secret");
    expect(JSON.stringify(publicValue)).not.toContain("private-key");
  });

  it("resolves profiles by formal name, display name, and aliases", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-mcp-profile-test-"));
    const envPath = join(tempDir, ".env");

    try {
      await writeFile(
        envPath,
        `
SSH_SERVER_AI_CHAT_PROD_HOST=example.com
SSH_SERVER_AI_CHAT_PROD_NAME=prod
SSH_SERVER_AI_CHAT_PROD_ALIASES=ai-chat-prod,production
SSH_SERVER_AI_CHAT_PROD_USER=root
`,
        "utf8",
      );

      const registry = new ProfileRegistry(envPath);

      expect(registry.get("AI_CHAT_PROD").name).toBe("AI_CHAT_PROD");
      expect(registry.get("prod").name).toBe("AI_CHAT_PROD");
      expect(registry.get("ai-chat-prod").name).toBe("AI_CHAT_PROD");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
