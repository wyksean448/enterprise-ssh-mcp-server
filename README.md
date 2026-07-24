# Enterprise SSH MCP Server

一个基于 `@modelcontextprotocol/sdk` 和 `ssh2` 的 SSH/SFTP MCP stdio server。它把 SSH 连接作为 MCP server 进程内的持久会话保存，支持复用同一个连接执行命令、交互 shell、SFTP 文件管理、大文件后台传输和端口转发。

## 安装与构建

```powershell
npm install
npm run build
```

MCP client 配置示例：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "node",
      "args": ["D:/studyProject/skills/ssh/dist/index.js"]
    }
  }
}
```

开发期也可以用：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "npm",
      "args": ["--prefix", "D:/studyProject/skills/ssh", "run", "dev"]
    }
  }
}
```

## 能力范围

- Profile：`ssh_list_profiles`、`ssh_reload_profiles`、`ssh_connect_profile`、`ssh_run_profile`
- 会话：`ssh_connect`、`ssh_list_sessions`、`ssh_disconnect`、`ssh_disconnect_all`、`ssh_rekey`
- 命令：`ssh_exec`，支持 env、stdin、PTY、超时、stdout/stderr 最大字节限制、UTF-8/base64 输出
- 交互 shell：`ssh_shell_open`、`ssh_shell_write`、`ssh_shell_read`、`ssh_shell_resize`、`ssh_shell_close`、`ssh_shell_list`
- SFTP 管理：`sftp_list`、`sftp_stat`、`sftp_read_file`、`sftp_write_file`、`sftp_mkdir`、`sftp_rm`、`sftp_rename`、`sftp_chmod`、`sftp_chown`、`sftp_touch`、`sftp_symlink`、`sftp_readlink`、`sftp_realpath`
- 大文件传输：`sftp_upload_start`、`sftp_upload_profile`、`sftp_download_start`、`sftp_download_profile`、`sftp_transfer_status`、`sftp_transfer_list`、`sftp_transfer_cancel`
- 端口转发：`ssh_tunnel_local_start`、`ssh_tunnel_remote_start`、`ssh_tunnel_list`、`ssh_tunnel_stop`

## 大文件上传策略

大文件不要用 `sftp_write_file`。请使用 `sftp_upload_start`：

1. 工具会立即返回 `transfer.id`，实际上传在后台继续跑，避免 MCP 单次调用因为传输时间太长而超时。
2. 用 `sftp_transfer_status` 轮询进度，返回 `transferredBytes`、`totalBytes`、`percent`、`bytesPerSecond`、`etaSeconds`、`state`。
3. 默认 `resume=true`，如果远端已有部分文件，会从远端大小对应的 offset 继续写。
4. `sftp_transfer_cancel` 会销毁本地/远端 stream，状态变成 `cancelled`。
5. `atomic=false` 适合可续传的大文件；`atomic=true` 会先写临时路径，成功后 rename 到目标路径，适合发布工件，但续传时要保留同一个 `remoteTempPath`。

下载同理，使用 `sftp_download_start`。默认会创建本地父目录，并支持从本地已有文件大小处继续下载。

## .env SSH Profile

MCP server 启动时会读取项目根目录的 `.env`。如果你的 MCP client 从其他目录启动，也可以用 `SSH_MCP_ENV_FILE` 指定绝对路径。

运行时默认策略：

```dotenv
SSH_MCP_DEFAULT_SSH_PORT=22
SSH_MCP_TOOLSET=agent
SSH_MCP_COMPACT_JSON=true
SSH_MCP_ENABLE_DANGEROUS_TOOLS=false
SSH_MCP_DEFAULT_AGENT_FORWARD=false
SSH_MCP_DEFAULT_TRY_KEYBOARD=false
SSH_MCP_DEFAULT_KEEPALIVE_INTERVAL_MS=10000
SSH_MCP_DEFAULT_KEEPALIVE_COUNT_MAX=3
SSH_MCP_DEFAULT_READY_TIMEOUT_MS=20000
SSH_MCP_DEFAULT_CONNECTION_TIMEOUT_MS=30000
SSH_MCP_DEFAULT_EXEC_TIMEOUT_MS=60000
SSH_MCP_DEFAULT_MAX_OUTPUT_BYTES=1048576
SSH_MCP_DEFAULT_SHELL_ALLOCATE_PTY=true
SSH_MCP_DEFAULT_SHELL_RING_BUFFER_BYTES=1048576
SSH_MCP_DEFAULT_SHELL_READ_MAX_BYTES=262144
SSH_MCP_DEFAULT_SFTP_READ_MAX_BYTES=1048576
SSH_MCP_DEFAULT_TRANSFER_CHUNK_SIZE_BYTES=1048576
SSH_MCP_DEFAULT_TRANSFER_RESUME=true
SSH_MCP_DEFAULT_TRANSFER_OVERWRITE=false
SSH_MCP_DEFAULT_TRANSFER_ATOMIC=false
SSH_MCP_DEFAULT_LOCAL_TUNNEL_HOST=127.0.0.1
SSH_MCP_DEFAULT_REMOTE_TUNNEL_HOST=127.0.0.1
```

这些值是工具参数省略时的默认值；单次调用仍然可以传参覆盖。用 `ssh_get_config` 查看当前生效值，用 `ssh_reload_config` 重新读取 `.env`。

Agent 友好开关：

- `SSH_MCP_TOOLSET=agent`：只暴露常用安全工具，减少 agent 选错工具；设为 `full` 会暴露全部工具。
- `SSH_MCP_COMPACT_JSON=true`：返回紧凑 JSON，减少 token 噪音。
- `SSH_MCP_ENABLE_DANGEROUS_TOOLS=false`：隐藏 `rm/chmod/chown/tunnel/disconnect_all` 这类高风险工具。
- 工具可见性在 MCP server 启动时确定；修改 `TOOLSET` 或危险工具开关后需要重启 MCP 客户端或新开会话。

格式：

```dotenv
SSH_SERVER_EXAMPLE_HOST=example.com
SSH_SERVER_EXAMPLE_NAME=example
SSH_SERVER_EXAMPLE_ALIASES=example,example-prod
SSH_SERVER_EXAMPLE_USER=root
SSH_SERVER_EXAMPLE_PASSWORD="change-me"
SSH_SERVER_EXAMPLE_PORT=22
SSH_SERVER_EXAMPLE_DEFAULT_DIR=/opt/app
SSH_SERVER_EXAMPLE_DESCRIPTION="example server"
SSH_SERVER_EXAMPLE_PLATFORM=linux
```

这里正式 profile 名是 `EXAMPLE`。如果变量是 `SSH_SERVER_AI_CHAT_PROD_HOST`，正式名就是 `AI_CHAT_PROD`。`NAME` 是推荐短名，`ALIASES` 是逗号分隔别名；`ssh_connect_profile` 接受正式名、短名或任一别名。

使用流程：

1. `ssh_list_profiles` 查看可用 profile。返回结果只包含 `hasPassword` 等布尔值，不返回密码。
2. `ssh_connect_profile` 传 `profileName`，例如 `AI_CHAT_PROD`、`prod` 或 `ai-chat-prod`。
3. 拿返回的 `session.id` 调用 `ssh_exec`、`ssh_shell_open`、SFTP 或 tunnel 工具。

## 安全说明

- 不会在返回值里回显 password/privateKey/passphrase。
- `.env` 已被 `.gitignore` 忽略；`.env.example` 只放占位符。
- 生产环境建议在 `ssh_connect` 传入 `hostHash` 和 `expectedHostHash` 做主机指纹校验。
- `sftp_rm` 删除目录必须显式传 `recursive=true`。
- `ssh_exec` 和 `sftp_read_file` 都有默认输出大小上限，大文件请走后台 transfer job。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```
