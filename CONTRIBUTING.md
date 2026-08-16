# Contributing

## 工作单元

每次变更先关联 [docs/todo.md](docs/todo.md) 中的一张故事卡。故事卡应当足够小，可以在一个 PR 中完成并独立验证。

一个故事卡的完成至少包括：

- 目标行为和失败行为；
- 生产代码；
- 有意义的测试断言；
- capability/tech spec/ADR/CHANGELOG 中需要更新的部分；
- 可复现的验证命令；
- 风险与回滚方式。

不要把协议 adapter、数据库迁移、Dashboard 重做和无关格式化放进同一个 PR。

## 分支与提交

分支建议：

```text
story/060-fee-band-planner
fix/081-unknown-recovery
docs/adr-wallet-model
```

提交采用 Conventional Commits：

```text
feat(entry): add one-shot wallet lane planner
fix(reconcile): preserve reservation while receipt is unknown
test(exit): cover finalize route migration
docs(adr): record ten-EOA wallet model
ci: enforce coverage and package audit
```

提交应当：

- 使用祈使语气和明确 scope；
- 只包含当前故事卡的相关变更；
- 不使用 `update`、`changes`、`work` 等没有信息量的标题；
- 不把测试失败、临时调试或 secret 放入历史。

## 本地质量门

```bash
cd clockin-sniper
npm ci
npm run verify
```

如需自动格式化：

```bash
npm run format
```

最低覆盖率门槛：

- line ≥ 85%；
- branch ≥ 60%；
- function ≥ 80%。

门槛是最低线，不是目标。新增关键资金、身份、nonce、receipt、position 或 exit 模块应优先覆盖正常、边界和失败路径。

## PR 要求

- PR 标题使用 Conventional Commit 格式；
- 填写故事卡 ID、变更目标、风险、测试和回滚方式；
- CI 全部通过后才合并；
- 行为变化更新 CHANGELOG；
- 架构选择更新 `docs/adr/`；
- capability manifest 使用真实证据等级；
- 合并前检查 staged diff 和 package 文件清单。

## Web3 证据规则

- `accepted`、`known`、`unknown` 是 transport 状态，不是成交；
- 只有 canonical receipt、资产变化和 EffectRecord 能证明经济效果；
- fork/replay 不能描述成 live receipt；
- 配置 enabled 不能描述成服务器当前运行；
- 真实私钥、助记词、authenticated RPC、signed raw transaction 不得进入仓库、PR、Issue、日志或截图。
