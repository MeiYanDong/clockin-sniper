# ClockIn Sniper v2

ClockIn Sniper 是 Robinhood Chain (`chainId=4663`) 的事件驱动、10 EOA 生产架构实现。核心预算为 10 个独立 one-shot wallet，每 lane 精确 5U WETH，总本金上限 50U、含预留 Gas 的 all-in 上限 60U。creator-first v3 只使用已验证 Factory + approved creator + canonical primary `LaunchCreated` 授权候选，并在当前税率首次 `<=50%` 时尝试 10 钱包并发实盘买入。

## 当前状态

`capability-manifest.json` 当前声明 `EXPIRED_LAUNCH_AUTHORIZATION_REVOKED`。2026-08-20 的官方 CLOCKIN 已经上链并毕业，但部署的 Control 因 `Clock In`/`CLOCK IN` 大小写 metadata veto 没有产生 handoff；10 个钱包均无买入。新源码已把 name/symbol/X/网站降为非阻塞异步审计，但尚未作为新 artifact 部署或武装。

commit `9014c45df1370112803110b64e683caab65d9ac4`、capability revision `17` 是事故时的历史 release，不包含 creator-first v3。当前 paid path 已 disabled/stopped，Executor/Reconciler/generic Exit 已停止，两个 marker 已撤销并移入 root-only 可恢复归档。这是过期 launch 的正确状态，不是 `ENTRY_HOT_ARMED`。

一次性 Wallet Preparer 已形成 20 个 canonical preparation receipts：10 次 WETH deposit 和 10 次对精确 quoted pad 的 amount-bounded approve。在 block `40908857`，10/10 钱包 nonce 为 `2`，每个 WETH balance 与 allowance 均为 `2407976970983877` raw，并保有正数 native Gas。完整生产边界见 [entry hot-armed receipt](../docs/receipts/2026-08-20-clockin-entry-hot-armed.md)。

- 默认生产命令是 quoted `npm run executor`；它只由 public handoff path 启动，不能手动常驻；
- Control 不读取 signer/paid credential，handoff 前不会启动 Executor/Reconciler；
- legacy live、legacy executor 和钱包生成入口不进入 release build；
- release archive audit 明确要求 Control、quoted Executor、Wallet Preparer、Reconciler、Exit 和 path unit，并拒绝旧 live/legacy executor/wallet generation、源码、测试和 secret-shaped 内容。

历史 `ENTRY_HOT_ARMED` 回执已过期，不能继承给新策略。下一次实盘需新 profile/auth/marker/readiness 回执，且只有 canonical receipt/delta/`EffectRecord` 能证明买入。generic quoted Exit 仍是 `UNSUPPORTED`。

## 已实现模块

- Canonical Model、显式 Knowledge/Authorization/Validity/Effect 状态机；
- SQLite migrations、WAL/FULL、预算/nonce 原子 reservation、service fencing、NDJSON 审计迁移；
- subscribe-before-backfill Known Factory channel、topic-wide discovery、地址集群、官网/JSON/bundle fallback、profile registry；
- immutable Launch Identity、L0–L4 授权、official-first/ClockIn 双策略隔离；
- exact-block mechanism read、40→0 / 40→1 / 99% 反例 profile；
- 10 个 repository-external 0600 key、public manifest、funding/nonce/Gas readiness、双源 5U price snapshot、7 天 scope-bound authorization；
- creator-first `FIRST_BUYABLE_ALL_TEN` planner：当前税率首次 `<=5000 bps` 时将十个各 5U lane 同时纳入调度；
- 十笔同块 quote snapshot、统一授权 slippage/minOut、EOA-only、nonce/cap/Gas/60U all-in 复核；WETH quoted pad 为当前主路，native ETH 仅用于 WETH deposit 与 Gas，不需 STONK；
- same-raw 多 provider fanout、UNKNOWN encrypted vault recovery、receipt/balance/log reconciliation、reorg revision；
- PositionLots、launch/external route registry、net liquidation、2× 本金优先、3× 第二止盈、回本前双区块止损与 60 分钟上限、24 小时 runner；
- 常规退出 5% 滑点硬上限，以及必须二次确认且绑定审计 ID 的 20% `BREAK_GLASS` 独立路径；
- entry/exit 独立开关、health/readiness、证据型 Dashboard、异步 redacted alerts；
- active/keyless-observer single-writer failover、region benchmark primitives、valid-only `active.signal`、`<=2,000` block cursor commit/caught-up gate、late-Armed retrigger、public handoff reorg tombstone/boot replay、hardened systemd/release templates。
- immutable production profile/7 天授权解析、Factory event exact decode、launch-bound pool target、configured buy/sell route、Executor/Reconciler/Exit 三进程、append-only crash recovery、redacted status interlock 和 systemd watchdog。
- 官网 raw/semantic 双指纹、scope-bound launch 状态和未验证候选地址集合，以及同一公共 RPC 物理限速器内的链头 foreground / readiness background 优先级调度。

quoted entry adapter 的主网身份与调用语义已验证，本地 clean-tree 全量门禁也已通过；这些仍不等于生产部署或成交已完成。当前 generic Exit 无法解析 quoted profile，能力状态是 `UNSUPPORTED`；它不再是 lanes 2–10 的 entry 前置，但意味着不能宣称自动退出已武装。

## 验证和构建

要求 Node.js 24 LTS：

```bash
npm ci
npm run verify
npm run build
```

2026-08-20 当前功能基线：393/393 tests；core coverage 为 line `89.28%`、branch `68.90%`、function `88.93%`；五个生产入口的独立防回退 coverage 为 line `34.38%`、branch `70.89%`、function `68.82%`。`verify` 包含：

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

`vault_key` 必须表示精确 32 bytes，可使用裸 64 位 hex、小写 `0x` + 64 位 hex，或标准 base64（可带/不带 padding）。两种 hex 形式解码为相同字节；只改文本前缀时不得重新生成 key。部署预检只输出解码长度，不输出 key 内容。

生产部署按 `../docs/runbooks/production-deployment.md` 执行。Control Sentinel 使用独立无私钥账户、公共 RPC 和非敏感 `control.env`；Executor/Reconciler 受两个精确 `root:clockin 0440` marker 与运行时复检约束。当前 marker absent、path disabled；历史 20 笔 preparation receipts 不能代替新 launch 前的当前余额/allowance/nonce/Gas 回读。

## 当前等待的真实事件

1. Public Control 只为 exact pad + approved creator + `externalToken=false` + canonical receipt/block 生成 handoff；name/symbol/X/网站只异步 audit。
2. 新 one-shot profile/auth/marker/readiness 回执完成后才可 enable valid-only path；现在没有新授权。
3. `9999 bps` buffer 期间不买；当前税率高于 50% 时等待，首个 `<=50%` 的可买块冻结 10 份当前 quote 并发 10×5U。
4. 十笔都要求 strong creator binding、10/10 readiness、fresh Reconciler、positive quote/minOut 和签名紧前复核；不等第一笔 receipt。
5. CA、tx hash、RPC accepted 或服务 active 都不能证明成交；真实成交还需 canonical buy receipt、WETH/token delta、Gas 归因和 `EffectRecord`。
6. generic quoted Exit 仍 `UNSUPPORTED`，没有自动退出已武装的声明。

详细实现边界见 `../docs/plan.md`、`../docs/todo.md` 和 `capability-manifest.json`。
