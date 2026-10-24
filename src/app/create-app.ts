import { toolContext } from "./tool-context.js";
import { startEnvHotReload } from "../env-reload.js";
import { registerConfigProfileTools } from "../tools/register-config-profile-tools.js";
import { registerProjectTools } from "../tools/register-project-tools.js";
import { registerSessionTools } from "../tools/register-session-tools.js";
import { registerSftpTools } from "../tools/register-sftp-tools.js";
import { registerTransferTools } from "../tools/register-transfer-tools.js";
import { registerTunnelTools } from "../tools/register-tunnel-tools.js";

export function createApp() {
  registerConfigProfileTools(toolContext);
  registerProjectTools(toolContext);
  registerSessionTools(toolContext);
  registerSftpTools(toolContext);
  registerTransferTools(toolContext);
  registerTunnelTools(toolContext);

  const stopEnvHotReload = startEnvHotReload({
    envPath: toolContext.envPath,
    reload: toolContext.reloadEnvState,
    onReload: (snapshot) => {
      const restartNote = snapshot.restartRequiredForToolVisibility
        ? "; tool visibility settings differ from startup and require an MCP restart"
        : "";
      process.stderr.write(
        `[ssh-mcp] .env hot-reloaded (${snapshot.profiles.length} profile(s))${restartNote}\n`,
      );
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "unknown configuration error";
      process.stderr.write(`[ssh-mcp] .env hot reload rejected; previous settings remain active (${message})\n`);
    },
  });

  return {
    server: toolContext.server,
    shutdown: async (): Promise<void> => {
      stopEnvHotReload();
      await toolContext.sessions.disconnectAll();
    },
  };
}
