import { unwatchFile, watchFile, type Stats } from "node:fs";

import {
  loadProfilesFromEnvFile,
  ProfileRegistry,
  type PublicSshServerProfile,
} from "./env-profiles.js";
import { loadRuntimeConfig, RuntimeConfigRegistry, type RuntimeConfig, type Toolset } from "./runtime-config.js";

export interface StartupToolExposure {
  toolset: Toolset;
  enableDangerousTools: boolean;
}

export interface EnvReloadSnapshot {
  config: RuntimeConfig;
  profiles: PublicSshServerProfile[];
  restartRequiredForToolVisibility: boolean;
}

/**
 * Parse the complete .env snapshot before mutating either registry. If either
 * parser rejects the file, the previously active config and profiles remain.
 */
export function reloadEnvSnapshot(input: {
  envPath: string;
  runtimeConfig: RuntimeConfigRegistry;
  profiles: ProfileRegistry;
  startupToolExposure: StartupToolExposure;
  setCompactJsonResponse: (enabled: boolean) => void;
}): EnvReloadSnapshot {
  const nextConfig = loadRuntimeConfig(input.envPath);
  const nextProfiles = loadProfilesFromEnvFile(input.envPath);

  // Both loads succeeded; now commit the validated snapshot.
  input.runtimeConfig.replace(nextConfig);
  const publicProfiles = input.profiles.replace(nextProfiles);
  input.setCompactJsonResponse(nextConfig.compactJson);

  return {
    config: nextConfig,
    profiles: publicProfiles,
    restartRequiredForToolVisibility:
      nextConfig.toolset !== input.startupToolExposure.toolset
      || nextConfig.enableDangerousTools !== input.startupToolExposure.enableDangerousTools,
  };
}

export interface EnvHotReloadOptions {
  envPath: string;
  reload: () => EnvReloadSnapshot;
  onReload?: (snapshot: EnvReloadSnapshot) => void;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  debounceMs?: number;
}

function statSignature(stats: Stats): string {
  return [stats.mtimeMs, stats.ctimeMs, stats.size, stats.ino].join(":");
}

/**
 * Poll .env so edits and atomic editor-save/rename patterns are detected on
 * Windows, macOS, and Linux. Invalid/partial writes are rejected by reload()
 * and leave the last valid in-memory snapshot active.
 */
export function startEnvHotReload(options: EnvHotReloadOptions): () => void {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const debounceMs = options.debounceMs ?? 300;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const listener = (current: Stats, previous: Stats): void => {
    if (statSignature(current) === statSignature(previous)) {
      return;
    }

    if (timer !== undefined) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        return;
      }

      try {
        options.onReload?.(options.reload());
      } catch (error) {
        options.onError?.(error);
      }
    }, debounceMs);
  };

  watchFile(options.envPath, { interval: pollIntervalMs, persistent: false }, listener);

  return (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    unwatchFile(options.envPath, listener);
  };
}
