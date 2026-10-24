# 当前实施状态

- 最近更新：2026-10-25
- 项目：`enterprise-ssh-mcp-server`
- npm 已发布基线：`0.3.1`
- 本轮候选版本：`0.3.2`（尚未发布）
- 工作目录：`D:\studyProject\skills\ssh`

## 已完成

- 将 MCP 工具注册按领域拆分为 `src/app/` 与 `src/tools/`，保留 stdio 入口与现有工具名称。
- 增加环境配置热重载、OpenSSH 主机证书探测、主机 CA pin 校验、永久信任登记与一次性临时信任执行路径。
- InstaBox Token 通过 `usernameEnvVar` 从 MCP 子进程环境读取；不允许通过工具参数传入 bearer token，也不把 token 放入 SSH 进程 argv。
- 用户在 Windows 本机使用临时 OpenSSH 配置完成真实连接：`ssh.instabox.sh:2222` 的 `uname -a` 返回 Linux 系统信息，SSH 退出码为 `0`，临时目录清理标志为 `True`。
- 使用真实子进程完成 MCP stdio `initialize` 与 `tools/list` 冒烟测试；服务报告版本 `0.3.1`，注册 62 个工具，包含 `ssh_run_openssh_temporary`、`ssh_run_openssh` 和 `ssh_probe_host_key`。
- 新增 `scripts/test-instabox-mcp.ps1`，用于用户在本机完成 MCP → 临时 OpenSSH → InstaBox 的真实端到端验证。脚本安全提示后隐藏读取 Token，将其只传入本次 MCP 子进程环境，并验证远程命令退出码和临时信任文件清理。

## 最新验证

- `npm run typecheck`：通过。
- `npm test`：15 个测试文件、78 项测试通过。
- `npm run build`：通过。
- `npm pack --dry-run`：通过，包名与版本为 `enterprise-ssh-mcp-server@0.3.1`。
- `npm view enterprise-ssh-mcp-server version`：当前 npm 最新版本为 `0.3.1`。
- `git diff --check`：通过。
- MCP stdio 冒烟测试：通过。
- PowerShell 测试脚本语法解析：通过。

## 尚未完成 / 风险边界

1. 尚未由本地 MCP 进程完成真实 InstaBox 认证；下一步需在本机运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-instabox-mcp.ps1`，按提示安全输入 Token，并确认使用独立核验的 CA pin，或显式选择仅用于功能测试的 `USE-OBSERVED-ONCE`。
2. 当前观察到的 CA 指纹来自网络端点探测，尚未通过独立可信渠道核验。不能将其视为已独立认证的信任锚，不能因此自动写入永久 `known_hosts` 或持久配置。
3. 当前 npm 发布认证未通过：`npm whoami` 返回 `E401 Unauthorized`。需要在已授权的 npm 账户完成登录后才能发布；不应把 npm access token 写入仓库或聊天。
4. 尚未提交 Git 或发布 npm 新版本。真实 MCP 端到端测试仍待执行；本轮用户已明确要求推进提交与发布，后续仍需标明这一测试边界。

## 下一步执行顺序

1. 运行 `scripts/test-instabox-mcp.ps1`，确认 MCP 工具调用返回 `MCP_E2E_RESULT=PASSED`、远端 `uname -a` 输出、`exitCode=0` 和 `trustStoreDeleted=true`。
2. 若失败，按返回的 MCP 错误码定位并修复，不关闭严格主机校验。
3. 再次运行全套回归并审查 `git status` / `git diff`，特别确认无 Token 或临时凭据进入项目文件。
4. 检查 `package.json`、README、npm 打包文件清单与版本变更；提交后推送 Git。
5. 完成 npm 账户授权后发布 `0.3.2`，验证 npm registry 上的版本与 tarball 元数据。
6. 将本地 Codex `enterprise-ssh` MCP server 切换到此工作区的 `dist/index.js`，保留现有 `.env` Profile 路径，不把 token 写入 TOML；重启 MCP 客户端后验证工具列表。
