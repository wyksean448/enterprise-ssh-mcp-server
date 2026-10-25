# 当前实施状态

- 最近更新：2026-10-25
- 项目：`enterprise-ssh-mcp-server`
- npm 已发布版本：`0.3.2`（`latest` 已指向 `0.3.2`）
- Git 主体提交：`a906b6a`，状态更新提交：`bb5c1b4`；均已推送至 `origin/main`
- 工作目录：`D:\studyProject\skills\ssh`

## 已完成

- 将 MCP 工具注册按领域拆分为 `src/app/` 与 `src/tools/`，保留 stdio 入口与现有工具名称。
- 增加环境配置热重载、OpenSSH 主机证书探测、主机 CA pin 校验、永久信任登记与一次性临时信任执行路径。
- InstaBox Token 通过 `usernameEnvVar` 从 MCP 子进程环境读取；不允许通过工具参数传入 bearer token，也不把 token 放入 SSH 进程 argv。
- 用户在 Windows 本机使用临时 OpenSSH 配置完成真实连接：`ssh.instabox.sh:2222` 的 `uname -a` 返回 Linux 系统信息，SSH 退出码为 `0`，临时目录清理标志为 `True`。
- 使用真实子进程完成 MCP stdio `initialize` 与 `tools/list` 冒烟测试；当前本地构建版本为 `0.3.2`，注册 62 个工具，包含 `ssh_run_openssh_temporary`、`ssh_run_openssh` 和 `ssh_probe_host_key`。
- 新增 `scripts/test-instabox-mcp.ps1`，用于用户在本机完成 MCP → 临时 OpenSSH → InstaBox 的真实端到端验证。脚本安全提示后隐藏读取 Token，将其只传入本次 MCP 子进程环境，并验证远程命令退出码和临时信任文件清理。
- 更新本机 `C:\Users\Administrator\.codex\config.toml` 中的 `enterprise-ssh` 项，启动命令切换为 `node D:/studyProject/skills/ssh/dist/index.js`；已保留 MCP host 注入的集中式 Profile 文件路径 `C:\Users\Administrator\.ssh-manager\.env`，没有将 Token 或 CA pin 写入 TOML。原配置备份位于 `C:\Users\Administrator\.codex\config.toml.bak-20261025-012539`。
- 通过当前 MCP host 调用 `tools/list`、`ssh_get_config` 和 `ssh_list_profiles` 成功；可见 62 个工具，集中式 Profile 文件解析成功，9 个 Profile 已加载。

## 最新验证

- `npm run typecheck`：通过。
- `npm test`：15 个测试文件、78 项测试通过。
- `npm run build`：通过。
- `npm pack --dry-run`：通过，包名与候选版本为 `enterprise-ssh-mcp-server@0.3.2`；打包清单为 84 个文件，不包含本地端到端测试脚本或 `.env`。
- `npm view enterprise-ssh-mcp-server version`：正式返回 `0.3.2`，`dist-tags.latest=0.3.2`。
- `git diff --check`：通过。
- MCP stdio 冒烟测试：通过。
- PowerShell 测试脚本语法解析：通过。

## 尚未完成 / 风险边界

1. 尚未由本地 MCP 进程完成真实 InstaBox 认证；下一步需在本机运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-instabox-mcp.ps1`，按提示安全输入 Token，并确认使用独立核验的 CA pin，或显式选择仅用于功能测试的 `USE-OBSERVED-ONCE`。
2. 当前观察到的 CA 指纹来自网络端点探测，尚未通过独立可信渠道核验。不能将其视为已独立认证的信任锚，不能因此自动写入永久 `known_hosts` 或持久配置。
3. 用户完成 npm 登录后，使用已认证账号 `wyksean` 发布 `enterprise-ssh-mcp-server@0.3.2` 成功；npm registry 查询确认 `latest=0.3.2`，无需再次执行发布命令。
4. Git 已提交推送且 npm 0.3.2 已发布。本地 MCP `tools/list` 复核可见 62 个工具；真实 MCP → InstaBox 认证仍待执行，因为当前进程未配置 `SSH_MCP_INSTABOX_TOKEN` 和独立核验的 CA pin。

## 下一步执行顺序

1. 运行 `scripts/test-instabox-mcp.ps1`，确认 MCP 工具调用返回 `MCP_E2E_RESULT=PASSED`、远端 `uname -a` 输出、`exitCode=0` 和 `trustStoreDeleted=true`。
2. 若失败，按返回的 MCP 错误码定位并修复，不关闭严格主机校验。
3. 再次运行全套回归并审查 `git status` / `git diff`，特别确认无 Token 或临时凭据进入项目文件。
4. `0.3.2` 已发布并经 npm registry 复核；补齐 Git 发布标签后，继续验证本地 MCP 客户端工具可见性与命令调用。
5. 在用户本机运行 `scripts/test-instabox-mcp.ps1` 完成真实 MCP 认证测试；只有 CA pin 来源核验完成后才可将其持久配置为信任锚。
6. 重启 Codex/ChatGPT MCP host 以确保正式界面重新加载本地 `enterprise-ssh` 配置；再进行实际工具调用验证。
