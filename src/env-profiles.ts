import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpToolError } from "./tool-result.js";

export interface SshServerProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  sourcePath: string;
  aliases: string[];
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  displayName?: string;
  defaultDir?: string;
  description?: string;
  platform?: string;
  allowEdit?: boolean;
  editRoot?: string;
  maxEditFileBytes?: number;
  backupBeforeEdit?: boolean;
  backupDir?: string;
  allowDelete?: boolean;
  allowBinaryEdit?: boolean;
}

export interface PublicSshServerProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  sourcePath: string;
  aliases: string[];
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPrivateKeyPath: boolean;
  hasPassphrase: boolean;
  hasAgent: boolean;
  displayName?: string;
  defaultDir?: string;
  description?: string;
  platform?: string;
  allowEdit: boolean;
  editRoot?: string;
  maxEditFileBytes?: number;
  backupBeforeEdit: boolean;
  backupDir?: string;
  allowDelete: boolean;
  allowBinaryEdit: boolean;
}

type ProfileField =
  | "host"
  | "port"
  | "username"
  | "password"
  | "privateKey"
  | "privateKeyPath"
  | "passphrase"
  | "agent"
  | "displayName"
  | "aliases"
  | "defaultDir"
  | "description"
  | "platform"
  | "allowEdit"
  | "editRoot"
  | "maxEditFileBytes"
  | "backupBeforeEdit"
  | "backupDir"
  | "allowDelete"
  | "allowBinaryEdit";

const INDEXED_ENV_PREFIX = "SSH_MCP_SERVER_";
const LEGACY_ENV_PREFIX = "SSH_SERVER_";
type ParsedProfileField = { groupKey: string; field: ProfileField | "profileName" };

const FIELD_SUFFIXES: Array<{ suffix: string; field: ProfileField }> = [
  { suffix: "PRIVATE_KEY_PATH", field: "privateKeyPath" },
  { suffix: "DISPLAY_NAME", field: "displayName" },
  { suffix: "DEFAULT_DIR", field: "defaultDir" },
  { suffix: "MAX_EDIT_FILE_BYTES", field: "maxEditFileBytes" },
  { suffix: "BACKUP_BEFORE_EDIT", field: "backupBeforeEdit" },
  { suffix: "ALLOW_BINARY_EDIT", field: "allowBinaryEdit" },
  { suffix: "PRIVATE_KEY", field: "privateKey" },
  { suffix: "DESCRIPTION", field: "description" },
  { suffix: "PASSPHRASE", field: "passphrase" },
  { suffix: "ALLOW_DELETE", field: "allowDelete" },
  { suffix: "ALLOW_EDIT", field: "allowEdit" },
  { suffix: "ALIASES", field: "aliases" },
  { suffix: "PLATFORM", field: "platform" },
  { suffix: "PASSWORD", field: "password" },
  { suffix: "USERNAME", field: "username" },
  { suffix: "BACKUP_DIR", field: "backupDir" },
  { suffix: "EDIT_ROOT", field: "editRoot" },
  { suffix: "AGENT", field: "agent" },
  { suffix: "HOST", field: "host" },
  { suffix: "IP", field: "host" },
  { suffix: "PORT", field: "port" },
  { suffix: "USER", field: "username" },
];

export class ProfileRegistry {
  private readonly envPath: string;
  private profiles = new Map<string, SshServerProfile>();

  public constructor(envPath: string) {
    this.envPath = envPath;
    this.reload();
  }

  public reload(): PublicSshServerProfile[] {
    this.profiles = loadProfilesFromEnvFile(this.envPath);
    return this.list();
  }

  public list(): PublicSshServerProfile[] {
    return [...this.profiles.values()]
      .map((profile) => publicProfile(profile))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public get(profileName: string): SshServerProfile {
    const normalizedName = normalizeProfileName(profileName);
    const directProfile = this.profiles.get(normalizedName);
    if (directProfile !== undefined) {
      return directProfile;
    }

    const aliasMatches = [...this.profiles.values()].filter((profile) => profileMatchesName(profile, normalizedName));
    if (aliasMatches.length === 1) {
      const match = aliasMatches[0];
      if (match !== undefined) {
        return match;
      }
    }
    if (aliasMatches.length > 1) {
      throw new McpToolError("ssh_profile_name_ambiguous", "SSH profile name matched multiple profiles", {
        profileName,
        matches: aliasMatches.map((profile) => profile.name),
        envPath: this.envPath,
      });
    }

    {
      throw new McpToolError("ssh_profile_not_found", "SSH profile was not found in .env", {
        profileName,
        envPath: this.envPath,
      });
    }
  }

  public sourcePath(): string {
    return this.envPath;
  }
}

export function defaultEnvPath(): string {
  if (process.env.SSH_MCP_ENV_FILE !== undefined && process.env.SSH_MCP_ENV_FILE.trim().length > 0) {
    return resolve(process.env.SSH_MCP_ENV_FILE);
  }

  return resolve(projectRootFromEntrypoint(), ".env");
}

export function loadProfilesFromEnvFile(envPath: string): Map<string, SshServerProfile> {
  if (!existsSync(envPath)) {
    return new Map();
  }

  const variables = parseEnvFile(readFileSync(envPath, "utf8"));
  return parseProfiles(variables, envPath);
}

export function parseEnvFile(content: string): Map<string, string> {
  const variables = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 1) {
      throw new McpToolError("invalid_env_line", "Invalid .env line; expected KEY=value", {
        lineNumber: lineIndex + 1,
      });
    }

    const rawKey = line.slice(0, equalsIndex).trim();
    const key = rawKey.startsWith("export ") ? rawKey.slice("export ".length).trim() : rawKey;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new McpToolError("invalid_env_key", "Invalid .env key", { lineNumber: lineIndex + 1, key });
    }

    variables.set(key, parseEnvValue(line.slice(equalsIndex + 1), lineIndex + 1));
  }

  return variables;
}

export function parseProfiles(variables: Map<string, string>, sourcePath: string): Map<string, SshServerProfile> {
  const partialProfiles = new Map<string, Partial<SshServerProfile> & { name: string; sourcePath: string }>();

  for (const [key, value] of variables.entries()) {
    assertSupportedProfileKey(key, sourcePath);
    const profileField = parseIndexedProfileField(key);
    if (profileField === undefined) {
      continue;
    }

    const existing = partialProfiles.get(profileField.groupKey) ?? {
      name: "",
      sourcePath,
    };
    if (profileField.field === "profileName") {
      setProfileName(existing, value);
    } else {
      setProfileField(existing, profileField.field, value);
    }
    partialProfiles.set(profileField.groupKey, existing);
  }

  const profiles = new Map<string, SshServerProfile>();
  for (const profile of partialProfiles.values()) {
    const completedProfile = completeProfile(profile);
    if (profiles.has(completedProfile.name)) {
      throw new McpToolError("duplicate_ssh_profile_name", "SSH profile name is duplicated", {
        profileName: completedProfile.name,
      });
    }
    profiles.set(completedProfile.name, completedProfile);
  }
  return profiles;
}

function assertSupportedProfileKey(key: string, sourcePath: string): void {
  if (key.startsWith(LEGACY_ENV_PREFIX)) {
    throw new McpToolError("unsupported_ssh_profile_env_schema", "Unsupported SSH profile env schema", {
      key,
      sourcePath,
      expected: "SSH_MCP_SERVER_<N>_<FIELD>",
      example: "SSH_MCP_SERVER_1_NAME=prod",
    });
  }

  if (!key.startsWith(INDEXED_ENV_PREFIX)) {
    return;
  }

  const profileField = parseIndexedProfileField(key);
  if (profileField !== undefined) {
    return;
  }

  throw new McpToolError("invalid_ssh_profile_env_key", "Invalid SSH profile env key", {
    key,
    sourcePath,
    expected: "SSH_MCP_SERVER_<N>_<FIELD>",
    allowedFields: ["NAME", ...FIELD_SUFFIXES.map((field) => field.suffix)],
  });
}

export function publicProfile(profile: SshServerProfile): PublicSshServerProfile {
  const publicValue: PublicSshServerProfile = {
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    sourcePath: profile.sourcePath,
    aliases: profile.aliases,
    hasPassword: profile.password !== undefined,
    hasPrivateKey: profile.privateKey !== undefined,
    hasPrivateKeyPath: profile.privateKeyPath !== undefined,
    hasPassphrase: profile.passphrase !== undefined,
    hasAgent: profile.agent !== undefined,
    allowEdit: profile.allowEdit ?? false,
    backupBeforeEdit: profile.backupBeforeEdit ?? true,
    allowDelete: profile.allowDelete ?? false,
    allowBinaryEdit: profile.allowBinaryEdit ?? false,
  };

  if (profile.displayName !== undefined) {
    publicValue.displayName = profile.displayName;
  }
  if (profile.defaultDir !== undefined) {
    publicValue.defaultDir = profile.defaultDir;
  }
  if (profile.description !== undefined) {
    publicValue.description = profile.description;
  }
  if (profile.platform !== undefined) {
    publicValue.platform = profile.platform;
  }
  if (profile.editRoot !== undefined) {
    publicValue.editRoot = profile.editRoot;
  }
  if (profile.maxEditFileBytes !== undefined) {
    publicValue.maxEditFileBytes = profile.maxEditFileBytes;
  }
  if (profile.backupDir !== undefined) {
    publicValue.backupDir = profile.backupDir;
  }
  return publicValue;
}

function parseEnvValue(rawValue: string, lineNumber: number): string {
  const value = rawValue.trimStart();
  if (value.startsWith('"')) {
    return parseDoubleQuotedValue(value, lineNumber);
  }
  if (value.startsWith("'")) {
    return parseSingleQuotedValue(value, lineNumber);
  }

  const commentIndex = value.search(/\s#/);
  const unquotedValue = commentIndex === -1 ? value : value.slice(0, commentIndex);
  return unquotedValue.trim();
}

function parseDoubleQuotedValue(value: string, lineNumber: number): string {
  let output = "";
  let escaped = false;

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) {
      break;
    }

    if (escaped) {
      output += unescapeDoubleQuotedChar(char);
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return output;
    }

    output += char;
  }

  throw new McpToolError("invalid_env_value", "Unclosed double-quoted .env value", { lineNumber });
}

function parseSingleQuotedValue(value: string, lineNumber: number): string {
  const closingQuoteIndex = value.indexOf("'", 1);
  if (closingQuoteIndex === -1) {
    throw new McpToolError("invalid_env_value", "Unclosed single-quoted .env value", { lineNumber });
  }
  return value.slice(1, closingQuoteIndex);
}

function unescapeDoubleQuotedChar(char: string): string {
  if (char === "n") {
    return "\n";
  }
  if (char === "r") {
    return "\r";
  }
  if (char === "t") {
    return "\t";
  }
  return char;
}

function parseIndexedProfileField(key: string): ParsedProfileField | undefined {
  if (!key.startsWith(INDEXED_ENV_PREFIX)) {
    return undefined;
  }

  const rest = key.slice(INDEXED_ENV_PREFIX.length);
  const separatorIndex = rest.indexOf("_");
  if (separatorIndex < 1) {
    return undefined;
  }

  const index = rest.slice(0, separatorIndex);
  if (!/^[1-9][0-9]*$/.test(index)) {
    return undefined;
  }

  const suffix = rest.slice(separatorIndex + 1);
  if (suffix === "NAME") {
    return {
      groupKey: `indexed:${index}`,
      field: "profileName",
    };
  }

  const profileField = FIELD_SUFFIXES.find((candidate) => candidate.suffix === suffix);
  if (profileField === undefined) {
    return undefined;
  }

  return {
    groupKey: `indexed:${index}`,
    field: profileField.field,
  };
}

function setProfileName(profile: Partial<SshServerProfile> & { name: string; sourcePath: string }, value: string): void {
  if (value.trim().length === 0) {
    return;
  }

  profile.name = normalizeProfileName(value);
}

function setProfileField(
  profile: Partial<SshServerProfile> & { name: string; sourcePath: string },
  field: ProfileField,
  value: string,
): void {
  if (value.length === 0) {
    return;
  }

  if (field === "port") {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new McpToolError("invalid_ssh_profile_port", "SSH profile port must be 1-65535", {
        profileName: profile.name,
        value,
      });
    }
    profile.port = port;
    return;
  }

  if (field === "aliases") {
    profile.aliases = value
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 0);
    return;
  }

  if (field === "allowEdit" || field === "backupBeforeEdit" || field === "allowDelete" || field === "allowBinaryEdit") {
    profile[field] = parseBooleanProfileField(field, value, profile.name);
    return;
  }

  if (field === "maxEditFileBytes") {
    profile.maxEditFileBytes = parseIntegerProfileField(field, value, profile.name, 1, 64 * 1024 * 1024);
    return;
  }

  profile[field] = value;
}

function completeProfile(profile: Partial<SshServerProfile> & { name: string; sourcePath: string }): SshServerProfile {
  if (profile.name.length === 0) {
    throw new McpToolError("invalid_ssh_profile", "SSH profile is missing NAME", { sourcePath: profile.sourcePath });
  }
  if (profile.host === undefined) {
    throw new McpToolError("invalid_ssh_profile", "SSH profile is missing HOST", { profileName: profile.name });
  }
  if (profile.username === undefined) {
    throw new McpToolError("invalid_ssh_profile", "SSH profile is missing USER or USERNAME", {
      profileName: profile.name,
    });
  }

  return {
    name: profile.name,
    host: profile.host,
    port: profile.port ?? 22,
    username: profile.username,
    sourcePath: profile.sourcePath,
    aliases: profile.aliases ?? [],
    ...(profile.password === undefined ? {} : { password: profile.password }),
    ...(profile.privateKey === undefined ? {} : { privateKey: profile.privateKey }),
    ...(profile.privateKeyPath === undefined ? {} : { privateKeyPath: profile.privateKeyPath }),
    ...(profile.passphrase === undefined ? {} : { passphrase: profile.passphrase }),
    ...(profile.agent === undefined ? {} : { agent: profile.agent }),
    ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
    ...(profile.defaultDir === undefined ? {} : { defaultDir: profile.defaultDir }),
    ...(profile.description === undefined ? {} : { description: profile.description }),
    ...(profile.platform === undefined ? {} : { platform: profile.platform }),
    ...(profile.allowEdit === undefined ? {} : { allowEdit: profile.allowEdit }),
    ...(profile.editRoot === undefined ? {} : { editRoot: profile.editRoot }),
    ...(profile.maxEditFileBytes === undefined ? {} : { maxEditFileBytes: profile.maxEditFileBytes }),
    ...(profile.backupBeforeEdit === undefined ? {} : { backupBeforeEdit: profile.backupBeforeEdit }),
    ...(profile.backupDir === undefined ? {} : { backupDir: profile.backupDir }),
    ...(profile.allowDelete === undefined ? {} : { allowDelete: profile.allowDelete }),
    ...(profile.allowBinaryEdit === undefined ? {} : { allowBinaryEdit: profile.allowBinaryEdit }),
  };
}

function parseBooleanProfileField(field: ProfileField, value: string, profileName: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new McpToolError("invalid_ssh_profile_boolean", "SSH profile boolean field is invalid", {
    profileName,
    field,
    value,
  });
}

function parseIntegerProfileField(
  field: ProfileField,
  value: string,
  profileName: string,
  minInclusive: number,
  maxInclusive: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new McpToolError("invalid_ssh_profile_integer", "SSH profile integer field is invalid", {
      profileName,
      field,
      value,
    });
  }
  if (parsed < minInclusive || parsed > maxInclusive) {
    throw new McpToolError("invalid_ssh_profile_integer", "SSH profile integer field is outside the allowed range", {
      profileName,
      field,
      value,
      minInclusive,
      maxInclusive,
    });
  }
  return parsed;
}

function normalizeProfileName(profileName: string): string {
  return profileName.trim().replace(/[\s-]+/g, "_").toUpperCase();
}

function profileMatchesName(profile: SshServerProfile, normalizedName: string): boolean {
  return profile.aliases.some((alias) => normalizeProfileName(alias) === normalizedName);
}

function projectRootFromEntrypoint(): string {
  const entrypointDir = dirname(fileURLToPath(import.meta.url));
  const leaf = entrypointDir.replace(/\\/g, "/").split("/").at(-1);
  if (leaf === "dist" || leaf === "src") {
    return dirname(entrypointDir);
  }

  return process.cwd();
}
