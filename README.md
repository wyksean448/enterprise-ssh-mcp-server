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

修改 TypeScript 源码后自动重启开发进程：

```powershell
npm run dev:watch
```

`dev:watch` 是监视文件后重启进程，不是在运行中的 MCP 进程内替换模块；重启会断开现有 SSH 会话，不应当作生产环境的无中断代码热更新。

## 能力范围

- Profile：`ssh_list_profiles`、`ssh_reload_profiles`、`ssh_connect_profile`、`ssh_check_profile`、`ssh_run_profile`
- 主机信任：`ssh_probe_host_key`、`ssh_trust_host_ca`
- 临时 OpenSSH 连接：`ssh_run_openssh_temporary`（独立临时 `known_hosts` 文件，命令结束后删除，不修改用户永久信任文件）
- 会话：`ssh_connect`、`ssh_list_sessions`、`ssh_disconnect`、`ssh_disconnect_all`、`ssh_rekey`
- 原生 OpenSSH 单次命令：`ssh_run_openssh`（适用于需要 OpenSSH 主机证书算法的端点；不创建持久会话）
- 命令：`ssh_exec`，支持 env、stdin、PTY、超时、stdout/stderr 最大字节限制、UTF-8/base64 输出
- 远程项目编辑：`ssh_project_open`、`ssh_project_tree`、`ssh_project_search`、`ssh_project_stat`、`ssh_file_read`、`ssh_file_patch`、`ssh_project_validate_patch`、`ssh_project_apply_patch`、`ssh_project_diff`、`ssh_project_run_checks`、`ssh_edit_history`、`ssh_edit_rollback`
- 交互 shell：`ssh_shell_open`、`ssh_shell_write`、`ssh_shell_read`、`ssh_shell_resize`、`ssh_shell_close`、`ssh_shell_list`
- SFTP 管理：`sftp_list`、`sftp_stat`、`sftp_read_file`、`sftp_write_file`、`sftp_mkdir`、`sftp_rm`、`sftp_rename`、`sftp_chmod`、`sftp_chown`、`sftp_touch`、`sftp_symlink`、`sftp_readlink`、`sftp_realpath`
- 大文件传输：`sftp_upload_start`、`sftp_upload_profile`、`sftp_download_start`、`sftp_download_profile`、`sftp_transfer_status`、`sftp_transfer_list`、`sftp_transfer_cancel`
- 端口转发：`ssh_tunnel_local_start`、`ssh_tunnel_remote_start`、`ssh_tunnel_list`、`ssh_tunnel_stop`

## 临时直连未配置的 SSH 设备

不需要先把设备写入 `.env` Profile。调用 `ssh_connect` 时可以直接提供主机、端口和认证信息；会话只保存在当前 MCP server 进程中，连接不会自动写入配置文件。

`host` 支持两种形式：

1. 主机和用户名分开：`host="ssh.example.com"`、`username="deploy"`。
2. 使用常见的 SSH 目标格式：`host="deploy@ssh.example.com"`，此时可以省略 `username`。

例如，针对平台给出的 `Hostname user@ssh.example.com` 和 `Port 2222`，把 `user@ssh.example.com` 作为 `host`，把 `2222` 作为 `port` 即可。根据服务器的认证配置，可能需要提供 `privateKeyPath`、`privateKey`、`password` 或 `agent`；部分平台会将临时访问令牌直接编码在 SSH 用户名中。

连接示例（建议优先使用本地私钥文件路径，而不是把私钥内容直接放进工具参数）：

```json
{
  "host": "deploy@ssh.example.com",
  "port": 2222,
  "privateKeyPath": "C:/Users/yourname/.ssh/id_ed25519",
  "name": "temporary-lab"
}
```

使用 `ssh_probe_host_key` 可以在不进行用户认证的情况下查看主机指纹；该工具不会自动信任探测到的密钥。兼容的 `ssh2` 连接仍可显式提供 `hostHash` 和 `expectedHostHash`。对于原生 OpenSSH 主机证书，可选择永久登记经过独立核验的 CA，或使用下文的临时信任模式。不要把首次连接成功等同于已完成主机身份验证。需要长期复用的设备，再单独维护为 Profile。

### InstaBox SSH token

InstaBox 官方的 Connect → Create token 会生成形如 `ssh ibssh_…@<host>` 的 SSH 命令；token 本身就是 SSH 用户名，不需要额外的 SSH 私钥或密码。token 在被撤销或到期前有效，详见 [InstaBox SSH 文档](https://instabox.sh/docs/ssh)。

为了避免把 bearer token 发送给伪装的 SSH 网关，`ssh_probe_host_key` 可以在不进行认证的情况下检查主机证书和签名 CA 指纹；它不会自动信任探测结果。需要通过可信渠道核验 CA 指纹，不要只因为网络探测成功就自动信任。

**当前兼容性限制：** InstaBox 网关提供 `ssh-ed25519-cert-v01@openssh.com` OpenSSH 主机证书，而当前持久会话后端 `ssh2` 不支持这种主机证书算法。程序会在发送 token 前拒绝通过 `ssh_connect` 建立持久会话。可以使用 `ssh_run_openssh` 通过系统 OpenSSH 执行单次命令；它强制 `StrictHostKeyChecking=yes`，要求默认或指定的 `known_hosts` 中已有可信的 CA/主机条目。若只想临时连接，推荐使用 `ssh_run_openssh_temporary`：它读取本地 MCP 进程配置中的 host-specific CA 指纹 pin，重新探测 CA，并要求实时指纹严格匹配，然后使用独立临时 `known_hosts` 文件执行命令，并在结束后删除该文件，不改动用户永久的 `known_hosts`。工具参数不能设置或覆盖这个信任锚；未配置 pin 时会在发起网络探测前拒绝执行。当前 OpenSSH 适配器还不提供持久 Shell、SFTP、后台传输或隧道；这些需要后续统一会话抽象。

本地 CA pin 配置：通过独立可信渠道核验 CA 指纹后，在 MCP 客户端的服务器 `env` 配置中设置 `SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS`。值是 JSON 对象，键为 `host:port`，值为完整 `SHA256:` 指纹；例如：

```json
{
  "mcpServers": {
    "enterprise-ssh": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "enterprise-ssh-mcp-server"],
      "env": {
        "SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS": "{\"ssh.instabox.sh:2222\":\"SHA256:替换为从可信来源独立核验的完整指纹\"}"
      }
    }
  }
}
```

请把示例指纹替换成通过独立可信渠道核验的真实值；不能把 `ssh_probe_host_key` 当前返回值直接复制进配置并将其视为已验证。该环境变量是本地信任锚，工具调用参数不能覆盖它。未配置、JSON 格式错误或指纹格式不正确时，连接和永久信任操作都会失败关闭。

永久信任流程：先按上面步骤配置可信 CA pin，再调用 `ssh_probe_host_key` 检查证书，并在确认需要写入永久信任后调用 `ssh_trust_host_ca`，将探测得到的 `certificateAuthority.knownHostsEntry` 登记到本机 `~/.ssh/known_hosts`。该工具会再次校验 CA 公钥与本地 pin 完全一致；它不会自行建立新的信任锚，也不会覆盖同一主机已存在的冲突 CA。

临时信任流程：无需修改永久 `known_hosts`。在 MCP 客户端环境中配置经过独立核验的 CA pin 后，调用 `ssh_run_openssh_temporary`，只需传入主机、端口、命令和本地 token 环境变量名。工具会重新探测实时 CA，并要求其指纹与本地 pin 完全匹配；验证失败时不会运行命令。验证通过后才会创建临时 trust store，命令结束即清理。工具调用不接受 `expectedHostCaFingerprint` 或 `confirmedHostCaFingerprint` 参数，防止模型把未验证的探测结果自我确认。

为避免在工具参数或 `ssh.exe` 命令行中传递 token，InstaBox token 必须设置在 MCP server 进程的本地环境变量 `SSH_MCP_INSTABOX_TOKEN` 中，再通过 `usernameEnvVar` 引用；直接把 `ibssh_…` token 放进 `host` 或 `username` 参数会被拒绝。程序会将用户名短暂写入系统临时目录中的 OpenSSH 配置文件，并在子进程结束（包括启动失败）后清理临时目录。POSIX 系统会以 `0600` 创建文件；Windows 上的访问保护取决于当前用户临时目录的 ACL，因此不要在共享或权限宽松的 Windows 账户环境中使用该方式。不要把真实 token 写进仓库或共享配置。

示例（仅在已核验并明确确认 InstaBox 主机 CA 指纹后使用；临时信任，不写永久 `known_hosts`）：

```json
{
  "host": "ssh.instabox.sh",
  "usernameEnvVar": "SSH_MCP_INSTABOX_TOKEN",
  "port": 2222,
  "command": "uname -a"
}
```

`ssh_probe_host_key` 的返回值包含 `certificateAuthority.fingerprint` 和 `certificateAuthority.knownHostsEntry`。前者必须通过可信渠道独立核验后写入本地 pin 配置，后者只有在 CA 身份与 pin 匹配后才应加入 OpenSSH `known_hosts`；探测结果本身不等于信任。

InstaBox token 用户名会在 Profile/会话结果和调试日志中脱敏。不要把 token 写入仓库或共享 `.env`；如果 token 已经暴露在聊天、日志或其他不可信位置，请在 InstaBox 中撤销并重新创建。

### 本机真实 MCP 端到端测试

如果要验证的不只是系统 `ssh.exe`，而是 MCP server 本身是否能读取本地 token、检查 CA pin、调用临时 OpenSSH 后端并清理信任文件，可以在**源码仓库根目录**的 Windows PowerShell 中运行（该测试脚本仅随源码仓库维护，不包含在 npm 发布包中）：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-instabox-mcp.ps1
```

脚本会在终端中隐藏式读取 `ibssh_` token，将其仅放入本次 MCP 子进程环境，不写入项目文件；然后通过真实 MCP stdio JSON-RPC 调用 `ssh_run_openssh_temporary` 执行只读 `uname -a`，并检查退出码与 `trustStoreDeleted`。结束后会关闭 MCP 子进程并清理本次进程中的凭据引用。

脚本会要求输入 CA 指纹。如果输入独立可信渠道核验后的 `SHA256:...` 指纹，会按该 pin 进行验证；输入 `USE-OBSERVED-ONCE` 则仅用于功能测试，使用此前网络探测到的指纹。**后者不构成 CA 来源的独立身份验证，不应复制到永久配置或 `known_hosts`。** 不要把 Token 输出或粘贴到聊天记录、终端命令参数或仓库中。

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

默认会监视 `.env` 文件：保存后约 1 秒内会尝试重新加载运行默认值和所有 Profile，解析成功后作为一个完整快照应用；编辑器保存过程中的半成品或非法配置会被拒绝，上一份有效配置继续生效。也可以调用 `ssh_reload_config` 或 `ssh_reload_profiles` 立即触发同样的原子重载。修改 `SSH_MCP_TOOLSET` 或 `SSH_MCP_ENABLE_DANGEROUS_TOOLS` 后仍需重启 MCP server，因为工具暴露集合在启动时注册。

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
SSH_MCP_SERVER_1_HOST=prod.example.com
SSH_MCP_SERVER_1_PORT=22
SSH_MCP_SERVER_1_USER=root
SSH_MCP_SERVER_1_PASSWORD="change-me"
SSH_MCP_SERVER_1_ALIASES=production,example-prod
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
