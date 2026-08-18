# ClockIn Sniper

[![CI](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml)

Robinhood Chain (`chainId=4663`) 上的 ClockIn / Stonk Launcher 生产架构实现。

仓库已经实现并测试 v2 的 Canonical Model、SQLite WAL 状态、Known/Unknown Factory Control Sentinel、10 个独立 one-shot EOA、40%→floor 十档入场、1U–5U cap 缩量、canary 校准、7 天 scope-bound 授权、same-raw 广播与 UNKNOWN 恢复、双阶段退出与 5%/20% 分离滑点、readiness、只读 Dashboard、告警、systemd 模板和发布边界。

当前状态是 `DEPLOYED_PUBLIC_CONTROL_HARDENED / STATIC_EXECUTION_PREREQUISITES_STAGED / NOT_HOT_ARMED`，不是“已成交”。`47.251.28.201` 上只有无私钥 Control `enabled/active`，其唯一链 transport 是 Robinhood 官方公共 HTTP RPC；进程没有 RPC credential、Chainstack 环境变量或 systemd credential mount。semantic 官网信号与 foreground/background 公共 RPC 调度已部署，最近一次公共回读确认 10/10 钱包 funding/nonce readiness。Executor/Reconciler/Exit 全部 `disabled/inactive`；vault key 与官方 Sequencer credential 已按 root-only 边界准备，但 `PAID_RPC_APPROVED` 与 `PRODUCTION_ARM_APPROVED` 均不存在。官方仍未公开最终主网 Launcher Factory、ClockIn CA 和最终 buy/sell/finalize ABI，因此默认 `npm run live` 继续只输出 blocker 并以非零状态失败关闭，不读取私钥、不签名、不广播。部署与武装审计见 [2026-08-18 Control hardening and arming audit](docs/receipts/2026-08-18-control-hardening-and-arming-audit.md)。

## 证据边界

- 代码、fixture 和本地测试只能证明实现行为，不能证明当前主网协议身份或交易结果。
- transport `accepted`、txHash 或 RPC 配置不能替代 canonical receipt、token/quote balance delta 和 `EffectRecord`。
- 最终主网合约未发布前，不猜 selector、不把 testnet/demo 地址升级成生产授权。
- v0 单钱包入口仅保留作审计/回放兼容，不属于默认构建导出或 release artifact。
- 仓库不包含私钥、助记词、钱包备份、带凭证 RPC、资金授权或 signed raw transaction。

当前事实和解锁条件见 [Launcher mainnet evidence](docs/evidence/2026-08-16-launcher-mainnet-status.md)，机器可读状态见 [capability manifest](clockin-sniper/capability-manifest.json)。

## 质量基线

要求 Node.js 24 LTS：

```bash
cd clockin-sniper
npm ci
npm run verify
```

2026-08-18 本地证据：242/242 tests；最近一次完整 verify 为 line `89.01%`、branch `68.83%`、function `92.05%`。CI 强制最低 line 85%、branch 60%、function 80%，并执行格式、lint、strict typecheck、仓库与 Git 历史 secret scan、production dependency audit 和 package audit。

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
