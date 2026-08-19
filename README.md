# ClockIn Sniper

[![CI](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml)

Robinhood Chain (`chainId=4663`) 上的 ClockIn / Stonk Launcher 生产架构实现。

仓库已经实现并测试 v2 的 Canonical Model、SQLite WAL 状态、Factory Control Sentinel、10 个独立 one-shot EOA、动态税率十档入场、WETH quoted buy、7 天 scope-bound 授权、same-raw 广播与 UNKNOWN 恢复、双阶段退出与 5%/20% 分离滑点、readiness、只读 Dashboard、告警、systemd 模板和发布边界。

当前生产状态是 `ENTRY_HOT_ARMED / NO_LIVE_EFFECT / QUOTED_EXIT_UNSUPPORTED`，不是“已成交”。2026-08-20 的主网证据已取代“最终 Factory/ABI 未发布”这一旧 blocker：ClockIn 当前主路是已验证的 WETH quoted pad，热路为精确 pad + approved creator 的 `LaunchCreated(id, token, creator, externalToken)` 识别 CA，再等待同 `id` 的 `LaunchArmed`，然后按链上 `getLaunch/currentTaxBps/quoteBuy` 的当前值构造 `buy(id, quoteIn, minTokensOut, ref)`。X/官网不参与热路，只做异步确认或 CA 冲突告警。

commit `9014c45df1370112803110b64e683caab65d9ac4` 的 quoted artifact、immutable profile 与 7 天授权已部署到 `47.251.28.201` 并完成 hash 回读。一次性 Wallet Preparer 已得到 20 个 canonical receipts（10 次 WETH deposit + 10 次精确 pad 的有界 approve）；在 block `40908857`，10/10 钱包 nonce 均为 `2`，每个 WETH 余额与 allowance 均为 `2407976970983877` raw，并保有正数 native Gas。

当前 quoted 执行将 10 个 lane 按实读的初始税率到 `deadline-1` 最后可成交 floor 生成十档，每档名义最多 5U WETH。当前默认 `3300/100/1980` 的 floor 是 1%，但更长窗口可以在 deadline 前出现 0%，非整除 decay 也合法。每 lane exact raw 由 `LaunchArmed.quoteUsd8` 换算并向下取整；Coinbase/Kraken 只服务于准备期交叉定价，不在 CA→签名热路。准备期使用 10% WETH buffer，并在准备前和 Armed 后分别执行 60U all-in gate；执行器从不把 buffer 当成可花 principal。当前主路只需 WETH principal + native ETH Gas，不需准备 STONK。

公共 Control 当前以 `KEYLESS_PUBLIC_HTTP_FAILOVER` 运行，active route 为 `BLOCKREQ_FALLBACK`；cursor 与 confirmed head 均为 `40914339`，lag `0`、`caughtUp=true`。`clockin-executor.path` 已 enabled/active 并等待 valid-only `active.signal`，两个 marker 均为 `root:clockin 0440`。CA 尚未出现，因此 handoff 为 none，Executor/Reconciler/Wallet Preparer/generic Exit 均为 static inactive、PID `0`；这是零付费进程的正确 armed-idle 状态。Created 后 15 分钟未 Armed 只会让 paid Executor 停止消耗，公共侧仍监控同 id 晚到 Armed 并重新触发。每次本地签名紧前重新校验 marker、canonical handoff/block、quote freshness 与 authorized base-fee ceiling；只有能证明广播从未发生的 crash gap 才可释放 nonce/预算，其他情况只许 same-raw reconciliation。

## 证据边界

- 代码、fixture 和本地测试只能证明实现行为，不能证明当前主网协议身份或交易结果。
- transport `accepted`、txHash 或 RPC 配置不能替代 canonical receipt、token/quote balance delta 和 `EffectRecord`。
- launch 前 `ENTRY_HOT_ARMED` receipt 只证明 entry 观测/唤醒/签名/资金准备就绪；真实成交另需 launch 后 `CANONICAL_ENTRY_EFFECT_CONFIRMED`。
- 已冻结的 quoted pad/creator/event/getter/buy 证据可用于本地 profile；任何新合约、代码漂移或未知 route 仍不得由 testnet/demo 推导。
- 只有第一笔 5U 可接受“Factory 证明 + 非空实读 code”；这个例外不授权余下 45U。
- 当前 generic Exit 对 quoted profile 是 `UNSUPPORTED`；这不阻塞已接受风险的 entry，但绝不能宣称自动退出已武装。
- v0 单钱包入口仅保留作审计/回放兼容，不属于默认构建导出或 release artifact。
- 仓库不包含私钥、助记词、钱包备份、带凭证 RPC、资金授权或 signed raw transaction。

当前实现证据见 [2026-08-20 CLOCKIN quoted hot path evidence](docs/evidence/2026-08-20-clockin-quoted-hotpath.md)，生产武装回读见 [2026-08-20 entry hot-armed receipt](docs/receipts/2026-08-20-clockin-entry-hot-armed.md)，机器可读状态见 [capability manifest](clockin-sniper/capability-manifest.json)。

## 质量基线

要求 Node.js 24 LTS：

```bash
cd clockin-sniper
npm ci
npm run verify
```

2026-08-20 当前本地功能测试为 386/386；core coverage 为 line `89.13%`、branch `68.60%`、function `88.19%`，五个生产入口另设防回退门（line `34.35%`、branch `70.41%`、function `68.82%`）。CI 还执行格式、lint、strict typecheck、仓库与 Git 历史 secret scan、production dependency audit 和 package audit。

## 文档

- [plan.md](docs/plan.md)：完整 Tech Spec。
- [todo.md](docs/todo.md)：逐项实现状态；外部事件/主网证据任务保持未勾选。
- [ADRs](docs/adr/README.md)：架构决策记录。
- [Runbooks](docs/README.md)：钱包、部署、故障切换和区域基准流程。
- [Receipts](docs/receipts/README.md)：仓库、CI、部署或链上效果的证据回执。
- [Executor README](clockin-sniper/README.md)：模块、命令和 release 边界。

贡献规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 许可

当前未选择开源许可证。Public 可见不等于授予复制、修改或再分发许可。
