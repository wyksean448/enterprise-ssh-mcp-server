# Enterprise SSH MCP Server

一个基于 `@modelcontextprotocol/sdk` 和 `ssh2` 的 SSH/SFTP MCP stdio server。它把 SSH 连接作为 MCP server 进程内的持久会话保存，支持复用同一个连接执行命令、交互 shell、SFTP 文件管理、大文件后台传输和端口转发。

## 安装与使用

推荐直接通过 npm 启动，无需全局安装。

Windows MCP client 配置：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "enterprise-ssh-mcp-server"]
    }
  }
}
```

macOS / Linux MCP client 配置：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "npx",
      "args": ["-y", "enterprise-ssh-mcp-server"]
    }
  }
}
```

如果已经全局安装：

```powershell
npm install -g enterprise-ssh-mcp-server
```

Windows 推荐通过 `cmd /c` 启动 npm 生成的 `.cmd` 命令入口，避免 PowerShell 执行策略影响：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "cmd",
      "args": ["/c", "enterprise-ssh-mcp"]
    }
  }
}
```

macOS / Linux 全局安装后可以直接使用命令入口：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "enterprise-ssh-mcp",
      "args": []
    }
  }
}
```

如需指定 SSH profile 配置文件：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "cmd",
      "args": ["/c", "enterprise-ssh-mcp"],
      "env": {
        "SSH_MCP_ENV_FILE": "C:\\Users\\yourname\\.enterprise-ssh-mcp\\.env"
      }
    }
  }
}
```

## 本地开发

```powershell
npm install
npm run build
```

开发期可以用：

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

- Profile：`ssh_list_profiles`、`ssh_reload_profiles`、`ssh_connect_profile`、`ssh_check_profile`、`ssh_run_profile`
- 会话：`ssh_connect`、`ssh_list_sessions`、`ssh_disconnect`、`ssh_disconnect_all`、`ssh_rekey`
- 命令：`ssh_exec`，支持 env、stdin、PTY、超时、stdout/stderr 最大字节限制、UTF-8/base64 输出
- 远程项目编辑：`ssh_project_open`、`ssh_project_tree`、`ssh_project_search`、`ssh_project_stat`、`ssh_file_read`、`ssh_file_patch`、`ssh_project_validate_patch`、`ssh_project_apply_patch`、`ssh_project_diff`、`ssh_project_run_checks`、`ssh_edit_history`、`ssh_edit_rollback`
- 交互 shell：`ssh_shell_open`、`ssh_shell_write`、`ssh_shell_read`、`ssh_shell_resize`、`ssh_shell_close`、`ssh_shell_list`
- SFTP 管理：`sftp_list`、`sftp_stat`、`sftp_read_file`、`sftp_write_file`、`sftp_mkdir`、`sftp_rm`、`sftp_rename`、`sftp_chmod`、`sftp_chown`、`sftp_touch`、`sftp_symlink`、`sftp_readlink`、`sftp_realpath`
- 大文件传输：`sftp_upload_start`、`sftp_upload_profile`、`sftp_download_start`、`sftp_download_profile`、`sftp_transfer_status`、`sftp_transfer_list`、`sftp_transfer_cancel`
- 端口转发：`ssh_tunnel_local_start`、`ssh_tunnel_remote_start`、`ssh_tunnel_list`、`ssh_tunnel_stop`

## Agent 使用建议

- 远端健康检查、环境确认、服务器巡检：优先使用 `ssh_check_profile`。
- 远程查看/修改项目代码：优先使用 `ssh_project_tree`、`ssh_project_search`、`ssh_file_read`、`ssh_file_patch`、`ssh_project_apply_patch`、`ssh_project_diff`，不要用 shell 拼 `sed`、`cat > file` 来改代码。
- 单条远端命令：优先使用 `ssh_run_profile`，避免先 connect 再 exec。
- 需要连续多步操作、交互 shell、SFTP 批量操作、后台传输或 tunnel 时，再使用 `ssh_connect_profile` 创建持久会话。
- 不要用本地 shell 模拟远端检查；已经配置 SSH profile 时，应调用 MCP SSH 工具。
- 默认 `agent` 模式会隐藏 tunnel、裸 SFTP 写入/上传/删除/移动、chmod、chown、disconnect_all 等高风险工具；如确实需要，显式设置 `SSH_MCP_TOOLSET=full` 和 `SSH_MCP_ENABLE_DANGEROUS_TOOLS=true` 后重启 MCP client。

## 远程项目编辑

编辑工具以 profile 的 `EDIT_ROOT` 或 `DEFAULT_DIR` 作为硬安全边界，`projectRoot` 只能是这个边界内的子目录。写入和 patch 默认要求 `expectedSha256`，也就是先 `ssh_file_read` 读到文件指纹，再带着这个指纹修改，防止覆盖别人刚改过的文件。

推荐工作流：

1. `ssh_project_open`：确认远程项目根目录、git 状态和项目类型。
2. `ssh_project_tree` / `ssh_project_search`：定位要修改的代码。
3. `ssh_file_read`：读取目标文件，拿到 `sha256`。
4. `ssh_file_patch` 或 `ssh_project_apply_patch`：应用单文件或多文件 unified diff。
5. `ssh_project_diff`：查看远程 git diff。
6. `ssh_project_run_checks`：运行测试、构建或 lint。
7. 如需撤回，用 `ssh_edit_history` 找到 `editId`，再调用 `ssh_edit_rollback`。

写入类工具会先保存备份，再用临时文件 + rename 方式原子替换。`ssh_file_write`、`ssh_file_delete`、`ssh_file_move` 属于高风险工具，默认隐藏；常规代码修改应优先使用 patch 工具。

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
SSH_MCP_DEFAULT_MAX_EDIT_FILE_BYTES=1048576
SSH_MCP_DEFAULT_MAX_PATCH_BYTES=2097152
SSH_MCP_DEFAULT_LOCAL_TUNNEL_HOST=127.0.0.1
SSH_MCP_DEFAULT_REMOTE_TUNNEL_HOST=127.0.0.1
```

这些值是工具参数省略时的默认值；单次调用仍然可以传参覆盖。用 `ssh_get_config` 查看当前生效值，用 `ssh_reload_config` 重新读取 `.env`。

Agent 友好开关：

- `SSH_MCP_TOOLSET=agent`：只暴露常用安全工具，减少 agent 选错工具；设为 `full` 会暴露全部工具。
- `SSH_MCP_COMPACT_JSON=true`：返回紧凑 JSON，减少 token 噪音。
- `SSH_MCP_ENABLE_DANGEROUS_TOOLS=false`：隐藏 `rm/chmod/chown/tunnel/disconnect_all` 这类高风险工具。
- 工具可见性在 MCP server 启动时确定；修改 `TOOLSET` 或危险工具开关后需要重启 MCP 客户端或新开会话。

推荐使用统一 indexed profile 格式。每台服务器都使用同一组字段，只用序号区分：

```dotenv
SSH_MCP_SERVER_1_NAME=prod
SSH_MCP_SERVER_1_IP=140.143.165.206
SSH_MCP_SERVER_1_PORT=22
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_PASSWORD="change-me"
SSH_MCP_SERVER_1_ALIASES=production,ai-chat-prod
SSH_MCP_SERVER_1_DEFAULT_DIR=/opt/app
SSH_MCP_SERVER_1_DESCRIPTION="production server"
SSH_MCP_SERVER_1_PLATFORM=linux
SSH_MCP_SERVER_1_ALLOW_EDIT=true
SSH_MCP_SERVER_1_EDIT_ROOT=/opt/app
SSH_MCP_SERVER_1_MAX_EDIT_FILE_BYTES=1048576
SSH_MCP_SERVER_1_BACKUP_BEFORE_EDIT=true
SSH_MCP_SERVER_1_BACKUP_DIR=.mcp-edit-backups
SSH_MCP_SERVER_1_ALLOW_DELETE=false
SSH_MCP_SERVER_1_ALLOW_BINARY_EDIT=false

SSH_MCP_SERVER_2_NAME=staging
SSH_MCP_SERVER_2_HOST=staging.example.com
SSH_MCP_SERVER_2_PORT=22
SSH_MCP_SERVER_2_USER=deploy
SSH_MCP_SERVER_2_PRIVATE_KEY_PATH=C:/Users/yourname/.ssh/id_ed25519
SSH_MCP_SERVER_2_ALIASES=stage
```

字段规范：

- `SSH_MCP_SERVER_<N>_NAME`：连接名，也是 `ssh_connect_profile`、`ssh_run_profile`、`ssh_check_profile` 使用的 profileName。
- `SSH_MCP_SERVER_<N>_IP` / `SSH_MCP_SERVER_<N>_HOST`：服务器 IP 或域名，二选一即可。
- `SSH_MCP_SERVER_<N>_PORT`：SSH 端口，省略时默认 22。
- `SSH_MCP_SERVER_<N>_USER` / `SSH_MCP_SERVER_<N>_USERNAME`：SSH 用户名。
- `SSH_MCP_SERVER_<N>_PASSWORD`：密码认证。
- `SSH_MCP_SERVER_<N>_PRIVATE_KEY`：私钥内容。
- `SSH_MCP_SERVER_<N>_PRIVATE_KEY_PATH`：私钥文件路径。
- `SSH_MCP_SERVER_<N>_PASSPHRASE`：私钥 passphrase。
- `SSH_MCP_SERVER_<N>_AGENT`：SSH agent socket 或 Pageant。
- `SSH_MCP_SERVER_<N>_ALIASES`：逗号分隔别名。
- `SSH_MCP_SERVER_<N>_DEFAULT_DIR`：默认工作目录。
- `SSH_MCP_SERVER_<N>_DESCRIPTION`：说明。
- `SSH_MCP_SERVER_<N>_PLATFORM`：平台标记，例如 `linux`、`windows`、`macos`。
- `SSH_MCP_SERVER_<N>_ALLOW_EDIT`：是否允许项目编辑工具写入，默认 `false`。
- `SSH_MCP_SERVER_<N>_EDIT_ROOT`：项目编辑硬边界；省略时使用 `DEFAULT_DIR`。
- `SSH_MCP_SERVER_<N>_MAX_EDIT_FILE_BYTES`：单个可编辑文件大小上限；省略时使用 `SSH_MCP_DEFAULT_MAX_EDIT_FILE_BYTES`。
- `SSH_MCP_SERVER_<N>_BACKUP_BEFORE_EDIT`：修改前是否备份，默认 `true`。
- `SSH_MCP_SERVER_<N>_BACKUP_DIR`：备份目录，必须位于项目根内；省略时备份到文件同目录。
- `SSH_MCP_SERVER_<N>_ALLOW_DELETE`：是否允许 `ssh_file_delete`，默认 `false`。
- `SSH_MCP_SERVER_<N>_ALLOW_BINARY_EDIT`：是否允许编辑包含 NUL 字节的二进制文件，默认 `false`。

只支持 `SSH_MCP_SERVER_<N>_*` 这一种格式。旧版 `SSH_SERVER_<PROFILE>_<FIELD>` 不再解析，混入旧字段会直接报错，避免配置契约不一致。

使用流程：

1. `ssh_list_profiles` 查看可用 profile。返回结果只包含 `hasPassword` 等布尔值，不返回密码。
2. `ssh_check_profile` 传 `profileName` 做一键远端检查，例如 `prod`。
3. 单条命令使用 `ssh_run_profile`；需要连续多步操作时，用 `ssh_connect_profile` 创建持久 session，再调用 `ssh_exec`、`ssh_shell_open`、SFTP 或 tunnel 工具。

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
