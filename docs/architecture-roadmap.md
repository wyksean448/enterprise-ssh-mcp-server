# Enterprise SSH MCP：个人使用场景的整体架构设计

- 设计日期：2026-10-24
- 当前基线：npm enterprise-ssh-mcp-server@0.3.1
- 目标：在不推倒重写、不损害现有工具兼容性的前提下，逐步形成安全、稳定、易扩展的本地 AI 远程运维工具。
- 范围：架构提案；本文件不代表下述能力已经实现。

## 1. 产品定位与架构决策

将产品定位为 **Local-first SSH MCP**：MCP 服务运行在用户自己的电脑上，用户通过 AI 客户端调用工具，由本地进程使用 SSH/SFTP 连接用户授权的远程服务器。

### 核心原则

1. **本地优先、单用户优先**：默认 stdio，不建设账号体系、多租户控制平面或集中式云服务。
2. **模块化单体，不做微服务**：一个 Node.js 进程、清晰的模块边界、明确的依赖方向。只有实际出现部署或性能瓶颈时才拆分进程。
3. **工具是入口，用例才是业务核心**：MCP 工具负责输入校验和输出格式；策略判断、资源管理和业务流程不能散落在每个工具回调中。
4. **最小权限与显式风险**：隐藏工具只是减少误用，不等于权限控制。实际执行前必须由统一策略层校验。
5. **先可验证，再自动化**：写入前检查、执行后验证、失败有明确状态；远程变更尽可能备份和可恢复。
6. **兼容性优先**：保留现有工具名、参数语义和 stdio 启动方式；重构先做到行为不变，再逐步增强功能。
7. **默认不引入重型依赖**：优先使用 Node.js 标准库和现有依赖。个人使用不需要为了“企业级”而强制部署数据库、Redis、消息队列或 Web UI。

### 明确不做的事

第一阶段不建设多租户 RBAC、Web 管理控制台、分布式任务调度、常驻中央服务或 Kubernetes 部署体系；也不默认开放 HTTP 网络入口。这些是未来可能的独立产品方向，不是个人版的前置条件。

## 2. 当前架构基线与观察

当前项目已经具备可继续演进的基础：

- **src/index.ts** 注册 MCP 工具并处理大量工具回调，是当前最需要拆分的模块。
- **src/ssh-session.ts** 封装 ssh2 连接、命令、Shell、SFTP 相关会话能力。
- **src/session-registry.ts** 管理进程内 SSH 会话。
- **src/transfer-manager.ts** 管理进程内上传下载任务。
- **src/env-profiles.ts** 和 **src/runtime-config.ts** 负责 Profile 与运行配置。
- **src/remote-edit.ts**、**src/remote-path.ts** 提供远程项目编辑、路径约束和文件变更能力。
- **src/tool-result.ts** 统一 MCP 工具结果和错误格式。
- 现有 agent/full 工具集、危险工具默认隐藏、Profile 编辑开关、文件指纹校验和修改前备份，都是有价值的安全基础。

当前的主要架构风险不是缺少更多工具，而是：

1. 工具注册、参数 schema、业务流程与策略判断集中在 **src/index.ts**，改动容易相互影响。
2. SSH 会话、传输任务和编辑历史主要保存在进程内存；进程退出后，实时会话必然消失，任务状态与编辑历史索引也不能保证恢复。
3. hostHash / expectedHostHash 是可选输入，尚不能把它们视为统一、持久的主机信任策略。
4. 工具可见性、MCP annotations 和实际执行授权是不同机制，需要明确区分。
5. 现有测试通过并不等于 SSH 真实网络故障、传输中断、主机指纹变更和工具权限边界已经得到完整验证。

当前基线验证结果（2026-10-24）：**npm run typecheck** 通过；**npm test** 的 6 个测试文件、23 个测试通过。这是当前回归基线，不是生产安全认证。

## 3. 目标架构

~~~mermaid
flowchart TB
    CLIENT["AI 客户端"]
    MCP["MCP 边界<br/>stdio / schemas / tool metadata"]
    TOOLS["按领域划分的工具适配器"]
    APP["应用用例<br/>检查、执行、编辑、传输、部署"]
    POLICY["策略与风险判定"]
    AUDIT["结构化审计"]
    DOMAIN["核心服务<br/>Profile / Session / Transfer / Edit"]
    PORTS["能力接口<br/>SSH / SFTP / 本地状态 / 文件系统"]
    SSH["ssh2 适配器"]
    FS["本地文件与配置适配器"]
    STATE["本地持久状态<br/>可信主机 / 审计 / 历史索引"]
    REMOTE["用户授权的远程服务器"]

    CLIENT <--> MCP
    MCP --> TOOLS
    TOOLS --> APP
    APP --> POLICY
    APP --> DOMAIN
    APP --> AUDIT
    DOMAIN --> PORTS
    PORTS --> SSH
    PORTS --> FS
    FS <--> STATE
    SSH <--> REMOTE
~~~

### 依赖规则

- MCP 工具层可以依赖应用用例，不能直接复制一套业务规则。
- 应用用例负责组织流程，并调用策略、审计和核心服务。
- 核心服务不应依赖 MCP SDK；将来替换工具传输时，不需要重写 SSH 会话与文件传输逻辑。
- ssh2、本地文件系统、配置存储等外部能力通过小型接口封装，便于单元测试和故障注入。
- 不引入大型 DI 框架。通过显式构造函数参数和一个轻量 composition root 组合依赖即可。

## 4. 推荐目录结构

按领域逐步拆分，不一次性大规模迁移：

~~~text
src/
  main.ts                       # 进程入口、stdio、信号与退出清理
  app/
    create-app.ts               # 组合依赖、创建 MCP server
    use-cases/
      check-profile.ts
      run-command.ts
      manage-session.ts
      manage-transfer.ts
      edit-remote-project.ts
      run-operations.ts
  tools/
    register-config-tools.ts
    register-profile-tools.ts
    register-session-tools.ts
    register-exec-tools.ts
    register-shell-tools.ts
    register-sftp-tools.ts
    register-transfer-tools.ts
    register-project-tools.ts
    register-tunnel-tools.ts
    tool-policy-metadata.ts
  core/
    policy/                     # 执行策略、风险等级、授权判定
    profiles/                   # Profile 模型与校验
    sessions/                   # 会话生命周期
    transfers/                  # 任务状态与恢复策略
    edits/                      # 变更、备份、回滚历史
    audit/                      # 审计事件模型与脱敏
    errors/                     # 稳定的领域错误码
  adapters/
    ssh2/                       # ssh2 连接、命令、Shell
    sftp/                       # SFTP 适配
    local-state/                # 本地配置、可信主机、历史索引
    local-files/                # 本地上传下载文件操作
  config/
    env-profiles.ts
    runtime-config.ts
~~~

这只是目标边界，不要求一次创建所有目录。第一步只把 **src/index.ts** 中的工具注册按领域拆出去；现有 ssh-session.ts、transfer-manager.ts 等文件可以先保持原样。等测试和依赖边界稳定后，再抽取少量接口。

## 5. 核心子系统设计

### 5.1 MCP 工具层

职责仅限于：

- 定义 Zod 输入 schema、默认值、范围和参数说明。
- 把参数交给对应应用用例。
- 将成功结果或标准错误转换为 MCP 输出。
- 声明正确的工具风险元数据。

工具名称保持现有命名风格，新增功能应优先复用已有能力，避免为了每个小动作新增一个工具。面向 Agent 的工具说明要写清适用场景、风险和推荐工作流。

### 5.2 统一操作策略

工具列表可见性不等于授权。建议每个操作在应用用例执行前提供明确的策略上下文：

- 目标 Profile 与主机。
- 操作类别：读取、受控写入、破坏性操作、任意 Shell 命令、网络端口暴露。
- 目标路径及 Profile 的 EDIT_ROOT / DEFAULT_DIR 限制。
- 是否需要用户确认，以及确认对应的操作摘要。
- 操作的超时、输出大小和并发限额。

MCP annotations 只是提供给客户端的提示，不是安全边界。为每个工具显式声明风险元数据；不要把“不在危险工具名单里”直接解释成 destructiveHint: false。特别是任意 ssh_exec、交互 Shell 写入、远程文件 patch、批量应用 patch 等操作，需要被正确分类。任意 Shell 命令无法靠简单的命令字符串黑名单可靠约束；严格限制时应结合执行模式、专用远端账号和远端 OS 权限。

建议逐步形成三类策略，而不是强行替换现有 agent/full：

- **默认/平衡模式**：保持个人开发体验；安全检查、资源上限和审计默认开启；危险删除、权限变更和隧道等能力需要显式启用。
- **严格模式**：生产 Profile 可禁止任意命令、限制命令集合、要求写入前确认。
- **完整模式**：用户显式选择后开放全部工具，但仍执行路径边界、主机身份和参数校验。

保持 SSH_MCP_TOOLSET=agent|full 的兼容性；风险策略作为独立配置维度，不把“暴露多少工具”和“允许执行什么”混为一谈。

### 5.3 SSH 主机信任

增加独立的 HostTrustStore，不再依赖每次工具调用都手动传指纹：

- 对 host + port 记录受信任主机公钥指纹，持久化到用户本地配置目录。
- 已知主机必须匹配指纹；指纹发生变化时默认拒绝连接并给出可诊断错误。
- 未知主机首次连接时返回待确认的主机信息，不能悄悄当作已验证主机。
- 提供明确的信任登记/更新流程；高安全场景支持通过可信渠道预先配置指纹。
- 指纹变更不能被自动覆盖；用户确认后才允许更新。

TOFU（首次连接后信任）只能降低后续被冒充的风险，不能证明首次连接一定安全。因此生产服务器应优先预先核验指纹。实现时必须验证所使用的 ssh2 host verifier 输入与指纹编码，避免算法或格式不一致造成误判。

### 5.4 Profile 与凭据

- 继续支持现有 indexed .env 格式及 SSH_MCP_ENV_FILE，避免破坏现有用户配置。
- 把 Profile 解析、校验和秘密字段处理收敛到一个模块。
- 文档推荐将个人配置放在项目仓库之外；后续可提供迁移工具，但不能静默改变现有配置文件查找优先级。
- 不在工具结果、审计日志和错误堆栈中暴露密码、私钥、passphrase 或认证响应。
- 保持 agent forwarding 默认关闭。
- 后续如确实需要，再提供系统密钥链或 Vault 等凭据提供器；第一阶段不必为此增加复杂依赖。

### 5.5 会话与资源生命周期

会话、Shell、SFTP channel 和 tunnel 是实时资源，不应伪装成可跨进程恢复的持久连接。

建议为 SessionRegistry 增加明确的生命周期约束：

- 最大并发会话数与每会话 Shell / tunnel 限额。
- 空闲超时、连接断开后的状态同步和清理。
- 连接、命令、Shell、SFTP 操作的统一超时与取消语义。
- 退出时关闭会话和流；清理流程应幂等，即重复触发也不会导致二次清理错误。
- 对不可恢复的网络断开返回明确状态；只对可安全重试的操作进行重试，不能盲目重放写入或任意命令。

### 5.6 传输任务

第一阶段保留现有内存任务模型，先补齐可靠性：

- 并发任务上限、任务状态迁移校验和完成任务清理策略。
- 上传/下载完成后的大小检查；可选 SHA-256 完整性验证。
- 区分 queued/running/completed/failed/cancelled，确保取消与完成之间没有模糊状态。
- 原子传输必须明确临时文件和最终文件的覆盖语义。
- 续传前校验源和目标状态；文件大小相同不等于内容相同。
- 在连接断开、磁盘空间不足、权限拒绝和取消场景中验证流是否关闭、临时文件如何处理。

未来如用户确实需要 MCP 进程重启后继续管理任务，再引入本地任务元数据日志。重启后不应盲目续传，必须重新验证本地源文件、远端临时文件及目标路径。

### 5.7 远程编辑与回滚

保留现有的 expectedSha256、路径边界、备份和原子替换设计，并将其封装为单一应用工作流：

1. 打开远程项目并确认根路径。
2. 读取文件并取得 SHA-256。
3. 生成 patch 并校验路径、大小和预期哈希。
4. 展示 diff 与操作摘要。
5. 创建备份并应用变更。
6. 检查结果并记录变更 ID。
7. 失败时返回清晰状态；仅在可以确认安全时自动回滚。

当前编辑历史索引是进程内 Map。后续应持久化必要的变更元数据，使进程重启后仍能找到备份；备份内容仍可以留在远程项目的受限备份目录。回滚必须验证目标文件当前状态，避免覆盖其他人在变更之后提交的修改。

### 5.8 审计与诊断

增加一个轻量的本地 AuditSink，默认使用 JSONL 文件，不必立即引入数据库。

每个操作至少记录：

- requestId、时间、工具名、Profile、目标主机标识。
- 操作风险类别、开始/结束时间、结果状态、耗时。
- 退出码或稳定错误码。
- 文件变更的路径、前后哈希、备份/变更 ID。
- 传输任务 ID、字节数和最终完整性结果。

默认不持久化完整 stdout/stderr，不记录认证材料；命令参数需要脱敏。审计日志应支持轮转、保留期限和日志目录配置。审计日志用于事后诊断，不应被宣称为防篡改的合规审计系统。

### 5.9 高层运维工作流

底层工具继续保留，但新增能力优先以可验证的工作流形式组织：

- **巡检**：连接检查、身份、系统、磁盘、内存和服务状态，返回结构化结果。
- **诊断**：收集有限范围的日志和状态，明确区分观察结果与推断。
- **变更**：先计划与 diff，再执行，最后验证。
- **部署**：前置检查、上传、备份、切换、健康检查；失败时按预先定义的策略恢复。
- **批量操作**：先只读汇总；写操作逐台执行、限并发、逐台验证，避免一次故障扩散到全部服务器。

工作流需要明确的步骤、状态和失败边界，不应将多个 shell 命令拼接后就宣称拥有可靠的事务或自动回滚能力。

## 6. 本地状态与数据生命周期

| 数据 | 建议存储 | 进程退出后的预期 |
|---|---|---|
| SSH 连接、Shell、SFTP channel、tunnel | 内存 | 关闭，不恢复实时连接 |
| 当前传输任务对象 | 内存（第一阶段） | 状态不可保证恢复；清晰说明 |
| SSH Profile 与秘密 | 用户配置文件；后续可扩展凭据存储 | 保留，权限受保护 |
| 可信主机指纹 | 用户本地状态文件 | 保留，连接时继续校验 |
| 审计记录 | 本地 JSONL 文件 | 保留，可轮转 |
| 编辑历史索引 | 本地 JSONL/小型状态文件 | 保留备份引用与变更元数据 |
| 远程编辑备份 | 受限的远程项目备份目录 | 按保留策略清理 |

不必一开始采用 SQLite。先用版本化 JSON/JSONL、原子写入和文件轮转即可；只有需要复杂查询、并发写入或可靠任务恢复时，再评估 SQLite。

## 7. 测试架构

测试要跟着模块边界一起演进：

1. **单元测试**：配置解析、风险策略、主机指纹、路径约束、编辑冲突、任务状态迁移、错误映射。
2. **假适配器测试**：通过可替换的 SSH/SFTP 接口模拟连接失败、超时、断线、流错误和取消。
3. **集成测试**：使用临时 SSH 服务或专用测试容器验证真实认证、host key、命令退出码、SFTP 和传输。
4. **MCP 契约测试**：检查工具名、输入 schema、工具集可见性、风险 annotations 与实际策略一致。
5. **发布冒烟测试**：npm pack 后在干净临时目录安装/启动，确认 dist、bin 入口、README 和配置说明完整。
6. **回归门槛**：每次变更执行 npm run typecheck、npm test、npm run build；涉及 SSH/传输时额外执行对应集成测试。

测试禁止连接用户的生产服务器，禁止依赖真实生产凭据；网络集成测试应明确标记为可选或 CI 专用。

## 8. 分阶段实施路线

### Phase 0：冻结基线

- 记录现有工具名、参数 schema、默认配置和行为。
- 保留现有未跟踪文件，不覆盖或清理用户数据。
- 为现有测试结果建立基线。

验收：重构前后的公开工具契约没有意外变化。

### Phase 1：结构拆分（建议首先实施）

- 将 src/index.ts 的工具注册按领域迁移到 src/tools/register-*.ts。
- 建立轻量的 create-app.ts / composition root。
- 统一工具风险元数据，补齐读、写、任意命令、破坏性操作和网络暴露的分类。
- 暂不改变功能行为，不改工具名称，不发布 npm。

验收：类型检查、现有测试、构建通过；工具列表和 schema 契约通过对比。

### Phase 2：安全基线

- 实现持久主机信任与指纹变更处理。
- 在执行层集中实施 Profile 策略。
- 加入结构化审计与秘密脱敏。
- 增加高风险操作的明确风险说明和可选严格模式。

验收：未知/变更主机按策略拒绝；未授权写入被执行层拦截；日志中没有秘密；策略测试覆盖关键边界。

### Phase 3：可靠性

- 会话与传输的并发限额、生命周期和清理。
- 传输完整性验证及中断测试。
- 编辑历史持久化和回滚冲突保护。
- 增加真实 SSH/SFTP 集成测试。

验收：故障注入场景有确定结果；不会静默成功；任务和资源可以清理。

### Phase 4：运维工作流

- 完善巡检和诊断的结构化输出。
- 构建可预览、可验证、可恢复的远程变更/部署流程。
- 按需增加多服务器只读汇总和受控并发操作。

验收：每个工作流都有前置条件、步骤状态、验证条件、失败策略和审计记录。

### Phase 5：稳定发布

- 完善跨平台 CI、兼容性说明、升级指南、安全响应和发布清单。
- 使用 npm pack 与干净安装验证发布产物。
- 达到稳定性和兼容性门槛后再考虑 1.0.0。

版本号只是建议，不能仅因完成了重构就自动升级为稳定版。

## 9. 建议的第一批决策

建议优先确认并执行以下事项：

1. 不改用 HTTP，不引入微服务或数据库；保持 stdio + 单进程。
2. 先拆分 src/index.ts，并把工具元数据分类做准确。
3. 主机信任、执行策略、审计应当是跨工具共享的核心服务。
4. 进程内状态先明确生命周期，再按实际需要增加持久化。
5. 所有远程写操作优先走可预览、可验证、可恢复的工作流。
6. 先不自动发布 npm；每阶段通过回归与安全测试后，再单独决定是否发布。

**总体结论：** 这个项目适合演进成一个结构清晰的个人本地运维 Agent 工具，而不是先做成一套企业 SaaS。最有价值的技术投资是模块边界、可信主机、执行策略、可靠传输和可恢复变更；这些能力做好后，未来要扩展 HTTP、团队共享或集中审计也会容易得多。

## 10. 实施进度记录

### 2026-10-24：Phase 1 初始重构已落地（未发布）

- 将原先的大型 `src/index.ts` 缩减为 stdio 启动入口，并增加 `src/app/create-app.ts` 作为组合入口。
- 将 58 个 MCP 工具按配置/Profile、项目编辑、SSH 会话/Shell、SFTP、传输任务、隧道六个领域拆分到 `src/tools/register-*-tools.ts`。
- 将工具风险元数据集中到 `src/tools/tool-metadata.ts`，为每个公开工具显式声明风险类别；未知工具缺少风险元数据时拒绝注册。
- 保留原有工具名称、输入 schema、`agent/full` 工具集和危险工具可见性开关；没有修改 npm 版本或发布包。
- 增加 `tests/tool-metadata.test.ts`，覆盖风险分类、危险提示、只读提示、工具暴露集合和未知工具 fail-closed 行为。
- 当前 `src/app/tool-context.ts` 是为兼容现有实现而保留的共享依赖组合模块。后续阶段应按配置/Profile、项目编辑、会话、传输等领域继续抽取应用服务；本阶段不把它宣称为最终分层。

本阶段验证：`npm run typecheck` 通过；`npm test` 为 7 个测试文件、29 个测试通过；`npm run build` 通过。MCP stdio `initialize` + `tools/list` 冒烟验证返回 58 个唯一工具；与 Git 基线比较，58 个注册名称、注册顺序和每个注册定义（含输入 schema）均保持一致。风险 annotations 也已通过协议级抽查。

### 2026-10-24：Phase 2 起步——未配置设备临时直连

- 确认原有 `ssh_connect` 已能在不读取 Profile 的情况下直接创建 SSH 会话；本次不重复造连接栈，而是补齐面向真实连接信息的输入适配。
- 新增 `src/ssh-target.ts`，支持 `host="username@hostname"` 且省略 `username`，也继续兼容 `host` 与 `username` 分开传入的原有调用。
- 当内嵌用户名与单独传入的用户名冲突、目标格式错误或缺少用户名时，明确拒绝并返回可诊断错误，不猜测用户意图。
- 更新 `ssh_connect` 的工具描述、MCP server instructions 与 README，说明临时会话不会自动写入 `.env`，并列出私钥、密码或 SSH agent 等认证要求。
- 新增 `tests/ssh-target.test.ts`，覆盖用户提供的 `username@ssh.instabox.sh` 格式、旧式调用、冲突和非法输入。

本次验证：`npm run typecheck` 通过；`npm test` 为 8 个测试文件、40 个测试通过。此阶段未进行用户认证登录；当时尚未核实 InstaBox 的 token 认证与主机证书要求。后续 Phase 2 记录了真实的无认证主机证书探测及兼容性结果。持久化 known-hosts 信任库和统一执行策略仍属于后续 Phase 2 工作。

### 2026-10-24：Phase 2——配置热重载、OpenSSH 证书探测与一次性命令后端

- 新增 `src/env-reload.ts`：`.env` 文件监视器约每秒检查一次，保存后防抖重载；先完整解析 runtime config 和 Profile，再一次性替换两个注册表。若配置无效，保留上一份有效快照。
- `ssh_reload_config` 与 `ssh_reload_profiles` 现在触发同一个原子快照重载。`SSH_MCP_TOOLSET` 和 `SSH_MCP_ENABLE_DANGEROUS_TOOLS` 仍只在启动时决定工具暴露集合，改动后需要重启 MCP server。
- 增加 `npm run dev:watch`，用于源码变更后重启开发进程。它不是进程内代码热替换；重启会丢失当前 SSH 会话，因此不作为生产环境的无中断升级方案。
- 新增 `ssh_probe_host_key`：不执行用户认证，优先用 `ssh2` 读取主机密钥；当遇到 OpenSSH 主机证书算法不兼容时，回退到系统 `ssh-keyscan -c`，提取主机证书与签名 CA 的指纹，并生成候选 `@cert-authority` 行。探测结果不会自动写入或信任 `known_hosts`。
- 新增 `ssh_trust_host_ca`：必须与本地 MCP 进程环境 `SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS` 中按 host:port 配置的 CA pin 匹配，才会将单条 `@cert-authority` 写入本机 OpenSSH `known_hosts`。工具调用参数不能自报或覆盖信任锚；拒绝指纹不匹配、目标主机不匹配和同一主机的冲突 CA，不会覆盖已有条目。
- 新增 `ssh_run_openssh`：使用系统 OpenSSH 运行一次远程命令，强制 `StrictHostKeyChecking=yes`，支持指定 identity file / known_hosts 路径、超时和输出上限。它支持通过 `usernameEnvVar` 从本地 MCP 进程环境变量读取 token，避免把 token 放进工具参数。它不创建持久会话，目前不提供 SFTP、后台传输或隧道能力。
- 新增 `ssh_run_openssh_temporary`：面向临时连接场景，先从本地 MCP 进程环境读取按 host:port 固定的 CA pin，再重新探测实时主机证书并要求指纹严格匹配，之后才创建独立临时 `known_hosts` 文件执行一次命令，最后在 `finally` 中删除临时目录。工具调用参数不能自我确认或覆盖 pin；缺少配置时在网络探测前失败关闭。该路径不会修改用户永久 `known_hosts`，也不会因临时使用而跳过主机身份校验。
- InstaBox token 通过临时 OpenSSH 配置文件中的 `User` 指令传递，不出现在 `ssh.exe` 的命令行目标参数中；配置文件会在子进程退出后清理。环境变量提供的用户名对其他 SSH 主机同样不进入进程参数。普通 `buildOpenSshArgs` 明确拒绝 InstaBox token 目标，防止调用方意外将 bearer token 放进进程参数。
- InstaBox token 现在必须通过 `usernameEnvVar` 从 MCP 服务本地进程环境读取；若 token 直接出现在 `host`/`username` 工具参数中，或环境变量不是预期的 `ibssh_` token 格式，则在网络探测/认证前拒绝。
- 当调用方指定临时 `known_hosts` 或使用环境变量用户名时，OpenSSH 通过独立临时配置启动，避免用户级 SSH 配置中的 `ProxyCommand`、`RemoteCommand`、Host 别名等改变本次临时连接行为。临时配置创建后即进入 `try/finally` 生命周期，写入失败、子进程启动失败或命令结束都会尝试清理。
- 增加统一 SSH hostname 校验：拒绝 option-like host 和 `*`、`#`、`%` 等可改变 CLI/配置解析的字符；主机探测在创建网络连接或调用 `ssh-keyscan` 前完成校验。环境变量用户名缺失时也会在探测网络前报错。
- 实测 InstaBox 的 SSH 网关提供 `ssh-ed25519-cert-v01@openssh.com` 主机证书；当前 `ssh2` 持久会话后端不能协商该算法。`ssh_connect` 对 InstaBox `ibssh_` token 目标采取 fail-closed：在发送 token 前拒绝连接。原生 OpenSSH 单次命令路径可在用户先核验并信任 CA 后使用。
- 对 `ibssh_` 用户名增加脱敏，覆盖 Profile/会话结果、连接错误详情与 SSH debug 日志，避免将 token 当作普通用户名输出。


临时连接安全加固与集成验证：新增 `tests/openssh-temporary-integration.test.ts`，在模拟子进程边界下贯通“CA 指纹确认 → 临时 known_hosts → 临时 OpenSSH 配置 → 命令退出 → 清理”流程；覆盖 token/环境用户名不进入 argv、子进程启动失败清理、超时终止和输出字节上限。`tests/openssh-temporary.test.ts` 另覆盖确认指纹不匹配、实时 CA 指纹不匹配、非证书端点、非法主机、缺失本地 token 及拒绝将 InstaBox token 直接放入工具参数。统一 hostname 校验也会在 `ssh-keyscan` 或 SSH 连接前拒绝 option-like 主机。使用本机 Windows OpenSSH 9.5p2 的 `ssh -G -F` 对临时配置进行了解析验证，确认 hostname、port、User、严格主机校验、独立 known_hosts 与禁用全局 known_hosts 均按预期生效，未发起网络连接。此处是配置解析和 mock 子进程的集成级测试，不等同于对真实远程服务器的连接测试；当前观察到的 CA 仍未通过独立可信渠道核验，也未写入永久信任文件。

### 2026-10-25：本机预检与 CA pin 收敛

- 将 `ssh_run_openssh_temporary` 和 `ssh_trust_host_ca` 的信任锚收敛到 MCP 服务本地环境变量 `SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS`，按 `host:port` 配置完整 SHA256 CA 指纹；工具参数不再允许调用方自行提供 expected/confirmed 指纹。
- 缺少配置、JSON 格式错误、缺少对应 host:port pin 或指纹格式错误时 fail-closed；临时连接会在网络探测前确认本地 pin 存在，随后要求实时 CA 精确匹配。
- 本机 OpenSSH 9.5p2 已确认存在；对 `ssh.instabox.sh:2222` 的只读主机证书探测成功，观察到证书类型 `ssh-ed25519-cert-v01@openssh.com`，CA 指纹为 `SHA256:rGanWVZg/oHA5vVgCK8dunVX2ZaTRQAPFhLm8u3xDfk`。
- 用户随后在本机 PowerShell 完成了一次真实 OpenSSH 认证和只读远程命令：`uname -a` 返回 `Linux instabox-123 6.18.54-instabox #1 SMP PREEMPT_DYNAMIC 2026-09-25 00:00:00 UTC x86_64 GNU/Linux`，退出码为 `0`，`TEMP_FILES_CLEANED=True`。测试脚本使用临时 `known_hosts`/OpenSSH 配置，并在结束时删除临时目录；Token 由用户在终端安全输入，未写入项目文件。
- 安全边界说明：本次临时 `@cert-authority` 公钥来自此前对网络端点的探测，虽然主机证书验证和 Token 认证均成功，但 CA 公钥尚未通过独立可信渠道核验。因此该次测试证明“该端点当前可通过此 CA 与 Token 完成 SSH 登录”，不构成对 CA 来源的独立认证；未将该指纹写入 MCP 的持久 pin，也未加入永久 `known_hosts`。
- 当前 MCP server 进程的 `SSH_MCP_INSTABOX_TOKEN` 和 `SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS` 仍未配置。因此直接 OpenSSH 连接已验证成功，但通过 `ssh_run_openssh_temporary` 的 MCP 端到端真实认证仍待本地 MCP 客户端环境注入这两个配置后验证。
- 验证结果：`npm run typecheck` 通过；`npm test` 为 15 个测试文件、78 个测试通过；`npm run build` 通过；`npm pack --dry-run` 成功，包名/版本仍为 `enterprise-ssh-mcp-server@0.3.1`；`git diff --check` 通过。未发布 npm，未提交 Git。

### 2026-10-25：MCP stdio 冒烟验证与真实端到端测试入口

- 使用真实子进程启动 `dist/index.js`，通过 MCP stdio JSON-RPC 执行 `initialize` 与 `tools/list`，确认 serverInfo 为 `enterprise-ssh-mcp-server@0.3.1`，共注册 62 个工具；`ssh_run_openssh_temporary`、`ssh_run_openssh`、`ssh_probe_host_key` 均存在。该冒烟测试未携带 Token，也未连接远程主机。
- 新增 `scripts/test-instabox-mcp.ps1`，供用户在本机执行真正的 MCP 端到端测试。脚本交互式隐藏读取 Token，将其仅传给子 MCP 进程环境，通过 JSON-RPC 调用 `ssh_run_openssh_temporary` 执行只读 `uname -a`，检查 Linux 输出、远程退出码和 `trustStoreDeleted`，并对响应做 Token 脱敏；不会将 Token 写入仓库文件。
- 测试脚本允许输入独立核验的 CA 指纹；也提供显式 `USE-OBSERVED-ONCE` 选项，仅用于功能验证此前观察到的 CA pin，并输出警告。该选项不能替代独立核验，不应被写入永久配置。
- PowerShell 脚本语法解析检查通过。MCP 协议层冒烟测试通过；真实的 MCP→临时 OpenSSH→InstaBox 认证链路仍需用户在本机运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\test-instabox-mcp.ps1` 后，依据 `MCP_E2E_RESULT` 和脱敏结果确认。当前尚未提交 Git 或发布 npm。
