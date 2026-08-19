# ClockIn Sniper v2

ClockIn Sniper v2 是 Robinhood Chain (`chainId=4663`) 的事件驱动、10 EOA 生产架构实现。核心预算为 10 个独立 one-shot wallet，每 lane 名义最多 5U WETH，总本金上限 50U、含预留 Gas 的 all-in 上限 60U；目标费率由 quoted launch 的实际 `startTaxBps/decayBpsPerMinute/window/floor` 动态生成，不在代码里把某次读取结果当成永久事实。

## 当前状态

`capability-manifest.json` 当前声明 `ENTRY_HOT_ARMED`，同时明确 `NO_LIVE_EFFECT` 与 `QUOTED_GENERIC_EXIT_UNSUPPORTED`。2026-08-20 已冻结当前 ClockIn WETH quoted 主路的 pad、approved creator、`LaunchCreated`、`LaunchArmed`、`getLaunch/currentTaxBps/quoteBuy` 和 `buy` 绑定；旧的“最终 Factory/ABI 未发布”已被这一新证据取代。常驻 Control 的链 transport 仍是 Robinhood 官方公共 HTTP RPC 的 keyless failover pool；X/官网只异步确认或报告 CA 冲突，不会占用事件→签名热路。

commit `9014c45df1370112803110b64e683caab65d9ac4`、capability revision `17` 的 immutable quoted release 已部署到 `47.251.28.201` 并完成 hash readback。Control 当前 active（PID `439288`），状态为 `KEYLESS_PUBLIC_HTTP_FAILOVER`，active route 为 `BLOCKREQ_FALLBACK`；cursor/head 均为 `40914339`，lag `0`、`caughtUp=true`。`clockin-executor.path` 已 enabled/active waiting，两个 marker 均为 `root:clockin 0440`。CA 尚未出现、handoff 为 none，因此 Wallet Preparer/Executor/Reconciler/generic Exit 均为 static inactive、PID `0`，没有 paid process 或 buy receipt。

一次性 Wallet Preparer 已形成 20 个 canonical preparation receipts：10 次 WETH deposit 和 10 次对精确 quoted pad 的 amount-bounded approve。在 block `40908857`，10/10 钱包 nonce 为 `2`，每个 WETH balance 与 allowance 均为 `2407976970983877` raw，并保有正数 native Gas。完整生产边界见 [entry hot-armed receipt](../docs/receipts/2026-08-20-clockin-entry-hot-armed.md)。

- 默认生产命令是 quoted `npm run executor`；它只由 public handoff path 启动，不能手动常驻；
- Control 不读取 signer/paid credential，handoff 前不会启动 Executor/Reconciler；
- legacy live、legacy executor 和钱包生成入口不进入 release build；
- release archive audit 明确要求 Control、quoted Executor、Wallet Preparer、Reconciler、Exit 和 path unit，并拒绝旧 live/legacy executor/wallet generation、源码、测试和 secret-shaped 内容。

生产 entry 解锁已经完成并由 `ENTRY_HOT_ARMED` 回执证明。它不代表已成交；真实买入只能在 launch 后由 canonical receipt/delta/`EffectRecord` 证明。generic quoted Exit 仍是 `UNSUPPORTED`，不能把 entry 武装写成自动退出已武装。

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

quoted entry adapter 的主网身份与调用语义已验证，本地 clean-tree 全量门禁也已通过；这些仍不等于生产部署或成交已完成。当前 generic Exit 无法解析 quoted profile，能力状态是 `UNSUPPORTED`；它不再是 lanes 2–10 的 entry 前置，但意味着不能宣称自动退出已武装。

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

`vault_key` 必须表示精确 32 bytes，可使用裸 64 位 hex、小写 `0x` + 64 位 hex，或标准 base64（可带/不带 padding）。两种 hex 形式解码为相同字节；只改文本前缀时不得重新生成 key。部署预检只输出解码长度，不输出 key 内容。

生产部署按 `../docs/runbooks/production-deployment.md` 执行。Control Sentinel 使用独立无私钥账户、官方公共 RPC 和非敏感 `control.env`；它没有任何 systemd credential。Executor/Reconciler 受两个精确 `root:clockin 0440` marker 和运行时复检约束；只有付费服务组可读，root 仍是唯一写入/撤销者，signer 只通过 systemd `LoadCredential` 注入。生产钱包已在 path disabled 时完成有回执、可恢复的 WETH deposit/approve。当前 10/10 钱包各有 `2407976970983877` raw WETH 与等额 exact-pad allowance、nonce `2` 和正数 native Gas；公共 cursor 已 caught up，且只启用 `clockin-executor.path`。无 handoff 时资金服务保持 inactive 是预期状态。

## 当前等待的真实事件

1. Public Control 只为 exact pad + approved creator + exact metadata + canonical block hash 生成 handoff，tombstone 不触发 path；15 分钟未 Armed 后公共侧仍可在晚到 Armed 时重新唤醒。
2. valid-only `active.signal` 出现后，已启用的 path 才启动 Executor/Reconciler；当前 handoff none，所以两者保持 inactive、零付费进程。
3. `9999 bps` buffer 期间不买；每 lane 用 Armed `quoteUsd8` 向下取整得到最多 5U raw，并以 `deadline-1` 实际可成交税率为准。
4. canary 必须得到 canonical receipt/effect，Reconciler 必须新鲜；lanes 2–10 不要求 Exit 就绪，但要求剩余钱包保持完整 readiness。
5. CA、tx hash、RPC accepted 或服务 active 都不能证明成交；真实成交还需 canonical buy receipt、WETH/token delta、Gas 归因和 `EffectRecord`。
6. generic quoted Exit 仍 `UNSUPPORTED`，没有自动退出已武装的声明。

详细实现边界见 `../docs/plan.md`、`../docs/todo.md` 和 `capability-manifest.json`。
