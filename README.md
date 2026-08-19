# ClockIn Sniper

[![CI](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml)

Robinhood Chain (`chainId=4663`) 上的 ClockIn / Stonk Launcher 生产架构实现。

仓库已经实现并测试 v2 的 Canonical Model、SQLite WAL 状态、Factory Control Sentinel、10 个独立 one-shot EOA、动态税率十档入场、WETH quoted buy、7 天 scope-bound 授权、same-raw 广播与 UNKNOWN 恢复、双阶段退出与 5%/20% 分离滑点、readiness、只读 Dashboard、告警、systemd 模板和发布边界。

当前状态是 `IMPLEMENTED_FINAL_GATE_PENDING / PRODUCTION_NOT_DEPLOYED / NOT_HOT_ARMED`，不是“已成交”。2026-08-20 的主网证据已取代“最终 Factory/ABI 未发布”这一旧 blocker：ClockIn 当前主路是已验证的 WETH quoted pad，热路为精确 pad + approved creator 的 `LaunchCreated(id, token, creator, externalToken)` 识别 CA，再等待同 `id` 的 `LaunchArmed`，然后按链上 `getLaunch/currentTaxBps/quoteBuy` 的当前值构造 `buy(id, quoteIn, minTokensOut, ref)`。X/官网不参与热路，只做异步确认或 CA 冲突告警。“已实现 + targeted tests”不代表本次 clean-tree 全量门禁或 release readback 已完成。

本地已完成 quoted adapter、Created→Armed discovery、exact-metadata public handoff、reorg replacement、动态税率/报价、WETH readiness/preparation、restart recovery 与真实执行器代码及测试。但这些还没有部署到 `47.251.28.201`；线上仍只有无私钥 Control `enabled/active`，Executor/Reconciler/Exit `disabled/inactive`，两个 marker absent，所以线上当前知道 CA 也不会买。10 个钱包最新回读均为 `0 WETH / 0 allowance`，尚未执行 wrap/approve；每个仍有 `0.0032 ETH`，但“ETH 足够支付准备金与 Gas”不等于“WETH 已就绪”。最终 artifact 必须重新生成与其 hash 绑定的 immutable profile 和 7 天 authorization。

当前 quoted 执行将 10 个 lane 按实读的初始税率到 `deadline-1` 最后可成交 floor 生成十档，每档名义最多 5U WETH。当前默认 `3300/100/1980` 的 floor 是 1%，但更长窗口可以在 deadline 前出现 0%，非整除 decay 也合法。每 lane exact raw 由 `LaunchArmed.quoteUsd8` 换算并向下取整；Coinbase/Kraken 只服务于准备期交叉定价，不在 CA→签名热路。准备期使用 10% WETH buffer，并在准备前和 Armed 后分别执行 60U all-in gate；执行器从不把 buffer 当成可花 principal。当前主路只需 WETH principal + native ETH Gas，不需准备 STONK。

公共侧以 `<=2,000` block chunk 持久化 cursor，只有追平 confirmed head 才允许启用 paid path；仅 canonical ACTIVE pointer 写 `active.signal`，tombstone 不唤醒付费服务。Created 后 15 分钟未 Armed 只会让 paid Executor 停止消耗，公共侧仍监控同 id 晚到 Armed 并重新触发。每次本地签名紧前重新校验 marker、canonical handoff/block、quote freshness 与 authorized base-fee ceiling；只有能证明广播从未发生的 crash gap 才可释放 nonce/预算，其他情况只许 same-raw reconciliation。

## 证据边界

- 代码、fixture 和本地测试只能证明实现行为，不能证明当前主网协议身份或交易结果。
- transport `accepted`、txHash 或 RPC 配置不能替代 canonical receipt、token/quote balance delta 和 `EffectRecord`。
- launch 前 `ENTRY_HOT_ARMED` receipt 只证明 entry 观测/唤醒/签名/资金准备就绪；真实成交另需 launch 后 `CANONICAL_ENTRY_EFFECT_CONFIRMED`。
- 已冻结的 quoted pad/creator/event/getter/buy 证据可用于本地 profile；任何新合约、代码漂移或未知 route 仍不得由 testnet/demo 推导。
- 只有第一笔 5U 可接受“Factory 证明 + 非空实读 code”；这个例外不授权余下 45U。
- 当前 generic Exit 对 quoted profile 是 `UNSUPPORTED`；这不阻塞已接受风险的 entry，但绝不能宣称自动退出已武装。
- v0 单钱包入口仅保留作审计/回放兼容，不属于默认构建导出或 release artifact。
- 仓库不包含私钥、助记词、钱包备份、带凭证 RPC、资金授权或 signed raw transaction。

当前事实和解锁条件见 [2026-08-20 CLOCKIN quoted hot path evidence](docs/evidence/2026-08-20-clockin-quoted-hotpath.md)，机器可读状态见 [capability manifest](clockin-sniper/capability-manifest.json)。

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
