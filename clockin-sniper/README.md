# ClockIn Sniper v2

ClockIn Sniper v2 是 Robinhood Chain (`chainId=4663`) 的事件驱动、10 EOA 生产架构实现。核心预算为 10 个独立 one-shot wallet，每 lane 名义最多 5U WETH，总本金上限 50U、含预留 Gas 的 all-in 上限 60U；目标费率由 quoted launch 的实际 `startTaxBps/decayBpsPerMinute/window/floor` 动态生成，不在代码里把某次读取结果当成永久事实。

## 当前状态

`capability-manifest.json` 当前仍声明 `NOT_HOT_ARMED`，新 hot-path 收口处于 `IMPLEMENTED_FINAL_GATE_PENDING`。2026-08-20 已冻结当前 ClockIn WETH quoted 主路的 pad、approved creator、`LaunchCreated`、`LaunchArmed`、`getLaunch/currentTaxBps/quoteBuy` 和 `buy` 绑定；旧的“最终 Factory/ABI 未发布”已被这一新证据取代。常驻 Control 的唯一链 transport 仍是 Robinhood 官方公共 HTTP RPC；X/官网只异步确认或报告 CA 冲突，不会占用事件→签名热路。

本地已完成 quoted adapter/discovery、exact-metadata public handoff、reorg replacement、dynamic quote/tax、WETH readiness/preparation recovery、真实 executor restart/lifecycle 的代码与测试。这些仍只是本地产物，不是生产部署回执。`47.251.28.201` 上仍只有 revision 11 公共 Control `enabled/active`，三个资金服务 `disabled/inactive`，`PAID_RPC_APPROVED`/`PRODUCTION_ARM_APPROVED` absent，因此线上当前不会买。10 个钱包均为 `0 WETH / 0 allowance`，尚未 wrap/approve；每个 `0.0032 ETH` 只是 native 余额证据。

- 默认生产命令是 quoted `npm run executor`；它只由 public handoff path 启动，不能手动常驻；
- Control 不读取 signer/paid credential，handoff 前不会启动 Executor/Reconciler；
- legacy live、legacy executor 和钱包生成入口不进入 release build；
- release archive audit 明确要求 Control、quoted Executor、Wallet Preparer、Reconciler、Exit 和 path unit，并拒绝旧 live/legacy executor/wallet generation、源码、测试和 secret-shaped 内容。

生产解锁需要把通过最终全量门禁的 artifact/profile/authorization 部署到云机，对 10 个钱包执行精确金额 WETH wrap/approve，并完成付费 RPC、marker、Reconciler 与 current readiness 回读。launch 前回执名为 `ENTRY_HOT_ARMED`，它不代表已成交；真实买入只能在 launch 后由 canonical receipt/delta/`EffectRecord` 证明。

## 已实现模块

- Canonical Model、显式 Knowledge/Authorization/Validity/Effect 状态机；
- SQLite migrations、WAL/FULL、预算/nonce 原子 reservation、service fencing、NDJSON 审计迁移；
- subscribe-before-backfill Known Factory channel、topic-wide discovery、地址集群、官网/JSON/bundle fallback、profile registry；
- immutable Launch Identity、L0–L4 授权、official-first/ClockIn 双策略隔离；
- exact-block mechanism read、40→0 / 40→1 / 99% 反例 profile；
- 10 个 repository-external 0600 key、public manifest、funding/nonce/Gas readiness、双源 5U price snapshot、7 天 scope-bound authorization；
- 十档 planner、lane-1 speed canary、lanes 2–10 独立调度、1U–5U cap 缩量、cooldown/EOA-only/catch-up/minOut，以及按 `deadline-1` 枚举、支持 0 bps 与非整除 decay 的动态最后可成交税率；
- 单笔最多 5U WETH 的 `BOUNDED_CANARY` 与后续 45U 分级解锁；WETH quoted pad 为当前 ClockIn 主路，native ETH 用于 WETH deposit 与 Gas，不需 STONK；
- same-raw 多 provider fanout、UNKNOWN encrypted vault recovery、receipt/balance/log reconciliation、reorg revision；
- PositionLots、launch/external route registry、net liquidation、2× 本金优先、3× 第二止盈、回本前双区块止损与 60 分钟上限、24 小时 runner；
- 常规退出 5% 滑点硬上限，以及必须二次确认且绑定审计 ID 的 20% `BREAK_GLASS` 独立路径；
- entry/exit 独立开关、health/readiness、证据型 Dashboard、异步 redacted alerts；
- active/keyless-observer single-writer failover、region benchmark primitives、valid-only `active.signal`、`<=2,000` block cursor commit/caught-up gate、late-Armed retrigger、public handoff reorg tombstone/boot replay、hardened systemd/release templates。
- immutable production profile/7 天授权解析、Factory event exact decode、launch-bound pool target、configured buy/sell route、Executor/Reconciler/Exit 三进程、append-only crash recovery、redacted status interlock 和 systemd watchdog。
- 官网 raw/semantic 双指纹、scope-bound launch 状态和未验证候选地址集合，以及同一公共 RPC 物理限速器内的链头 foreground / readiness background 优先级调度。

quoted entry adapter 的主网身份与调用语义已验证，但“实现/targeted tests 通过”仍不等于本次全量门禁、部署或成交已完成。当前 generic Exit 无法解析 quoted profile，能力状态是 `UNSUPPORTED`；它不再是 lanes 2–10 的 entry 前置，但意味着不能宣称自动退出已武装。

## 验证和构建

要求 Node.js 24 LTS：

```bash
npm ci
npm run verify
npm run build
```

2026-08-20 当前功能基线：386/386 tests；core coverage 为 line `89.13%`、branch `68.60%`、function `88.19%`；五个生产入口的独立防回退 coverage 为 line `34.35%`、branch `70.41%`、function `68.82%`。`verify` 包含：

- current tree 与完整 Git history secret scan；
- Biome format/lint；
- strict TypeScript typecheck；
- 核心模块 85/60/80 覆盖率门槛和独立生产入口覆盖率防回退门；
- production dependency audit；
- `npm pack --dry-run`。

正式 artifact 还会解包检查，要求包含 `BUILD-METADATA.json`、capability manifest、Control、quoted Executor、Wallet Preparer、Reconciler、Exit、`dist/v2-index.js` 和 path unit，并拒绝旧 live/legacy executor/wallet generation、`src/`、`test/`、env、key、authenticated RPC 和 raw signed transaction。

## Wallet 与部署

钱包只能生成到仓库外路径：

```bash
npm run wallets:create -- --output /absolute/external/secret/directory
```

工具只在终端输出可验证 public address；private key 保持在 mode-0600 文件，manifest 不记录 key path。资金准备必须在首笔准备交易前冻结 10/10 plan：每 lane 预备 5U 对应 WETH + 10% buffer，加 wrap/approve/entry max Gas 后总计不超过 60U。Armed 后 exact buy raw 由 `quoteUsd8` 向下取整计算，并再验证 50U principal + entry max Gas 不超过 60U；禁止 infinite approval。

生产部署按 `../docs/runbooks/production-deployment.md` 执行。Control Sentinel 使用独立无私钥账户、官方公共 RPC 和非敏感 `control.env`；它没有任何 systemd credential。Executor/Reconciler 受 root-owned 双 marker 和运行时复检约束，signer 只通过 systemd `LoadCredential` 注入。生产钱包当前各有 `0.0032 ETH`，但 WETH 余额与 pad allowance 均为 0；必须在 path disabled 时完成有回执、可恢复的 wrap/approve，公共 cursor caught-up 后才只启用 `clockin-executor.path`。模板、inactive unit 或本地 artifact/profile/auth 存在都不等于 `ENTRY_HOT_ARMED`。

## 解锁实盘所需输入

1. 将已验证的 quoted artifact、immutable profile 和 <=7 天 AuthorizationRecord 部署到云机，并回读 hash/scope/expiry；
2. 逐钱包 wrap 准确 WETH principal 准备金并向精确 quoted pad approve 有界金额，回读 `10/10 WETH + allowance + clean nonce + native Gas` readiness；
3. 为真实狙击窗口创建并校验双 marker，在 path disabled 时运行一次性 Wallet Preparer；
4. 10/10 readiness、recovery journal terminal 且 public cursor caught-up 后，只 enable/start `clockin-executor.path`，Executor/Reconciler 保持 inactive 等待 valid-only `active.signal`；
5. Public Control 只为 exact pad + approved creator + exact metadata + canonical block hash 生成 handoff，tombstone 不触发 path；15 分钟未 Armed 后公共侧仍可在晚到 Armed 时重新唤醒；
6. `9999 bps` buffer 期间不买；每 lane 用 Armed `quoteUsd8` 向下取整得到最多 5U raw，并以 `deadline-1` 实际可成交税率为准；
7. canary 必须得到 canonical receipt/effect，Reconciler 必须新鲜；lanes 2–10 不要求 Exit 就绪，只要求剩余钱包保持完整 readiness；
8. launch 前回读必须生成 `ENTRY_HOT_ARMED`，证明 handoff 前 Executor/Reconciler inactive、handoff 后可自动 active；真实成交还需另外的 canonical effect receipt，generic Exit 仍 `UNSUPPORTED`。

详细实现边界见 `../docs/plan.md`、`../docs/todo.md` 和 `capability-manifest.json`。
