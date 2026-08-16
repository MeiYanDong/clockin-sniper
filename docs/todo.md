# ClockIn 生产级狙击系统：可执行开发任务清单

> 来源规格：[plan.md](./plan.md)
> 清单版本：`v1.1`
> 创建日期：`2026-08-16`
> 最近更新：`2026-08-17`
> 目标仓库：`MeiYanDong/clockin-sniper`（Public）
> 目标网络：Robinhood Chain Mainnet，`chainId = 4663`

---

## 0. 使用规则

本文件是实施顺序和完成证据的唯一任务清单。每张故事卡应保持“小、可测试、可单独提交”，不把多个无关模块塞进一个提交。

状态约定：

- `[ ]`：尚未完成；
- `[x]`：已经完成并有可回读证据；
- 被外部信息阻塞的任务仍保持 `[ ]`，在任务下记录 `BLOCKED_BY`；
- 测试通过、配置存在、服务器启用、真实 receipt 是四种不同证据，不能互相替代；
- 每完成一张故事卡，都要同时完成代码、测试、文档和变更记录；
- 任何真实私钥、助记词、带凭证 RPC、signed raw transaction 都不得写入本文件。

### 0.1 每张故事卡的完成规则

- [x] 故事卡目标可以用一句话说明，并能映射到 `docs/plan.md` 的明确需求。
- [x] 生产代码保持单一职责，没有把协议、transport、策略和 UI 混在同一模块。
- [x] 正常路径、边界路径和失败路径都有有意义的断言。
- [x] 新代码通过格式化、lint、typecheck、测试和覆盖率门槛。
- [x] Capability manifest 与真实能力一致，不把 `planned/tested` 写成 `verified_current`。
- [x] CHANGELOG、Tech Spec 或 ADR 按变更性质更新。
- [x] 提交信息使用 Conventional Commits；本次紧密耦合的 v2 schema/modules/tests/docs 作为一个交付单元。
- [x] 如果产生链上动作，保存 txHash、receipt、资产变化和 EffectRecord；本次未签名/广播任何有效交易。

### 0.2 优先级

| 优先级 | 含义 |
|---|---|
| P0 | 不完成就不能安全或正确地进入下一阶段 |
| P1 | 生产闭环必需，但可以在基础模型完成后并行 |
| P2 | 运维、效率或扩展能力，不阻塞核心代码开发 |

### 0.3 阶段门

- [ ] `GATE-A SPEC_READY`：最终 Factory/Profile 事实与用户参数已确认。
- [x] `GATE-B CORE_READY`：Canonical model、SQLite、预算与钱包 lane 完成。
- [ ] `GATE-C SENTINEL_READY`：已知和未知 Factory 监控完成。
- [ ] `GATE-D ENTRY_READY`：10 EOA、fee bands、canary 和 same-raw 完成。
- [ ] `GATE-E EXIT_READY`：内盘/外盘退出与净清算价值完成。
- [ ] `GATE-F PROD_READY`：CI/CD、云部署、readiness、recovery 和安全审计完成。
- [ ] `GATE-G LIVE_EFFECT`：出现真实 receipt、token delta、position 与退出证据后才可标记。

---

## Phase 0：仓库、协作规范与质量基线

### STORY-000：冻结仓库公开范围（P0）

目标：只公开 ClockIn 执行器与项目文档，避免把本地分析目录、Skill 工作副本或 secrets 上传。

- [x] 确认工作区根目录和 `clockin-sniper/` 原先都不是 Git 仓库。
- [x] 确认旁边的 `sniper-engineering/` 是独立仓库，不纳入本仓库历史。
- [x] 创建根目录 `.gitignore`，明确排除 `analysis/`、`sniper-engineering/`、`sniper-engineering-v1.5/`。
- [x] 确认 `clockin-sniper/node_modules/`、`runtime/`、`.env*`、wallet backup、keystore、证书和日志均被排除。
- [x] 用 `git status --short --ignored` 回读最终公开范围。
- [x] 用 `git ls-files` 确认只追踪 `docs/`、`.github/`、根工程文档和 `clockin-sniper/` 的允许文件。
- [x] 在首次 commit 前运行 secret scan。
- [x] 在首次 push 前检查 staged diff 和 staged 文件清单。

验收：

- [x] Git staged 内容不包含任何被排除目录。
- [x] Git staged 内容不包含私钥、助记词、带凭证 RPC 或 runtime ledger。
- [x] Public 仓库的 README 清楚说明这是实盘执行器代码，但仓库不包含资金、地址授权或成交证明。

### STORY-001：建立格式化与静态检查（P0）

目标：用自动工具强制统一 TypeScript/JSON 风格，避免依赖人工 code style。

- [x] 选择一个与当前 TypeScript 版本兼容的 formatter/linter。
- [x] 增加 formatter/linter 配置文件并锁定版本。
- [x] 增加 `npm run format`，只修改源代码、测试和受控 JSON。
- [x] 增加 `npm run format:check`，不写文件并在不一致时失败。
- [x] 增加 `npm run lint`，在 lint error 时失败。
- [x] 保留严格 TypeScript 配置：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- [x] 将 format/lint/typecheck 接入统一 `npm run verify`。
- [x] 对现有代码执行一次机械格式化，单独检查是否发生语义变化。
- [x] 将生成目录、lockfile 和运行数据排除出 formatter 扫描范围。

验收：

- [x] `npm run format:check` 通过。
- [x] `npm run lint` 通过且没有被静默忽略的 warning。
- [x] `npm run typecheck` 通过。
- [x] CI 使用与本地相同的命令。

### STORY-002：建立测试覆盖率门槛（P0）

目标：保留有意义的 70 个现有测试，并让覆盖率下降在合并前可见且会失败。

- [x] 运行现有 70 个测试并确认全部通过。
- [x] 采集 2026-08-16 质量基线：line `87.41%`、branch `65.69%`、function `88.61%`。
- [x] 增加 `npm run coverage`，使用 Node test coverage。
- [x] 初始门槛设置为 line ≥ `85%`、branch ≥ `60%`、function ≥ `80%`。
- [x] 覆盖率门槛必须作为最低线，不得为了让 CI 通过而随意下调。
- [x] 对纯类型声明、CLI entrypoint 等不可执行行建立显式 include/exclude 策略。
- [x] 为每个新增模块要求正常、边界、失败至少各一个有意义的测试。
- [x] 测试命名必须描述业务行为和预期结果，禁止只写 `works`。
- [x] 断言必须检查状态、金额、nonce、txHash/effect 或失败原因，不能只断言“没有抛错”。
- [x] 在 CI summary 中输出覆盖率报告。

验收：

- [x] 覆盖率低于任一门槛时命令返回非零。
- [x] 现有 70 个测试在覆盖率模式下仍全部通过。
- [x] 新故事卡 PR #5 的 CI job summary 显示测试数和覆盖率；远端 run `31940291085` 通过。

### STORY-003：建立 CI（P0）

目标：所有 PR 和 main push 在合并前自动执行确定性质量门。

- [x] 创建 `.github/workflows/ci.yml`。
- [x] 触发条件包含 pull request、main push 和手动触发。
- [x] 固定 GitHub Actions 官方 action 的主版本或不可变 SHA。
- [x] 使用当前支持的 Node LTS。
- [x] 使用 `npm ci`，禁止 CI 中隐式更新 lockfile。
- [x] 执行 secret scan。
- [x] 执行 format check。
- [x] 执行 lint。
- [x] 执行 typecheck。
- [x] 执行 70+ 测试及覆盖率门槛。
- [x] 执行 `npm pack --dry-run` 并检查 package 内容。
- [x] 对 PR title 执行 Conventional Commit 格式检查。
- [x] 设置最小 workflow permissions。
- [x] 配置并发取消，新的同分支 run 取消旧 run。

验收：

- [x] Public GitHub 仓库可看到 CI workflow。
- [x] 首次 main run 全部通过。
- [x] 临时 PR #6 故意加入格式漂移；run `31940391409` 在 `format:check` 失败，随后已关闭 PR 并删除临时分支。

### STORY-004：建立 Continuous Delivery（P1）

目标：每个版本标签自动产生经过验证、可追溯的 release artifact，但不在无审批情况下自动启动实盘服务。

- [x] 创建 `.github/workflows/release.yml`。
- [x] tag `v*` 触发 release；支持手动构建 artifact。
- [x] release 前重复执行完整 verify/coverage/package audit。
- [x] 用 `npm pack` 生成不可变 `.tgz` artifact。
- [x] 生成 SHA-256 checksum。
- [x] tag 模式创建 GitHub Release 并附加 artifact/checksum。
- [x] artifact 中不包含 runtime、key、env、ledger、authenticated RPC。
- [x] 记录 source commit SHA、Node 版本、package version 和 capability manifest revision。
- [ ] 实盘服务器部署保留为受保护 environment 的手动批准步骤。
- [x] 未配置 production environment/secrets 时，CD 只能交付 artifact，不能伪报部署成功。

验收：

- [x] 手动 workflow run `31940510895` 生成 artifact；下载回验 checksum 和 247 文件边界/secret scan 通过。
- [x] 受保护 tag `v0.1.0` 触发 run `31940616256`，创建可下载 Release；回下载后 checksum 通过。
- [x] release artifact 通过独立 secret scan。

### STORY-005：建立贡献、PR、ADR 和变更文档（P0）

目标：每个架构变化和功能变化都有可追踪上下文。

- [x] 创建根 `README.md`，给出项目状态、目录、快速验证、风险边界和文档索引。
- [x] 创建 `CONTRIBUTING.md`，定义分支、故事卡、Conventional Commits、测试和 review 规则。
- [x] 创建 `CHANGELOG.md`，采用 Keep a Changelog 风格。
- [x] 创建 `.github/PULL_REQUEST_TEMPLATE.md`。
- [x] 创建故事卡 GitHub Issue template。
- [x] 创建 `docs/adr/README.md` 和 ADR 模板。
- [x] 增加 ADR：仓库公开范围与 secret boundary。
- [x] 增加 ADR：10 个 one-shot EOA 而不是单 EOA/155 EOA。
- [x] 增加 ADR：Control Plane 与 Execution Plane 分离。
- [x] 将 `docs/plan.md` 定义为当前 Tech Spec，并创建文档索引。
- [x] 定义提交示例：`docs: add executable delivery backlog`、`ci: enforce quality gates`。
- [x] 定义每张故事卡原则上一个 PR；紧密耦合的 schema+tests 可在同一个 PR。

验收：

- [x] 新贡献者能从 README 找到 plan、todo、ADRs、测试和安全边界。
- [x] PR 模板要求填写故事卡、变更、风险、测试、覆盖率、文档和回滚方式。
- [x] 架构选择能从 ADR 找到状态、上下文、决策和后果。

---

## Phase 1：最终机制证据与用户决策冻结

### STORY-010：确认最终官方 Factory 与代码身份（P0）

目标：获得可用于 HOT_ARMED 的 FactoryProfile，不从名字或测试网地址推断。

`BLOCKED_BY: OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED`。2026-08-16 官方页面仍标注 Launcher coming soon，主网地址表未列 Launcher Factory；证据见 [evidence/2026-08-16-launcher-mainnet-status.md](./evidence/2026-08-16-launcher-mainnet-status.md)。

- [ ] 从官方文档、官网或官方公告获取主网 Factory 候选地址。
- [ ] 保存来源 URL、抓取时间和内容 hash。
- [ ] 在 chainId 4663 读取部署交易、deployer 和 deployed block。
- [ ] 在 exact block 读取 runtime bytecode。
- [ ] 计算 runtime code hash。
- [ ] 检查是否为 proxy。
- [ ] 若为 proxy，读取 implementation/admin/beacon slot 和 implementation code hash。
- [ ] 确认 owner/admin/creator 与官方关系。
- [ ] 对比历史 Factory family，标记 `direct_reuse`、`adapt_then_reuse` 或 `new_profile`。
- [ ] 记录 invalidating evidence：hash 漂移、owner 不符、链错误、代码为空。
- [ ] 创建/更新 FactoryProfile tech spec。

验收：

- [ ] FactoryProfile 含 address、runtime hash、proxy identity、event ABI hash 和证据来源。
- [x] 任何字段 UNKNOWN 都不会被默认值伪装成 VERIFIED。
- [x] Factory code drift 测试覆盖并失败关闭当前 profile。

### STORY-011：确认 launch event 和身份字段（P0）

目标：确定创建、开启、activation 是否同一交易，以及哪些字段可以绑定 ClockIn。

`BLOCKED_BY: FINAL_LAUNCH_EVENT_ABI_AND_CLOCKIN_IDENTITY_FIELDS_NOT_PUBLISHED`。仓库已实现并测试 L0–L4、同名 spoof、不可覆盖冻结和 CA 冲突逻辑，但最终主网字段仍不能从测试网/旧版 ABI 推断。

- [ ] 获取最终 launch event ABI。
- [ ] 验证 event topic 和 indexed/non-indexed 字段。
- [ ] 确认 creator、token、pool、name、symbol、metadata、image hash 语义。
- [ ] 确认 launch/create/enable 是否原子。
- [ ] 确认外部购买最早合法 block。
- [ ] 确认同一交易/区块多 launch 的排序规则。
- [ ] 确认 removed/reorg 行为。
- [ ] 确认 ClockIn creator、metadata、suffix 等强绑定字段。
- [x] 定义 L0–L4 identity fixtures。
- [x] 增加同名 spoof、错误 creator、错误 metadata、错误 suffix 的测试。

验收：

- [x] 名字和 symbol 单独命中时测试证明不会产生 Intent。
- [x] 第一条有效 launch 冻结后，同名后续事件不能覆盖。
- [x] official CA mismatch 产生显式冲突而不是替换 token address。

### STORY-012：确认 Pool 40%/2min 机制（P0）

目标：把 40%/2 分钟/0% 或 1% 从讨论画像升级为 versioned MechanismProfile。

`BLOCKED_BY: FINAL_MAINNET_POOL_ABI_AND_RUNTIME_NOT_PUBLISHED`。40%/2min 与 99%/99min 的版本化识别和反例测试已实现；真实 getter、floor、cap、cooldown、EOA-only、quoteAsset 仍待最终合约。

- [ ] 获取最终 Pool ABI 或验证 selector。
- [ ] 读取 initial fee。
- [ ] 读取或推导 fee floor。
- [ ] 读取 decay window 和时间源。
- [ ] 验证 decay 是线性、分段还是按区块。
- [ ] 读取 `inSniperWindow` 或等价状态。
- [ ] 读取 `buyCooldownSecs` 及其作用 scope。
- [ ] 读取 `eoaOnlySecs`。
- [ ] 读取 `windowMaxBuyBps`。
- [ ] 读取 `currentWindowCap` 并确认 per-tx/per-wallet/global。
- [ ] 读取 `quoteAsset`。
- [ ] 确认 5U 是否低于合法 cap。
- [x] 对 99%/99min profile 建立反例测试，防止机制混用。
- [x] 创建 MechanismProfile revision 和 capability 声明。

验收：

- [x] 可从实际 `S/F` 生成十档。
- [x] 若 floor=0，最后一档精确为 0；若 floor=100bps，最后一档精确为 100bps。
- [x] profile 不匹配时 ClockIn strategy 不构造交易。

### STORY-013：确认 buy、sell 与 finalize ABI（P0）

目标：在写 entry 重构前先确认完整买卖闭环。

`BLOCKED_BY: FINAL_ENTRY_EXIT_FINALIZE_ABI_AND_EXECUTABLE_ROUTE_NOT_PUBLISHED`。通用 adapter contract、净 quote、route registry、receipt/effect 和退出策略已实现；不能把 fixture adapter 标记为 mainnet verified。

- [ ] 验证 native ETH buy 的 target、selector、参数、recipient/refCode、返回值。
- [ ] 确认是否存在 ERC20 quote buy 及 approve/permit。
- [ ] 验证 launch pool sell 方法和参数。
- [ ] 确认 sell fee、cooldown、cap、allowance 和 beneficiary。
- [ ] 获取 previewBuy/previewSell 或曲线公式。
- [ ] 确认 finalize/graduate 事件和状态 getter。
- [ ] 确认外部 pool/Router Factory。
- [ ] 确认外部 quote asset、fee tier、liquidity 初始化和锁定机制。
- [ ] 确认 transfer tax/maxWallet/maxTx/blacklist/hook。
- [x] 形成 EntryAdapter/ExitAdapter/FinalizeAdapter 能力规格（最终 selector/ABI 仍待官方证据绑定）。

验收：

- [ ] fork 中能执行最小 buy 并核对 token delta。
- [ ] fork 中能执行 launch pool sell 并核对 quote delta。
- [ ] fork 中能在 finalize 后执行外盘 swap。

### STORY-014：冻结用户参数（P0）

目标：完成 `plan.md` 第 31 节所有资金与策略选择。

`COMPLETED: OWNER_POLICY_CLOCKIN_V2`。用户于 2026-08-16 接受推荐方案，并明确选择 20% `BREAK_GLASS` 绝对上限和 7 天授权有效期。配置为 `clockin-policy-v2` revision 2，hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`。这里的 `productionArmable=true` 仅表示 owner policy 完整，不替代协议、资金和部署 readiness。

- [x] 决定首币策略：0U monitor-only。
- [x] 确认约 2× 本金回收阈值。
- [x] 确认约 3× 第二止盈规模。
- [x] 确认 runner 约 25% peak drawdown。
- [x] 确认回本前最长持仓 60 分钟、runner 最长 24 小时；momentum 在 replay v1 前禁用。
- [x] 确认 `HYBRID_CA_GATE`。
- [x] 确认 `SHRINK_TO_CAP`：最多 5U、最少 1U，不拆分、不重分配。
- [x] 确认 `QUOTE_RANKED_BOUNDED`：每块最多 2 lanes。
- [x] 确认 5U→ETH 双价格源、30 秒陈旧时间、2% 最大偏差和 arming 前固定 wei 后备。
- [x] 确认初始止损：入场后 executable-net 基线 -30%，税窗结束后连续两个 canonical blocks。
- [x] 确认无流动性时告警并仅重试已验证 route，不自动扩大滑点。
- [x] 确认普通自动/人工退出最大 5%，显式二次确认 `BREAK_GLASS` 最大 20%。
- [x] 确认预授权最长 7 天，绑定 chain/profile/config/wallet/budget scope。
- [x] 确认 50U principal、60U all-in cap、禁止自动补款。
- [x] 把选择写入 ADR/strategy config，记录日期和 config revision。

验收：

- [x] 每个生产参数都有 owner、默认值、范围和变更方式。
- [x] 预算或身份授权变化必须产生新 config hash。
- [x] ADR 0006、strategy config、单元测试与 readiness 文档使用同一组参数。
- [x] 保存 `clockin-policy-v2` 本地验证与 Public PR 实现回执。
- [x] Public PR #8 required checks 通过并合并到 `main`；保存 CI run 与 merge commit 回读。

---

## Phase 2：Canonical Model 与 SQLite 持久化

### STORY-020：定义 Canonical TypeScript 模型（P0）

目标：把 Signal 到 Exit 的对象链变成稳定的核心类型。

- [x] 定义 `SignalEvidence`。
- [x] 定义 `FactoryCandidate` / `FactoryProfile`。
- [x] 定义 `LaunchCandidate` / `LaunchIdentity`。
- [x] 定义 `Opportunity` 与 revision。
- [x] 定义 `AuthorizationRecord`。
- [x] 定义 `ValidityEnvelope`。
- [x] 定义 `StrategyBudget` / `CapitalReservation`。
- [x] 定义 `WalletLane`。
- [x] 定义 `TrancheIntent` / `ExecutionPlan`。
- [x] 定义 `TxAttempt` / transport states。
- [x] 定义 `EffectRecord`。
- [x] 定义 `PositionLot` / `AggregatePosition`。
- [x] 定义 `ExitIntent` / `ExitPlan` / `ExitEffectRecord`。
- [x] 定义 reason codes 和状态转换错误。
- [x] 所有链上大整数使用 bigint/十进制字符串，不使用 float。

验收：

- [x] 每个顶层 canonical 业务对象都包含 strategyId、revision、evidence IDs 和时间字段（嵌套 value object 除外）。
- [x] 编译期阻止把 transport accepted 当作 EffectRecord。
- [x] 编译期区分 entry 与 exit intent。

### STORY-021：建立 SQLite schema 与 migrations（P0）

目标：支持 10 lane 原子预算、唯一 nonce、崩溃恢复和 append-only audit。

- [x] 选择受维护的 SQLite driver，并记录 ADR。
- [x] 建立 `factory_profiles`。
- [x] 建立 `signal_evidence`。
- [x] 建立 `launch_identities`。
- [x] 建立 `strategy_budgets`。
- [x] 建立 `wallet_lanes`。
- [x] 建立 `capital_reservations`。
- [x] 建立 `execution_plans`。
- [x] 建立 `tx_attempts`。
- [x] 建立 `effect_records`。
- [x] 建立 `position_lots`。
- [x] 建立 `exit_plans` / `route_quotes`。
- [x] 建立 `audit_events` / `service_leases`。
- [x] 为 strategy+launch+lane、wallet+nonce、txHash 建唯一约束。
- [x] 启用 WAL 和安全同步策略。
- [x] 数据库文件权限强制为 0600。
- [x] 增加 migration rollback/forward 测试。

验收：

- [x] 并发 reservation 只有一个成功。
- [x] 重复 launch/event 不能创建第二份预算。
- [x] 数据库重启后状态与重启前一致。

### STORY-022：迁移旧 NDJSON ledger（P1）

目标：保留现有测试和历史账本价值，同时将新写入切到 SQLite。

- [x] 定义旧 ledger record 到 canonical object 的映射。
- [x] 实现只读 parser，禁止执行未知字段。
- [x] 迁移 `live_session_started`。
- [x] 迁移 `plan_frozen` / `broadcast_attempted`。
- [x] 迁移 receipt/token balance/position events。
- [x] 对缺失字段标记 UNKNOWN，不推导伪证据。
- [x] 提供 NDJSON export 供审计和 replay。
- [x] 增加重复导入幂等测试。

验收：

- [x] 旧账本导入不会产生新的签名或广播动作。
- [x] 导入后 txHash、nonce、token delta 与原记录一致。

### STORY-023：实现 Capital Reservation（P0）

目标：50U 预算在并发、重启和 UNKNOWN 下永不超支。

- [x] 初始化 ClockIn budget 50U。
- [x] 初始化 10 个 lane，每 lane 5U。
- [x] 首币 budget 独立，默认 0U。
- [x] reservation 与 launch/config hash 绑定。
- [x] signed/broadcast/UNKNOWN 状态保持 reservation。
- [x] receipt revert 后按明确政策释放或结算，不自动转给其他 lane。
- [x] 过期 lane 不把预算追加给后续 lane。
- [x] 重启不重建已存在 budget。
- [x] 增加并发和 crash 测试。

验收：

- [x] 任意执行序列 aggregate principal ≤ 50U。
- [x] 首币策略无法读取 ClockIn reservation。

---

## Phase 3：Control Sentinel 与 Factory Registry

### STORY-030：Known Factory 精确监听（P0）

目标：把现有 Factory WSS 能力迁移为独立无私钥 channel。

- [x] 抽取 exact address + topic subscription。
- [x] 保留 subscribe-before-backfill。
- [x] 保存 provider receive monotonic timestamp。
- [x] 保存 blockHash/txIndex/logIndex。
- [x] 处理 duplicate/out-of-order/removed。
- [x] WSS 重连后回补 gap。
- [x] 多个 known Factory profile 并行订阅。
- [x] 输出 SignalEvidence，不直接签名。

验收：

- [x] 启动边界和断线边界无漏日志。
- [x] 同一事件 exact/backfill 只生成一个 canonical evidence。

### STORY-031：全链 launch topic 监听（P0）

目标：Factory 换地址时仍能在首个事件出现时发现新 emitter。

- [x] 对所有已登记 launch topics 做 address-less WSS 订阅。
- [x] 新 emitter 创建 FactoryCandidate。
- [x] 同块读取 runtime code。
- [x] 检查 proxy slots/implementation。
- [x] 匹配 Factory family fingerprint。
- [x] 读取 token/pool code 并验证事件语义。
- [x] 与 known channel 去重。
- [x] 未知 hash 只进入 OBSERVED/FINGERPRINTED，不授权资金。
- [x] 增加 spoof emitter 测试。

验收：

- [x] 新地址、已知 code family 可在同一 block 完成候选匹配。
- [x] 仅复制 event signature 的恶意 emitter 不进入 VERIFIED。

### STORY-032：关联地址与部署图谱（P1）

目标：在 launch event 前发现新 Factory、proxy 或 implementation。

- [x] 建立 versioned address cluster 配置。
- [x] 监控已知 EOA contract creation。
- [x] 监控 multisig/admin/owner 交易。
- [x] 解析 receipt contractAddress。
- [x] 监控 implementation/admin/beacon 变更。
- [x] 记录 funded_by/called_by/deployed_by/owned_by 边。
- [x] 每条边保存 source tx/block 和审核状态。
- [x] 限制自动扩张到批准的一跳关系。
- [x] 防止任意 dust 转账污染关联图。
- [x] 输出 candidate alert 和 profile diff。

验收：

- [x] 已知地址部署新合约能在一个 block 内出现 candidate。
- [x] 无证据关联地址不能自动进入 hot allowlist。

### STORY-033：官网/Bundle/JSON fallback（P1）

目标：前面链上策略失效或 CA 较晚发布时仍能结构化提取最终地址。

- [x] 配置官方允许 URL 列表。
- [x] 支持 HTML、JSON、JS bundle/runtime config。
- [x] 优先读取 `contractAddress` 等明确路径。
- [x] 验证 chainId。
- [x] 保存 ETag/Last-Modified/content hash。
- [x] 保存 parser path 和 observedAt。
- [x] 地址变化生成新 evidence，不覆盖旧 evidence。
- [x] 抓取失败异步降级，不阻塞 Factory 热路径。
- [x] 网页地址必须经 token code/Factory identity 复核。
- [x] 增加旧 CA、错误 chain、多个 0x 地址测试。

验收：

- [x] 页面中出现多个地址时只解析配置字段。
- [x] 官网 CA mismatch 触发冲突，不覆盖冻结 identity。

### STORY-034：外部 Pool/Finalize 监听（P1）

目标：用外部流动性事件做交叉验证并驱动 exit route migration。

`BLOCKED_BY: FINAL_EXTERNAL_FACTORY_FINALIZE_AND_LIQUIDITY_TOPICS_NOT_PUBLISHED`。通用 durable log 通道和 RouteCandidate 验证器已完成；不在未知 ABI 时猜测 Pair/Finalize/Mint topic。

- [x] 配置允许的 external Factory/Router。
- [ ] 监听 PairCreated/PoolCreated 等事件。
- [ ] 监听 finalize/graduate。
- [ ] 监听 Mint/Sync/AddLiquidity 或等价状态。
- [x] 绑定 token、quote、launchId、creator 和 finalize tx。
- [x] 读取 pool runtime 和 reserves/liquidity。
- [x] 生成 RouteCandidate。
- [x] 不把零流动性 pair 标记为可卖。
- [x] 增加同名 token pool spoof 测试。

验收：

- [x] RouteCandidate 只有在 Factory、token pair、代码和 liquidity 通过后升级。

### STORY-035：Factory/Profile Registry（P0）

目标：集中管理版本、证据、能力和 HOT_ARMED 状态。

- [x] 实现 OBSERVED→FINGERPRINTED→PROFILE_MATCHED→VERIFIED→HOT_ARMED。
- [x] 实现 QUARANTINED 和 STALE_REVERIFY_REQUIRED。
- [x] Profile 保存 Factory/proxy/event/adapter IDs。
- [x] Profile 保存支持的 quoteAsset 和 lifecycle。
- [x] Profile 保存证据和最后复核 block。
- [x] code drift 自动使 profile stale。
- [x] Control Plane 不能单独改变资金授权。
- [x] Execution Plane 在使用前独立复核 profile。

验收：

- [x] Registry revision 进入每个 ExecutionPlan。
- [x] stale revision 不能创建新 Intent。

---

## Phase 4：Identity、Strategy Router 与授权

### STORY-040：Launch Identity Binder（P0）

目标：把 launch event 冻结成不可覆盖的完整身份。

- [x] 规范化 name/symbol 只用于比较。
- [x] 绑定 Factory/profile revision。
- [x] 绑定 block/tx/log 位置。
- [x] 绑定 creator/token/pool/metadata。
- [x] 读取 token/pool runtime hash。
- [x] 生成 identity policy hash。
- [x] 原子写入 LaunchIdentity。
- [x] 同名后续 launch 拒绝覆盖。
- [x] reorg 进入 reconcile 状态。

验收：

- [x] 并发命中时只有 canonical 第一条身份冻结成功。
- [x] identity 冻结失败不消耗预算。

### STORY-041：L0–L4 授权（P0）

目标：实现速度与买错币风险之间的显式授权层级。

- [x] L0 candidate 只能记录。
- [x] L1 Factory verified 允许 decode/freeze。
- [x] L2 ClockIn bound 允许 lane 1。
- [x] L3 independent confirmed 允许 lanes 2–10。
- [x] L4 canonical effect 创建 position。
- [x] 实现 `HYBRID_CA_GATE`。
- [x] 支持预批准 Factory+creator+metadata 强绑定组合。
- [x] CA mismatch 停止未发 entry。
- [x] 已持仓时 CA mismatch 不关闭 exit。
- [x] AI 输出不能提升授权等级。
- [x] 预授权 TTL 最大为 7 天，恰好 7 天通过，多 1ms 失败关闭。

验收：

- [x] 每次授权都有 AuthorizationRecord、scope、expiry 和 evidence IDs。
- [x] scope 不匹配或过期授权不能签名。

### STORY-042：双策略 Router（P0）

目标：ClockIn 和首币同时监控，但资金、钱包和退出完全隔离。

- [x] 实现 `CLOCKIN_STRATEGY`。
- [x] 实现 `FIRST_OFFICIAL_LAUNCH_STRATEGY` monitor-only。
- [x] 定义“第一个有效官方 launch”的 canonical 排序。
- [x] 排除偷跑/测试/creator 不符合的 launch。
- [x] 两策略命中同一 CA 时 dedupe 到 ClockIn。
- [x] 首币策略无预算时不能创建 ExecutionPlan。
- [x] 可选 5U 首币 canary 使用独立 budget/wallet：当前决策为 `MONITOR_ONLY`/0U，因此无钱包、无资金动作。
- [x] 分别生成 strategy metrics 和 EffectRecord。

验收：

- [x] ClockIn 未命中不会自动把 50U 转给首币。
- [x] 同一 CA 不会双重买入。

### STORY-043：Mechanism Profiler（P0）

目标：检测 40%/2min、99%/99min 和未知机制，选择正确 adapter。

- [x] 读取 Factory/Pool fingerprint。
- [x] 检测 getter selector 和返回类型。
- [x] 读取 start/floor/window/cap/cooldown/eoaOnly/quote。
- [x] 匹配 `CLOCKIN_40PCT_2MIN_V1`。
- [x] 匹配 `SAFE_LAUNCH_99PCT_99MIN`。
- [x] 未知 profile 标记 unsupported。
- [x] 不允许通过 name 猜 profile。
- [x] profile revision 进入 ValidityEnvelope。

验收：

- [x] 99% profile 不会触发 40%十档策略。
- [x] getter revert/类型错误产生明确 reason code。

---

## Phase 5：10 个 EOA、资金与交易协调

### STORY-050：安全生成 10 个执行钱包（P0）

目标：得到 10 个专用 EOA，私钥始终位于仓库外且不在输出中暴露。

- [x] 设计批量钱包生成命令和参数。
- [x] 生成 `entry-01`…`entry-10`。
- [x] 每个私钥写入独立 mode-0600 文件或 Secret Manager。
- [x] 外部 secret 目录 mode-0700。
- [x] 生成只包含 walletId/address/role/chainId 的非秘密 manifest。
- [x] 验证 private key 与 expected address 对应，但不打印 key。
- [x] 为可选首币 wallet 使用独立命名空间：生成器支持 namespace/role；当前 monitor-only 不生成该 wallet。
- [x] secret scan 拒绝 wallet backup/private-key 文件进入 repo。
- [x] 编写 key rotation 与“不可信旧 key 不入金”说明。

验收：

- [x] 仓库和 Git 历史不存在私钥。
- [x] 10/10 address-key correspondence 在本地安全回读中通过。

### STORY-051：Wallet Readiness（P0）

目标：launch 前证明每个 wallet 的 principal、entry Gas 和 exit Gas 都可用。

`BLOCKED_BY: WALLETS_NOT_FUNDED`。价格和 Gas policy 已冻结；真实 10/10 资金状态仍需用户按最新冻结价格向新地址转入 ETH 后才能完成。

- [x] 读取 chainId 4663。
- [x] 读取每个 wallet native balance。
- [x] 读取 latest nonce。
- [x] 读取 pending nonce。
- [x] 检查未知 pending transaction。
- [x] 计算 5U principal raw。
- [x] 计算 entry max Gas reservation。
- [x] 计算 1 次 approve + 最多 3 次 sell 的 Gas reservation。
- [x] 对 entry/approve/sell Gas 增加 30% safety margin。
- [x] 校验 10 个钱包 aggregate principal + Gas 不超过 60U 换算后的 all-in cap。
- [x] 禁止 readiness 或执行器自动补款。
- [x] 输出 10/10 readiness 矩阵。
- [x] 不在 readiness 输出 secret/RPC credential。

验收：

- [x] 任一 wallet 不足时只指出具体 lane 和缺口。
- [x] `HOT_ARMED` 要求 10/10 principal/entry Gas/exit Gas ready。

### STORY-052：5U Price Snapshot（P0）

目标：在热路径外把 5U 转成冻结的 native wei 或 quote raw。

- [x] 实现主价格源 adapter。
- [x] 实现独立交叉价格源。
- [x] 记录 timestamp/source/price/deviation。
- [x] 配置最大陈旧时间。
- [x] 配置最大价格偏差。
- [x] 计算每 lane batchValueRaw。
- [x] 冻结 launch 使用的 snapshot revision。
- [x] 支持用户手工固定 wei 并记录隐含汇率。
- [x] 热路径不发起价格网络请求。

验收：

- [x] 过期 snapshot 不能进入 HOT_ARMED。
- [x] report 同时显示 nominal U 和 actual raw。

### STORY-053：Wallet Transaction Coordinator（P0）

目标：每个 wallet 同时只有一个合法 nonce writer，entry/exit/recovery 不冲突。

- [x] 建立 per-wallet lease。
- [x] 一个 EOA 同 launch 最多一个 entry intent。
- [x] reservation 与 nonce 原子绑定。
- [x] UNKNOWN 时锁定 wallet lane。
- [x] receipt 后更新 latest/pending nonce。
- [x] entry 与 exit 共用 coordinator。
- [x] treasury sweep 使用独立流程，仅在 entry disabled、零持仓、无 UNKNOWN nonce 时可保留 `TREASURY_SWEEP` slot。
- [x] 跨进程 lease 失效和恢复测试。

验收：

- [x] 两个进程竞争同 wallet 时只有一个 writer。
- [x] UNKNOWN wallet 不创建新的 exit nonce。

### STORY-054：SignedTx Vault（P1）

目标：支持 UNKNOWN 崩溃恢复，同时不把 raw transaction 写进普通日志或数据库。

- [x] 选择外部 vault 文件或加密存储形式。
- [x] vault 文件权限 0600。
- [x] audit store 只保存 txHash/reference。
- [x] 读取时校验 keccak256(raw) == txHash。
- [x] receipt/finality 后清理。
- [x] validity 过期后按 nonce 证据清理。
- [x] crash/restart same-raw 测试。
- [x] vault 不进入 Git/npm artifact/log。

验收：

- [x] 恢复广播 byte-for-byte 等于首次 raw。
- [x] vault 丢失时不生成同 nonce 不同 payload。

---

## Phase 6：十档 Entry Engine

### STORY-060：动态十档 Fee Band Planner（P0）

目标：从实际 start/floor 生成 10 个稳定整数 bps 档位。

- [x] 实现通用公式 `S - round((S-F)*i/9)`。
- [x] 支持 40→0。
- [x] 支持 40→1%。
- [x] 支持其他合法 start/floor。
- [x] 每个 band 绑定 laneId/walletId/5U reservation。
- [x] reference time 仅用于观测。
- [x] actual fee getter 驱动 eligibility。
- [x] 持久化 planner revision。
- [x] 增加整数舍入和单调性 property tests。

验收：

- [x] 第 1 档等于 start，第 10 档等于 floor。
- [x] 10 档单调不增且无重复预算。

### STORY-061：Exact-Block Pool Observation（P0）

目标：在同一个 canonical blockTag 读取所有授权输入。

- [x] 读取 current fee。
- [x] 读取 in-window/activation。
- [x] 读取 cap 和 scope。
- [x] 读取 cooldown 和 scope。
- [x] 读取 EOA-only。
- [x] 读取 quote asset。
- [x] 读取 curve/reserves/preview 输入。
- [x] 保存 blockHash/blockNumber/timestamp。
- [x] 多 provider race 时验证 chain/block 一致性。
- [x] duplicate/out-of-order head 不推进 lane。

验收：

- [x] 决策输入不存在 latest-block 混读。
- [x] impossible fee/cap/quote values 失败并记录 reason。

### STORY-062：Lane 1 Speed Canary（P0）

目标：在 L2 达成后以最短合法路径发送第一笔 5U，同时保存完整 canary 输入。

- [x] launch identity 冻结后并行做 dynamic preflight 和签名。
- [x] 确认 earliest valid external block。
- [x] principal 固定 5U raw。
- [x] 使用 `SPEED_CANARY` minOut policy。
- [x] 保存 parent-state fee/quote/curve/cap。
- [x] 建立 ExecutionPlan/ValidityEnvelope。
- [x] 同 raw fanout。
- [x] transport state 与 receipt state 分离。
- [x] 记录 source-to-wire latency timeline。
- [x] receipt 后进入 estimator。

验收：

- [x] 第一笔不等待官网抓取或 AI。
- [x] 第一笔最坏 principal 暴露不超过 5U。
- [x] 没有 L2 身份时绝不签名/广播。

### STORY-063：Lanes 2–10 独立调度（P0）

目标：lane 1 canary 后，九个独立 EOA 不再被单钱包 cooldown/nonce 串行阻塞。

- [x] lane 1 canonical calibration 完成后释放后续 lanes。
- [x] 每个 lane 单独监听 fee eligibility。
- [x] 每个 lane 使用独立 nonce。
- [x] 不要求前一 lane receipt 才能发送下一个不同钱包 lane。
- [x] 每个 lane 一次新 Intent。
- [x] 单 lane UNKNOWN 不冻结其他 wallets。
- [x] aggregate budget/cap 仍全局检查。
- [x] lane 失败不把 5U 追加给其他 lane。
- [x] 执行窗口结束使未发 lane 过期。

验收：

- [x] 10 lane 可在单钱包 cooldown > 0 时仍覆盖 fee window。
- [x] 任意一 lane transport/revert 不改变其他 lane nonce/payload。

### STORY-064：Cap/Cooldown/EOA-only Enforcement（P0）

目标：把当前只记录的参数变成实际 eligibility/sizing 输入。

- [x] 识别 cap scope。
- [x] 5U > cap 时执行用户选择的跳过/缩量策略。
- [x] 记录实际 principal 与 nominal 5U 差异。
- [x] 执行 global cooldown（若存在）。
- [x] per-wallet cooldown 不错误扩展到其他 EOA。
- [x] EOA-only 期间直接调用 pool。
- [x] 禁止中介合约路径。
- [x] cap 变化使旧 quote/plan 失效。
- [x] 增加 per-tx/per-wallet/global fixtures。

验收：

- [x] 当前WindowCap 不再只是日志字段。
- [x] incompatible 5U 产生明确状态而不是盲目 revert。

### STORY-065：Catch-Up Policy（P1）

目标：WSS gap 或 fee 跳变跨过多个 band 时有显式、可测策略。

- [x] 实现 `ONE_PER_BLOCK`。
- [x] 实现 `ALL_ELIGIBLE`。
- [x] 实现 `QUOTE_RANKED_BOUNDED`。
- [x] 配置 max concurrent lanes。
- [x] 无可信 quote 时回退 ONE_PER_BLOCK。
- [x] 同块多 lane 保持独立 raw/nonce/reservation。
- [x] 记录 skipped/deferred reason。
- [ ] fork 比较 tokenOut、税、价格 impact 和 fill。

验收：

- [x] 策略选择进入 config hash。
- [x] gap 恢复不会重复发送已完成 lane。

### STORY-066：Quote-Bounded MinOut（P0）

目标：lane 1 之后不再默认 `minTokensOut = 1 raw`。

`BLOCKED_BY: FINAL_ENTRY_REVERT_ABI_REQUIRED_FOR_MINOUT_SPECIFIC_DECODE`。通用 receipt revert 会归类 `RECEIPT_REVERTED`；要精确证明为 minOut 触发，还需最终 Pool custom error/selector 或 exact-block replay。

- [x] 定义 QuoteSnapshot。
- [x] 使用 exact block preview/curve。
- [x] 设置 quote freshness。
- [x] 计算 minOut 和最大 drift。
- [x] minOut 进入 plan hash。
- [x] quote 变化生成新 plan revision。
- [x] quote unavailable 明确降级/跳过。
- [x] 不把 fixed minOut 描述为完整滑点控制。

验收：

- [x] stale quote 不能被旧 plan 延长有效期。
- [ ] actual tokenOut < minOut 时链上 revert 可正确归因。

---

## Phase 7：Canary Estimator 与经济核算

### STORY-070：Canary Input Snapshot（P0）

目标：第一笔广播前保存可用于区分 fee、impact 和 drift 的状态。

- [x] 保存 parent block/hash。
- [x] 保存 declared fee。
- [x] 保存 curve/reserves。
- [x] 保存 no-fee theoretical output（若支持）。
- [x] 保存 protocol preview output（若支持）。
- [x] 保存 cap/window/quoteAsset。
- [x] 保存 principal/minOut。
- [x] 保存 source freshness。

验收：

- [x] snapshot 与 ExecutionPlan 使用同一 profile/block reference。

### STORY-071：Actual Token Delivery 与 Gas（P0）

目标：receipt 后构建完整 entry EffectRecord。

- [x] 读取 receipt status/block/index。
- [x] 汇总 token Transfer logs。
- [x] 读取 beneficiary balance before/after。
- [x] 计算 actual token delta。
- [x] 计算 quote principal delta/refund。
- [x] 计算 gasUsed × effectiveGasPrice。
- [x] 检查 receipt txHash 与 signed hash。
- [x] success+0 token 标记失败语义。
- [x] 处理 receipt reorg。

验收：

- [x] 只有 receipt success 且 token delta > 0 创建 PositionLot。
- [x] report 不把 event amount 单独当到账真值。

### STORY-072：Fee/Impact/Drift 分解（P0）

目标：不再把 `currentFeeBps` 等同于实际总损耗。

- [x] 记录 declared pool fee。
- [x] 估计 token transfer tax。
- [x] 估计 curve price impact。
- [x] 计算 execution drift。
- [x] 无 no-fee quote 时不伪称 implied tax。
- [x] 输出 confidence/unknown/constrained fields。
- [x] 比较实际 friction 与策略阈值。
- [x] 更新后续 lane quote/minOut。
- [x] drift 超阈值停止未发 entry，但不停止 exit。

验收：

- [x] Estimator 支持 DECLARED_ONLY→CANARY_PENDING→CALIBRATED→UPDATED。
- [x] CONFOUNDED/UNKNOWN 有单独状态和测试。

### STORY-073：可选 Bounded Micro Probe（P2）

目标：仅在 getter/ABI 不可用且用户单独授权时，用一次小额 probe 获取信息。

- [x] adapter 默认 disabled。
- [x] 单次 principal 上限默认 0.25U。
- [x] 每个可信 launch 最多一次。
- [x] 使用独立 wallet/budget。
- [x] probe 不改变 ClockIn 10×5U 预算。
- [x] 定义停止条件和 EffectRecord。
- [x] 不允许无限循环微买。

验收：

- [x] 未显式授权时无法创建 probe Intent。

---

## Phase 8：Broadcast、Receipt 与 Recovery

### STORY-080：Same-Raw 多路广播（P0）

目标：将同一 signed payload 并行发给 direct Sequencer 与生产 RPC。

- [x] 预计算 txHash。
- [x] 验证每个 provider chain identity。
- [x] 启动时探测 direct Sequencer write endpoint。
- [x] 并行发送完全相同 raw bytes。
- [x] provider 返回 hash 必须匹配本地 hash。
- [x] 分类 accepted/known/unknown/rejected。
- [x] 单 provider 故障不改变 payload。
- [x] 保存 provider latency 和 outcome。
- [x] 日志只保存 txHash，不保存 raw。

验收：

- [x] 多 route 捕获到的 raw hash 完全一致。
- [x] all deterministic rejection 才判定 transport rejected。

### STORY-081：UNKNOWN Same-Raw Recovery（P0）

目标：RPC 超时或进程崩溃时不产生重复业务意图。

- [x] UNKNOWN 保持 reservation/nonce lease。
- [x] 查询 receipt/transaction/latest nonce/pending nonce/balance。
- [x] 有效期内从 vault 重播相同 raw。
- [x] 不生成新 nonce。
- [x] 不生成同 nonce 不同 payload。
- [x] expiry 后进入 EXPIRED_UNRESOLVED。
- [x] 后台继续核查迟到 receipt。
- [x] per-wallet 隔离。
- [x] 进程在 send timeout 后崩溃的测试。

验收：

- [x] 同一 lane 所有 attempt 共用同一 txHash。
- [x] 其他 wallets 可继续但 aggregate budget 不超限。

### STORY-082：Reorg Reconciler（P1）

目标：launch 或 receipt 被 reorg 后能回滚非最终经济状态。

- [x] 保存 blockHash。
- [x] 处理 removed log。
- [x] 检测 receipt block hash 变化。
- [x] EffectRecord 支持 provisional/final/reorged。
- [x] 回滚未最终 PositionLot。
- [x] 不删除原 audit history。
- [x] 重新核对 identity/nonce/balance。
- [x] 未发 entry 按新 validity 决策。

验收：

- [x] reorg 后不会同时保留两个 canonical position。

### STORY-083：Latency Timeline（P1）

目标：用可测分段而不是感觉优化竞速。

- [x] 记录 provider receive。
- [x] 记录 decode complete。
- [x] 记录 identity frozen。
- [x] 记录 eth_call start/end。
- [x] 记录 sign start/end。
- [x] 记录 first wire start/response。
- [x] 记录 receipt first seen/effect reconciled。
- [x] 输出 p50/p95/p99。
- [x] 分 provider/region/profile 聚合。

验收：

- [x] 能计算 source-to-wire，而不是只看 inclusion 总时长。

---

## Phase 9：Position、内盘与外盘退出

### STORY-090：PositionLot 与 AggregatePosition（P0）

目标：保留每个钱包的成本和可卖性，同时提供全局经济视图。

- [x] 每个成功 entry 创建 PositionLot。
- [x] 记录 wallet/token/quantity/cost/gas/fee/route。
- [x] 聚合 10 wallets token/cost。
- [x] 区分 realized/unrealized/residual。
- [x] 不丢失 wallet-level allowance/nonce。
- [x] 重启恢复 position。
- [x] balance reconciliation 发现差异时标记 UNKNOWN。

验收：

- [x] aggregate 数量等于各 canonical lots 之和。

### STORY-091：Launch Pool Sell Adapter（P0）

目标：finalize 前能从内盘取得可执行 quote 并卖出。

`BLOCKED_BY: FINAL_MAINNET_LAUNCH_POOL_SELL_ABI_NOT_PUBLISHED`。参数化 `ConfiguredExitRouteRuntime` 已实现 launch-identity 动态 target、exact-block code hash、allowance/approve、可执行 quote、Gas 后净回款、minOut/deadline/sell calldata 和逐钱包 same-raw 服务；没有最终 ABI/fork 证据时仍不勾选具体主网内盘交易任务。

- [ ] 实现 sell quote。
- [ ] 实现 allowance/approve 或 permit。
- [ ] 计算 sell tax/impact/Gas。
- [ ] 构建 minOut/deadline。
- [ ] 签名和 same-raw 广播。
- [ ] receipt 后核对 quote balance delta。
- [ ] sell revert 分类。
- [ ] 内盘不可卖时显式标记。
- [ ] 每个 wallet 独立执行。

验收：

- [ ] fork 中 entry lot 能卖回 quote asset。
- [ ] 不使用页面价格代替 sell quote。

### STORY-092：Finalize 与 External Route Registry（P0）

目标：finalize 后只使用经过验证、具有真实流动性的外部 route。

- [x] 绑定 finalize receipt/state。
- [x] 验证 external Factory/Router code hash。
- [x] 验证 token/quote pair。
- [x] 验证 reserves/liquidity 非零。
- [x] 保存 fee tier/pool address。
- [x] 获取当前 sell quote。
- [x] 生成 VERIFIED RouteProfile。
- [x] 旧 route 失效时更新 revision。

验收：

- [x] 只有 PairCreated 而无 liquidity 不进入可执行 route。

### STORY-093：External AMM Swap Adapter（P0）

目标：finalize 后逐钱包通过外盘实现可核账退出。

`BLOCKED_BY: FINAL_EXTERNAL_ROUTER_POOL_AND_FINALIZE_PROFILE_NOT_PUBLISHED`。通用 route registry 与参数化 configured runtime 已支持固定 Router、显式 spender、静态或 token-prefix path、exact code identity、quote/sell calldata 和 same-raw 服务，但不把 fixture route 当作主网可卖证据。

- [ ] 实现 router quote。
- [ ] 实现 approve/permit。
- [ ] 计算 price impact/fee/Gas。
- [ ] 构建 tokenIn/minOut/path/deadline。
- [ ] 验证 router/pool code identity。
- [ ] same-raw 广播。
- [ ] receipt 后核对 quote delta。
- [ ] route removal/quote stale 处理。

验收：

- [ ] fork 中 finalize 后 position 可通过 external route 关闭。

### STORY-094：Net Liquidation Valuator（P0）

目标：所有退出阈值都基于当前真实可执行净回款。

- [x] 对每个 lot 获取内盘/外盘 quote。
- [x] 扣除 sell tax。
- [x] 扣除 price impact。
- [x] 扣除 approve/sell Gas。
- [x] 选择 netOut 最优有效 route。
- [x] 无 quote 的 lot 不计入可清算价值。
- [x] 汇总 ExecutableNetLiquidationValue。
- [x] 保存 quote freshness 和 route revision。

验收：

- [x] 页面市值/最后成交价不进入自动退出判断。

### STORY-095：本金优先退出（P0）

目标：按用户确认参数回收本金、止盈并管理 runner。

- [x] 计算 TotalActualCost。
- [x] 2× 条件触发 RECOVER_PRINCIPAL。
- [x] 求解覆盖全部实际成本的最小 tokenIn。
- [x] 按确定性 lot 顺序逐钱包卖出。
- [x] 3× 条件卖出一个 tranche 等价值。
- [x] runner 维护 executable net peak。
- [x] runner 使用 25% executable-net drawdown 或 24 小时上限；未 replay 的 momentum 信号不能触发。
- [x] 回本前使用 60 分钟持仓上限。
- [x] 初始止损基于入场后 executable-net baseline，而非含已知买税的 gross cost。
- [x] 税窗关闭且 route 可执行后，连续两个 canonical blocks 低于 -30% 才退出。
- [x] 无 route 时告警并重试已验证路线，不自动扩大滑点。
- [x] dust 做经济性判断。
- [x] 每次 exit 生成独立 EffectRecord。

验收：

- [x] 实际回款而非预期 quote 更新本金回收进度。
- [x] 部分 sell/revert 后可从 canonical position 继续。

### STORY-096：Entry/Exit 独立控制（P0）

目标：新买入停止时，已有仓位仍能核账和退出。

- [x] `entryEnabled` 独立配置。
- [x] `exitEnabled` 独立配置。
- [x] identity/profile drift 只停止未发 entry。
- [x] open position 自动保持 exit service active。
- [x] 人工 EXIT_NOW 有审计记录。
- [x] 普通自动/人工 EXIT_NOW 使用当前 quote，最大滑点 5%。
- [x] 独立 `BREAK_GLASS` 最大 20%，要求理由、第二确认和绑定 plan 的审计 ID。
- [x] 常规退出不能自动升级为 `BREAK_GLASS`。
- [x] 全局 shutdown 不静默遗留 position。

验收：

- [x] 测试证明 entry disabled 时 sell 仍可执行。

---

## Phase 10：运维、Dashboard 与云部署

### STORY-100：Health/Readiness API（P1）

目标：准确区分进程存活、待命、广播、成交和退出。

- [x] `/health` 只表示进程活着。
- [x] `/ready` 输出 chain/RPC/WSS/Sequencer。
- [x] 输出 Factory/Profile revision。
- [x] 输出 10/10 signer/nonce/funding。
- [x] 输出 Price Snapshot freshness。
- [x] 输出 DB lease/WAL。
- [x] 输出 CA/entry/exit state。
- [x] 输出 UNKNOWN/open positions/routes。
- [x] API 默认 localhost。
- [x] 不输出 secret/raw/RPC credential。

验收：

- [x] `HOT_ARMED` 缺任一 P0 readiness 时为 false 并给出具体原因。

### STORY-101：只读 Dashboard（P2）

目标：让用户实时看到信号、10 lanes、税率、position 和退出，而不把 UI 当成 receipt。

- [x] 显示阶段和最新 block/lag。
- [x] 显示 Factory candidates/profile。
- [x] 显示冻结 token/pool/creator/CA state。
- [x] 显示 declared fee/effective drag/cap/window。
- [x] 显示 10 lane target/actual fee/tx/receipt/tokenOut。
- [x] 显示 principal/Gas/position。
- [x] 显示内盘/外盘净 sell quote。
- [x] 显示本金回收和 runner 状态。
- [x] 显示最近错误/人工动作。
- [x] 状态文字区分 WATCHING/ARMED/SIGNED/BROADCAST/RECEIPT/POSITION/EXITED。

验收：

- [x] accepted/known/unknown 不显示为成交成功。

### STORY-102：Alerts（P1）

目标：关键状态变化能及时通知，但通知失败不阻塞热路径。

- [x] Factory candidate/profile drift alert。
- [x] ClockIn identity frozen alert。
- [x] CA confirm/mismatch alert。
- [x] lane broadcast/receipt/effect alert。
- [x] UNKNOWN/revert/no-token alert。
- [x] RPC/WSS lag alert。
- [x] funding/Gas shortfall alert。
- [x] finalize/liquidity alert。
- [x] principal recovery/exit alert。
- [x] no executable exit route alert。
- [x] 通知异步且 secret-redacted。

验收：

- [x] 通知接口失败不持有 signer/nonce/hot-path lock。

### STORY-103：systemd 与 Secret Injection（P0）

目标：云机以非 root、可重启、仓库外 credentials 运行。

`CONTROL_DEPLOYED; EXECUTION_RUNTIME_IMPLEMENTED; EXECUTION_PLANE_BLOCKED_BY_FINAL_PROTOCOL_EVIDENCE`。`47.251.28.201` 上的无私钥 Control 已完成真实 systemd、`/proc`、journal、钱包和 artifact 回读；Executor/Reconciler/Exit entrypoint、状态 interlock、watchdog 和 deterministic renderer 已实现，仍因最终 Factory/ABI/route 未冻结而不授权、不启动。

- [x] 创建 Control Sentinel unit。
- [x] 创建 Executor unit。
- [x] 创建 Reconciler unit。
- [x] 创建 Exit unit。
- [x] 配置非 root service user。
- [x] 配置 WorkingDirectory。
- [x] 配置 EnvironmentFile/LoadCredential。
- [x] 配置 umask 和 runtime permissions。
- [x] 配置 restart/backoff。
- [x] 配置 Type=notify、30 秒 watchdog heartbeat、ready/stopping 通知，并用注入式 notifier 断言心跳。
- [x] 配置 journald redaction/rotation。
- [x] 配置 network/time dependencies。
- [x] 用绝对路径 renderer 原子生成四个 unit，并拒绝缺失 entrypoint/未解析 placeholder/危险路径。
- [x] Executor 在启动和每次签名前要求 current Reconciler/Exit、匹配 profile/auth、WAL、10 signer 和零 unresolved attempt。
- [x] 实现独立 production Executor/Reconciler/Exit entrypoint，release build 生成对应 `dist/*-service.js`。
- [x] Control 服务实际 readback 与 artifact SHA 对齐，见 [2026-08-16-control-deployment.md](./receipts/2026-08-16-control-deployment.md)。
- [ ] Executor/Reconciler/Exit 在最终协议证据完成后部署并回读。

验收：

- [x] Control 服务重启后恢复监控状态；该服务无 signer、无 intent 写入能力。
- [ ] Executor 服务重启后恢复 canonical state 且不重复 intent。
- [x] `/proc`、journal、immutable release 目录不泄露 key；Control OS 用户不可读 wallet key。

### STORY-104：Region/RPC Benchmark（P1）

目标：用数据选择 active executor 云区域和 provider 组合。

`BLOCKED_BY: NO_MULTI_REGION_HOSTS_OR_APPROVED_PROVIDER_CANDIDATES`。样本采集、错误率、p50/p95/p99、抖动和排名算法已实现并测试；下列条目是真实多区域测量，仍需云主机输入。

- [ ] 选择候选云区域。
- [ ] 测量 WSS newHeads arrival。
- [ ] 测量 exact log arrival。
- [ ] 测量 eth_call latency。
- [ ] 测量 direct Sequencer invalid-payload roundtrip。
- [ ] 测量 production RPC send roundtrip（只用无效 payload/受控方法）。
- [ ] 测量错误率/p95/p99/抖动。
- [ ] 保存时间范围和网络条件。
- [ ] 选择 active region 和 fallback providers。

验收：

- [ ] 区域选择有可重现 benchmark，不凭主观判断。

### STORY-105：Active/Observer 故障切换（P1）

目标：观察冗余但签名保持单 writer，防止双 payload。

- [ ] 部署一台 active executor。
- [x] 部署一台无私钥 observer（当前与 Control Sentinel 同机）。
- [ ] observer 验证 signal coverage/latency。
- [x] 定义 active failure detection。
- [x] 定义受控接管流程。
- [x] 无共享 lease 时禁止自动双 active。
- [x] 接管前核对 open UNKNOWN/nonces。
- [x] 接管后复用 canonical DB/vault 或停止新 entry。

验收：

- [x] 故障演练不会产生同 nonce 不同 payload。

---

## Phase 11：完整验证、发布与实盘待命

### STORY-110：单元与集成测试扩展（P0）

目标：覆盖 plan 中所有 correctness invariants 和关键 adaptive gates。

- [x] 重复/乱序/removed signals。
- [x] 同名 spoof、错误 creator/metadata/profile。
- [x] 40→0、40→1、99% profile。
- [x] 10 wallet reservation/nonce/cap。
- [x] lane 1 canary 和后九 lane 独立调度。
- [x] catch-up policies。
- [x] same-raw provider outcomes。
- [x] UNKNOWN/restart/vault。
- [x] receipt/no-token/reorg。
- [x] position aggregation。
- [x] inner/outer route migration。
- [x] principal recovery/runner。
- [x] entry disabled/exit enabled。
- [x] secret/log/dashboard redaction。
- [x] immutable production profile、精确 `4000→0/120s`、7 天授权和 launch-bound route。
- [x] append-only plan/attempt/route/exit revisions、pre-broadcast cleanup 和 service lease release。
- [x] Reconciler/Exit dependency interlock、redacted status 和 systemd watchdog。

验收：

- [x] 覆盖率不低于门槛。
- [x] 所有关键错误都断言具体 reason code/state，不只断言 throw。

### STORY-111：Historical Fork / Replay（P0）

目标：用历史 launch 验证真实 calldata、状态变化、竞争和退出。

`BLOCKED_BY: NO_FINAL_MAINNET_PROFILE_OR_REPRODUCIBLE_RELEVANT_LAUNCH_BLOCK`。不使用测试网/旧 ABI 生成与最终 ClockIn 机制无关的“通过”回执。

- [ ] 选择可复现历史 Factory/launch blocks。
- [ ] 重放 create/launch/activation。
- [ ] 重放首个合法 buy block。
- [ ] 对比 EOA 与中介合约。
- [ ] 对比单 EOA 与 10 EOA。
- [ ] 重放 10×5U fee bands。
- [ ] 插入竞争买单测 quote drift。
- [ ] 重放内盘 sell。
- [ ] 重放 finalize 和外盘 swap。
- [ ] 重放 transfer tax/归集差异。
- [ ] 计算实际 Gas、fee、impact、net out。
- [ ] 保存 replay inputs/outputs 和结论。

验收：

- [ ] buy→receipt→position→sell→回款链路完整。
- [x] replay 不能被描述为 live receipt。

### STORY-112：Chaos 与恢复演练（P0）

目标：在最容易造成重复资金动作的断点验证幂等性。

`BLOCKED_BY: PROCESS_LEVEL_CHAOS_REQUIRES_FINAL_ADAPTER_AND_DEPLOYED_HOST`。下方已勾选项为确定性单元/集成故障注入；estimator/finalize 的真实进程级崩溃仍需最终 adapter 和部署环境。

- [x] launch block 前后 WSS 断线。
- [x] sendRaw timeout 后进程崩溃。
- [x] receipt 前重启。
- [ ] lane 1 成功后 estimator 崩溃。
- [ ] finalize 时重启。
- [x] RPC split brain。
- [x] key file 不可读。
- [x] DB lock/WAL 恢复。
- [x] 网站返回旧 CA。
- [x] 外盘移除流动性。

验收：

- [x] 无重复 Intent、预算、nonce 或 position。
- [x] 所有 UNKNOWN 最终有明确 age/state/处置。

### STORY-113：安全与发布审计（P0）

目标：公开仓库、npm artifact 和云部署都不泄露 secret。

- [x] 运行 repo secret scan。
- [x] 检查 Git history secret scan。
- [x] 检查 staged diff。
- [x] 检查 `npm pack --dry-run`。
- [x] 解包 release artifact 再扫描。
- [x] 检查 systemd credentials 权限：模板/静态测试通过；云机 root-only credential/wallet 目录和 Control OS 隔离已回读，资金服务仍未启动。
- [x] 检查 journal/dashboard/alerts。
- [x] 检查 SQLite/vault permissions。
- [x] 检查依赖 lockfile 和 audit 结果。
- [x] 记录风险接受项。

验收：

- [x] 审计报告没有未解释的 high severity finding。

### STORY-114：Production Readiness Receipt（P0）

目标：在 launch 前生成一份可审计的 `HOT_ARMED` 证明。

`BLOCKED_BY: READINESS_RECEIPT_IS_NOT_HOT_ARMED`。已创建 [receipts/production-readiness.md](./receipts/production-readiness.md) 负面回执，逐项记录证据、blocker 和 owner，不伪造 `HOT_ARMED`。

- [x] chainId/current head。
- [x] HTTP/WSS/direct Sequencer health（生产 Control readback）。
- [ ] Factory/Profile current bytecode readback。
- [ ] exact/topic-wide subscriptions。
- [x] 10/10 wallet address/balance/nonces（每个 `0.0032 ETH`、latest/pending `0/0`）。
- [x] principal/entry Gas/exit Gas reservation（当前 price/Gas snapshot 下 10/10 ready、60U all-in cap ready）。
- [x] Price Snapshot freshness（生产 Control 持续双源刷新；不等于 launch authorization）。
- [ ] strategy config hash/authorization。
- [x] DB/leases/vault readiness。
- [ ] inner/outer exit adapter readiness。
- [ ] open UNKNOWN/positions。
- [x] keyless Control deployed artifact SHA/systemd readback。
- [ ] Hot Executor/Reconciler/Exit artifact SHA/systemd readback。

验收：

- [ ] receipt 明确写 `HOT_ARMED`，不写“已成交”。
- [x] 任一缺口有具体 blocker 和 owner。

### STORY-115：Public GitHub 首次发布（P0）

目标：把限定范围、通过质量门的项目同步到 Public GitHub。

- [x] 初始化根 Git 仓库并使用 `main`。
- [x] 确认 `git status` 只包含预期文件。
- [x] 运行完整 verify/coverage/package audit。
- [x] 创建清晰的首次提交。
- [x] 创建 `MeiYanDong/clockin-sniper` Public 仓库。
- [x] 添加并验证 `origin`。
- [x] push `main`。
- [x] 回读 repository visibility = PUBLIC。
- [x] 回读 default branch = main。
- [x] 回读 GitHub Actions 首次 CI 状态。
- [x] 设置分支保护：PR、CI required、禁止 force push；个人仓库使用 0 次强制 approval，但必须走 PR。
- [x] 在 README 放置 CI 状态链接。

验收：

- [x] Public URL 可访问。
- [x] GitHub 文件范围与本地 staged scope 一致。
- [x] 首次 CI 通过。

### STORY-116：首个版本发布（P1）

目标：在核心实现完成后生成可追溯版本，而不是把任意 main commit 当生产版本。

- [x] 更新 package version。
- [x] 更新 CHANGELOG。
- [x] 更新 capability manifest。
- [x] 创建 release PR #5：`feat(v2): implement evidence-bound ten-lane architecture`；required checks 已通过。
- [x] 合并后创建受 ruleset `20907328` 保护的 tag `v0.1.0`。
- [x] CD run `31940616256` 生成并发布 tgz、`SHA256SUMS` 与 `BUILD-METADATA.json`。
- [x] GitHub Release v0.1.0 附 Tech Spec、ADRs、known limitations、测试/覆盖率与 checksum。
- [x] 云机 Control 仅部署用户批准、可追溯到 commit `61d9be5` 的 artifact SHA；该批准不授权资金执行。
- [ ] Hot Executor 仅部署最终 `HOT_ARMED` 后批准的 release artifact。

验收：

- [x] release artifact 可追溯到 commit `47cc18d`、197 项测试、覆盖率和 capability manifest revision 2；发布回执已保存。

---

## Phase 12：真实事件后的闭环证据

### STORY-120：真实 Entry Effect（P0，事件触发）

目标：真实 launch 时为每个尝试建立 canonical 经济记录。

- [ ] 保存冻结 LaunchIdentity。
- [ ] 保存 10 lane ExecutionPlans。
- [ ] 保存每个 provider transport outcome。
- [ ] 保存每个 canonical receipt/revert/unknown。
- [ ] 保存 token balance delta。
- [ ] 保存 Gas 和 actual friction。
- [ ] 保存未发/失败 lane 原因。
- [ ] 核对 aggregate principal ≤ 50U。
- [ ] 更新 PositionLots。

验收：

- [ ] 不以 accepted/txHash 替代 receipt/effect。

### STORY-121：真实 Exit Effect（P0，事件触发）

目标：证明 position 可以兑现并计算真实净结果。

- [ ] 保存每次 sell 前可执行 quote。
- [ ] 保存 route/profile revision。
- [ ] 保存 sell/swap receipt。
- [ ] 保存 quote balance delta。
- [ ] 保存 sell Gas/tax/impact。
- [ ] 更新本金回收进度。
- [ ] 更新 realized PnL。
- [ ] 保存 residual exposure。
- [ ] 无法退出时保存具体机制证据和处置。

验收：

- [ ] position closed 或 residual 被明确记录。
- [ ] 只有完成真实退出后才讨论 realized profitability。

### STORY-122：竞速复盘与下一版本（P1，事件后）

目标：用真实时间线和经济结果改进，而不是凭感觉增加钱包或 Gas。

- [ ] 统计 signal→wire→inclusion 分段 p50/p95/p99。
- [ ] 统计 exact/topic/address/site 各 source lead time。
- [ ] 统计 10 lanes fill/miss/revert/unknown。
- [ ] 统计 declared fee/actual friction/drift。
- [ ] 统计每 route 可执行净回款。
- [ ] 分析竞争交易和同块排序。
- [ ] 分析 false block 与错失成本。
- [ ] 更新 Race Thesis。
- [ ] 更新 ADR/plan/todo/capability manifest。
- [ ] 只基于证据决定是否调整钱包数、catch-up、CA gate、Gas 或 exit 阈值。

验收：

- [ ] 每个参数调整都有数据、假设和反证条件。

---

## 33. 当前里程碑摘要

### 已完成

- [x] `docs/plan.md` 已建立完整产品/技术规格。
- [x] 当前单钱包 Factory-first executor 已有 70 个通过测试的基线。
- [x] 当前代码已具备 Factory exact discovery、code hash、same-raw、UNKNOWN 和 receipt/token delivery 基础能力。
- [x] 当前私钥加载边界已迁到仓库外，并已有 secret scan/npm ignore 基础。
- [x] 已测得当前质量基线：line 87.41%、branch 65.69%、function 88.61%。
- [x] 本可执行 todo 已按小故事卡、阶段、测试和验收拆解。
- [x] v2 Canonical/SQLite/Control/10-EOA/Entry/Recovery/Position/Exit-policy/Ops 与 `clockin-policy-v2` 已实现；生产 profile/adapters/三服务/interlock/watchdog 已补齐并通过 225 项测试。
- [x] 默认 live 入口在主网证据不完整时失败关闭，旧单钱包入口不进入 release artifact。
- [x] 已生成 10 个仓库外 one-shot EOA，完成本地与服务器 10/10 key/address correspondence，并为每个钱包注入 `0.0032 ETH`；生产回读 nonce 均为 `0/0`。
- [x] 已在 `47.251.28.201` 部署 keyless Control Sentinel，生产 HTTP/WSS/Sequencer、钱包 readiness、systemd 重启和 artifact SHA 回读通过；资金服务代码已完成但保持未启动、未授权。

### 下一批必须先完成

- [x] 完成 STORY-000～005 的仓库实现：Public 仓库、CI/CD 配置和工程质量基线。
- [x] 完成 STORY-014：用户资金、价格、授权、cap 与退出参数冻结。
- [ ] 完成 STORY-010～013：最终 Factory/Pool/ABI 主网证据冻结。
- [x] 在不越过 `GATE-A` 授权的前提下完成通用资金执行核心；默认入口继续 fail closed。
