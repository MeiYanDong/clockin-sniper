# ClockIn Sniper v2

ClockIn Sniper v2 是 Robinhood Chain (`chainId=4663`) 的事件驱动、10 EOA 生产架构实现。核心预算为 10 个独立 one-shot wallet，每 lane 名义最多 5U，总本金上限 50U、含预留 Gas 的 all-in 上限 60U；目标费率由最终 Pool 的实际 `initial/floor/decay` 证据动态生成，不在代码里把 40%/2min 猜成永久事实。

## 当前状态

`capability-manifest.json` 当前声明 `NOT_HOT_ARMED`。官方尚未发布最终主网 Launcher Factory、ClockIn CA、launch/buy/sell/finalize ABI 和可验证退出路由，执行钱包未注资，云环境也未部署。因此：

- `npm run live` 只读取公开 capability manifest，输出 blocker，返回 exit code 2；
- 它不会读取 signer credential、构造交易、签名或广播；
- `live:legacy-v0` 和 `live:known-target:legacy-v0` 只是旧实现审计/回放入口，不满足 v2 生产要求；
- release build 只从 `v2-index.ts`、`live-v2.ts` 和钱包批量工具的依赖图生成，archive audit 明确拒绝旧 live 文件、源码、测试和 secret-shaped 内容。

最终主网资料可用后，必须先更新 profile/adapter、完成 exact-block 身份核验、fork/replay、钱包 readiness 和 Production Readiness Receipt；只有所有 P0 gate 都是 `VERIFIED_CURRENT` 才能把默认入口改为真实执行编排。

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

接口和 fixture 的“实现/测试通过”不等于最终主网 adapter 已验证。`sell-adapter.ts`、route/finalize interfaces 仍需绑定官方最终 ABI 后才能实盘使用。

## 验证和构建

要求 Node.js 24 LTS：

```bash
npm ci
npm run verify
npm run build
npm run live
```

2026-08-16 本地基线：207/207 tests；line `89.58%`、branch `72.27%`、function `94.70%`。`verify` 包含：

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

生产部署按 `../docs/runbooks/production-deployment.md` 执行。Control Sentinel 使用独立无私钥账户；executor/exit 只通过 systemd `LoadCredential` 接收 10 个 key。模板存在不代表云部署完成，只有 artifact SHA、systemd readback、目录权限和 `/ready` 回执齐全才算部署证据。

## 解锁实盘所需输入

1. 官方最终主网 Factory/ClockIn CA、部署者及 evidence URL；
2. exact-block runtime/proxy/implementation hashes；
3. 最终 launch、mechanism getter、buy/sell、finalize 和 external router ABI；
4. launch 前生成的 <=30 秒双源 Price Snapshot 和绑定最终 chain/profile/config/wallet/budget、未超过 7 天的 AuthorizationRecord；
5. 10 个钱包注资以及独立 exit Gas reserve；
6. 云候选区域、provider 列表和可重复 benchmark；
7. historical fork/replay、chaos、readiness 和人工批准回执。

详细实现边界见 `../docs/plan.md`、`../docs/todo.md` 和 `capability-manifest.json`。
