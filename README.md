# ClockIn Sniper

[![CI](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/clockin-sniper/actions/workflows/ci.yml)

Robinhood Chain（chain ID `4663`）上的 ClockIn / Stonk Launcher 生产级狙击系统。

本仓库当前包含已经测试的 Factory-first 单钱包执行器，以及向“未知 Factory 预警、10 个独立 EOA 税率分层买入、真实到账校准、内盘/外盘双路退出”演进的完整技术规格和执行清单。

## 当前证据边界

- 现有代码具备 Factory 精确事件发现、runtime code-hash 绑定、same-raw 多 RPC 广播、UNKNOWN 重播、receipt 和 token 到账核账等基础能力。
- 当前代码仍是单 EOA 连续 nonce 的 10×5U 实现；目标 10 EOA 架构、未知 Factory Control Sentinel 和自动退出尚未实现。
- 测试、配置和 RPC accepted 都不是成交证据。真实经济结果必须有 canonical receipt、资产变化、EffectRecord 和可执行退出。
- 生产执行器是实盘路径；fork/replay 只作为离线验证设施。
- 仓库不包含私钥、助记词、钱包备份、生产凭证、资金授权或真实 signed raw transaction。

## 目录

```text
docs/
  plan.md       完整产品和技术规格
  todo.md       分阶段、可勾选的小故事卡实施清单
  adr/          架构决策记录
clockin-sniper/
  src/          当前 TypeScript executor
  test/         行为测试
  README.md     当前执行器能力和生产配置说明
```

## 本地验证

要求 Node.js 24 LTS。

```bash
cd clockin-sniper
npm ci
npm run verify
```

`verify` 强制执行：

- repository secret scan；
- tracked-file public-scope scan（CI）；
- Biome format check；
- Biome lint；
- TypeScript strict typecheck；
- 70+ tests 和覆盖率门槛；
- production dependency audit；
- npm package contents audit。

当前最低覆盖率门槛：line 85%、branch 60%、function 80%。2026-08-16 质量基线为 line 87.41%、branch 65.69%、function 88.61%。

## 开发方法

- 功能按 [todo.md](docs/todo.md) 的小故事卡拆分；
- 每个故事卡包含实现、失败路径、测试、文档和验收证据；
- 使用 Conventional Commits；
- PR 合并前必须通过 CI；
- 架构变化必须新增或更新 ADR；
- 发布标签自动生成经过验证的 npm artifact 和 checksum；
- 实盘云部署必须使用受保护环境和仓库外 credentials，不由普通 CI 自动启动。

详细规范见 [plan.md](docs/plan.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告方式见 [SECURITY.md](SECURITY.md)。

## 许可

当前尚未选择开源许可证。仓库公开可见不代表授予复制、修改或再分发许可；许可证选择列在实施清单中等待项目所有者决定。
