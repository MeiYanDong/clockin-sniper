# ClockIn Sniper v2

ClockIn Sniper v2 是 Robinhood Chain (`chainId=4663`) 的事件驱动、10 EOA 生产架构实现。核心预算为 10 个独立 one-shot wallet，每 lane 名义最多 5U，总本金上限 50U、含预留 Gas 的 all-in 上限 60U；目标费率由最终 Pool 的实际 `initial/floor/decay` 证据动态生成，不在代码里把 40%/2min 猜成永久事实。

## 当前状态

`capability-manifest.json` 当前声明 `NOT_HOT_ARMED`。10 个外部 key 钱包已完成生产链地址/余额/nonce 回读。常驻 Control 的唯一链 transport 已固定为 Robinhood 官方公共 HTTP RPC，既不接收 Chainstack credential，也不读取 Execution 配置；Executor/Reconciler/Exit 只有在用户显式开启真实狙击付费窗口后才可读取付费 RPC，并继续受独立实盘资金授权约束。但官方尚未发布最终主网 Launcher Factory、ClockIn CA、launch/buy/sell/finalize ABI 和可验证退出路由，所以不存在可用的 production profile 与当前授权，资金服务保持 `disabled/inactive`。因此：

生产回读已确认 revision 10 公共 Control `enabled/active`，semantic website signals 与 foreground/background 公共调度生效；三个付费服务 `disabled/inactive`，两个批准 marker absent。vault key 与官方 Sequencer credential 已 root-only 准备，但最终 Factory/profile/authorization/exit route 仍缺失；证据见 `../docs/receipts/2026-08-18-control-hardening-and-arming-audit.md`。

- `npm run live` 只读取公开 capability manifest，输出 blocker，返回 exit code 2；
- 它不会读取 signer credential、构造交易、签名或广播；
- `live:legacy-v0` 和 `live:known-target:legacy-v0` 只是旧实现审计/回放入口，不满足 v2 生产要求；
- release build 只从 `v2-index.ts`、`live-v2.ts` 和钱包批量工具的依赖图生成，archive audit 明确拒绝旧 live 文件、源码、测试和 secret-shaped 内容。

最终主网资料可用后，必须先生成 immutable profile、完成 exact-block 身份核验、fork/replay、当前钱包 readiness 和 Production Readiness Receipt；只有所有 P0 gate 都是 `VERIFIED_CURRENT`，才允许创建 arm marker 并启动已经实现的真实执行编排。

## 已实现模块

- Canonical Model、显式 Knowledge/Authorization/Validity/Effect 状态机；
- SQLite migrations、WAL/FULL、预算/nonce 原子 reservation、service fencing、NDJSON 审计迁移；
- subscribe-before-backfill Known Factory channel、topic-wide discovery、地址集群、官网/JSON/bundle fallback、profile registry；
- immutable Launch Identity、L0–L4 授权、official-first/ClockIn 双策略隔离；
- exact-block mechanism read、40→0 / 40→1 / 99% 反例 profile；
- 10 个 repository-external 0600 key、public manifest、funding/nonce/Gas readiness、双源 5U price snapshot、7 天 scope-bound authorization；
- 十档 planner、lane-1 speed canary、lanes 2–10 独立调度、1U–5U cap 缩量、cooldown/EOA-only/catch-up/minOut；
- same-raw 多 provider fanout、UNKNOWN encrypted vault recovery、receipt/balance/log reconciliation、reorg revision；
- PositionLots、launch/external route registry、net liquidation、2× 本金优先、3× 第二止盈、回本前双区块止损与 60 分钟上限、24 小时 runner；
- 常规退出 5% 滑点硬上限，以及必须二次确认且绑定审计 ID 的 20% `BREAK_GLASS` 独立路径；
- entry/exit 独立开关、health/readiness、证据型 Dashboard、异步 redacted alerts；
- active/keyless-observer single-writer failover、region benchmark primitives、hardened systemd/release templates。
- immutable production profile/7 天授权解析、Factory event exact decode、launch-bound pool target、configured buy/sell route、Executor/Reconciler/Exit 三进程、append-only crash recovery、redacted status interlock 和 systemd watchdog。
- 官网 raw/semantic 双指纹、scope-bound launch 状态和未验证候选地址集合，以及同一公共 RPC 物理限速器内的链头 foreground / readiness background 优先级调度。

接口和 fixture 的“实现/测试通过”不等于最终主网 adapter 已验证。`sell-adapter.ts`、route/finalize interfaces 仍需绑定官方最终 ABI 后才能实盘使用。

## 验证和构建

要求 Node.js 24 LTS：

```bash
npm ci
npm run verify
npm run build
npm run live
```

2026-08-18 本地基线：240/240 tests；最近一次完整 verify 为 line `89.00%`、branch `68.84%`、function `92.04%`。`verify` 包含：

- current tree 与完整 Git history secret scan；
- Biome format/lint；
- strict TypeScript typecheck；
- 显式 v2 source include 的覆盖率门槛；
- production dependency audit；
- `npm pack --dry-run`。

正式 artifact 还会解包检查，要求包含 `BUILD-METADATA.json`、capability manifest、`dist/v2-index.js` 和 `dist/live-v2.js`，并拒绝旧 live、`src/`、`test/`、env、key、authenticated RPC 和 raw signed transaction。

## Wallet 与部署

钱包只能生成到仓库外路径：

```bash
npm run wallets:create -- --output /absolute/external/secret/directory
```

工具只在终端输出可验证 public address；private key 保持在 mode-0600 文件，manifest 不记录 key path。资金准备必须逐 wallet 核对：最多 5U principal、1 次 entry、1 次 approve、最多 3 次 sell、Gas 30% margin、`latestNonce===pendingNonce`、chainId 和 key/address correspondence；10 个钱包总需求不得超过冻结价格换算后的 60U all-in cap。

生产部署按 `../docs/runbooks/production-deployment.md` 执行。Control Sentinel 使用独立无私钥账户、官方公共 RPC 和非敏感 `control.env`；它没有任何 systemd credential。Executor/Reconciler/Exit 受 root-owned `PAID_RPC_APPROVED` 约束，executor/exit 只通过 systemd `LoadCredential` 接收 10 个 key；Executor 还必须满足独立的 `PRODUCTION_ARM_APPROVED`。生产钱包当前各有 `0.0032 ETH` 且 nonce 为 `0/0`；这些事实只证明上次 funding readiness，不授权交易。模板、inactive unit 或 artifact 存在也不等于 `HOT_ARMED`，只有最终 profile/fork/授权、artifact/systemd/current `/ready` 回执和两个独立 marker gate 全部成立才允许启动。

## 解锁实盘所需输入

1. 官方最终主网 Factory/ClockIn CA、部署者及 evidence URL；
2. exact-block runtime/proxy/implementation hashes；
3. 最终 launch、mechanism getter、buy/sell、finalize 和 external router ABI；
4. launch 前生成的 <=30 秒双源 Price Snapshot 和绑定最终 chain/profile/config/wallet/budget、未超过 7 天的 AuthorizationRecord；
5. launch 前再次确认 10 个钱包余额、干净 nonce、价格和独立 exit Gas reserve；
6. 对现有生产主机和候选区域/provider 做可重复 benchmark；
7. historical fork/replay、chaos、readiness 和人工批准回执。

详细实现边界见 `../docs/plan.md`、`../docs/todo.md` 和 `capability-manifest.json`。
