# ClockIn Sniper

[![CI](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml)

Robinhood Chain (`chainId=4663`) 上的 ClockIn / Stonk Launcher 生产架构实现。

仓库已经实现并测试 Canonical Model、SQLite WAL 状态、Factory Control Sentinel、10 个独立 one-shot EOA、WETH quoted buy、7 天 scope-bound 授权、same-raw 广播与 UNKNOWN 恢复、readiness、只读 Dashboard、告警、systemd 模板和发布边界。最新 creator-first v3 策略把已验证 Factory + approved creator 作为唯一身份热键，名称、symbol、X 与网站只做异步审计。

当前生产状态是 `EXPIRED_LAUNCH_AUTH_REVOKED / MISSED_ZERO_BUY / QUOTED_EXIT_UNSUPPORTED`。2026-08-20 的官方 CLOCKIN 已上链：WETH launch id `39`，CA `0xA5bE…666666`，creator 为已冻结的 `0x5eB8…8e06`。真实 name 是 `CLOCK IN`；旧 Control 在 exact pad + creator 命中后又用 `Clock In` 做大小写敏感 veto，导致 handoff 为空。10 个钱包 nonce 均未增加、CLOCKIN 余额均为 0，因此没有任何真实买入。

commit `9014c45df1370112803110b64e683caab65d9ac4` 的 revision-17 artifact 是事故时的历史部署，不包含 creator-first 修复。机会结束后，paid path 已停用，Executor/Reconciler/Exit 已停止，两个 marker 已撤销并 root-only 可恢复归档。历史准备回执仍保留，但不代表当前钱包 readiness 或新策略授权。

新策略在 canonical `LaunchCreated` 后只等同 id `LaunchArmed`和第一个当前税率 `<=50%` 的可买 block。届时 10 个独立 EOA 各以精确 5U WETH principal 并发，总本金仍为 50U、all-in 仍为 60U。十笔都必须有当前同块 `quoteBuy` 和有界 `minTokensOut`；不再使用 lane-1 `minOut=1`，不等 canary receipt，也不超额补买。`startTaxBps` 可高于 50%，但只能在当前税降到 50% 以内时签名。

新修复当前只有本地测试证据，尚未产生新 immutable artifact，也没有任何新主网 launch 授权。部署时只允许更新 keyless Control 与 disabled paid units；不得恢复旧 marker，不得把旧 `ENTRY_HOT_ARMED` 回执继承到 v3。下一次实盘必须新 profile/auth/marker/readiness 回执，并先归档或隔离已消耗 launch 的 stale handoff pointer。

## 证据边界

- 代码、fixture 和本地测试只能证明实现行为，不能证明当前主网协议身份或交易结果。
- transport `accepted`、txHash 或 RPC 配置不能替代 canonical receipt、token/quote balance delta 和 `EffectRecord`。
- 历史 `ENTRY_HOT_ARMED` receipt 只证明事故前的部署/准备快照；它已过期且授权已撤销，不能证明现在已武装。
- 已冻结的 quoted pad/creator/event/getter/buy 证据可用于本地 profile；任何新合约、代码漂移或未知 route 仍不得由 testnet/demo 推导。
- creator-first v3 只在 exact Factory + approved creator + canonical primary event 命中后授权 10×5U；名称、symbol、X 或网站不能独立授权，也不能反向 veto。
- 当前 generic Exit 对 quoted profile 是 `UNSUPPORTED`；这不阻塞已接受风险的 entry，但绝不能宣称自动退出已武装。
- v0 单钱包入口仅保留作审计/回放兼容，不属于默认构建导出或 release artifact。
- 仓库不包含私钥、助记词、钱包备份、带凭证 RPC、资金授权或 signed raw transaction。

当前实现证据见 [2026-08-20 CLOCKIN quoted hot path evidence](docs/evidence/2026-08-20-clockin-quoted-hotpath.md)，真实漏单与撤销边界见 [2026-08-20 missed-launch postmortem](docs/receipts/2026-08-20-clockin-missed-launch-postmortem.md)，机器可读状态见 [capability manifest](clockin-sniper/capability-manifest.json)。

## 质量基线

要求 Node.js 24 LTS：

```bash
cd clockin-sniper
npm ci
npm run verify
```

2026-08-20 当前本地功能测试为 393/393；core coverage 为 line `89.28%`、branch `68.90%`、function `88.93%`，五个生产入口另设防回退门（line `34.38%`、branch `70.89%`、function `68.82%`）。CI 还执行格式、lint、strict typecheck、仓库与 Git 历史 secret scan、production dependency audit 和 package audit。

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
