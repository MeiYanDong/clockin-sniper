# ClockIn Robinhood Mainnet LIVE Sniper

这是 Robinhood Chain 主网（chain ID `4663`）的 Factory-first 真实资金执行器。`npm run live` 没有 Shadow、dry-run 或模拟分支：配置完成并捕获到满足身份策略的正式 launch 后，第一笔交易会真实签名和广播。

截至 2026-08-15，代码与测试已完成，但 ClockIn/StonkBrokers 仍未在公开地址表发布最终主网 Launcher Factory、creator 和 ClockIn CA；当前官方 Launcher 页面也仍标记 `Coming soon`。因此仓库不会写死 rehearsal Factory，不具备当前已启动、已广播或已成交的证据。

官方当前公开预览同时描述的是另一套 `99 分钟 / 99%` Safe Launch。这个执行器只授权已讨论的 ClockIn `≤40%`、约 2 分钟画像：若最终 pool 初始费高于 `4000 bps`，或捕获时已经超过本策略有效期，preflight 会停止，不会把两套机制混用。

## 当前策略

- 10 批，每批名义 `5U`，总名义 `50U`。
- 发现模式：精确 Factory `TokenLaunched` 日志，不扫描全链同名 token。
- 名称与 symbol 只在已经通过 Factory 地址和 runtime code hash 的事件里过滤。
- 第一次有效事件原子冻结 `launchTx / creator / token CA / pool CA / block / logIndex`，后来的同名事件不能覆盖。
- Factory 身份只授权第 1 笔 `5U`；第 2–10 笔必须由官方 CA 文件、官网字段或预填官方 CA 与冻结 CA 完全匹配后解锁。
- 池子实际 `currentFeeBps()` 是费率真值。默认风险边界允许最高 `4000 bps`，计划终点为 `100 bps` 基础费；token 自身的 transfer tax 与 Launch Pool 交易费不能混称。
- 读取实际 `buyCooldownSecs()` 并强制单钱包间隔。cooldown 从上一笔 canonical receipt 确认 token 到账后重新计时，避免把 launch 时间误当成首次成交时间。若为 20 秒，10 笔需要约 180 秒加首笔 inclusion/receipt 余量，执行 deadline 为 200 秒，而不是错误地强塞进 120 秒。
- 每个新区块最多推进一批；第 `N+1` 批必须依次满足第 `N` 批 token 到账成功、随后 cooldown 已过。
- Pool 规定最早合法外部买入为 launch block 的下一块；执行器在收到已挖出的 launch 日志后立即预置首笔，并记录当时 head，不能把“已广播”误报为“保证进入 N+1”。

## 实盘闭环

```text
prewarm wallet / nonce / funds / gas / Factory code hash
  → WSS subscribe exact Factory + TokenLaunched topic
  → subscribe-before-backfill closes startup/disconnect gaps
  → name/symbol + optional creator/metadata + vanity suffix
  → freeze token CA and pool CA
  → read pool fee/cooldown/EOA window/quote asset at launch block
  → require native-ETH quote and build buy(minTokensOut, refCode)
  → sign nonce N only
  → immediately fan out the exact same tranche 1 bytes to the official
     write-only Sequencer plus configured production RPCs
     (earliest legal inclusion is launch block + 1)
  → sign nonce N+1...N+9 off the hot path
  → official CA match unlocks tranches 2...10
  → each next tranche waits for previous token-delivery receipt, then cooldown
  → receipt/event/balance reconciliation
```

Factory WSS 是当前可验证的生产发现通道。Robinhood 官方 Sequencer Feed 是 Nitro node feed；官方尚未发布适合本执行器直接解析的稳定应用层 transaction JSON schema，所以代码没有伪造一个 decoder。写入侧则已接入官方 `https://sequencer.mainnet.chain.robinhood.com`：启动时用无效空 payload 探测 `eth_sendRawTransaction`，真实执行时把同一份签名 bytes 与生产 RPC 并行发送。若直连探测暂时失败，会记录降级并继续使用已验证的标准 RPC，不会因此退出等待。未来接入 Feed 时只替换 discovery adapter，不改变身份冻结、nonce、same-raw 和 receipt 真值循环。

## 协议绑定

当前前端公开 bundle 暴露的核心 ABI 为：

```solidity
event TokenLaunched(
  address indexed creator,
  address indexed memeToken,
  address indexed pool,
  string name,
  string symbol,
  string metadataURI,
  bytes32 imageHash
);

function buy(uint256 minTokensOut, bytes32 refCode)
  payable returns (uint256 tokensOut);
function currentFeeBps() view returns (uint16);
function inSniperWindow() view returns (bool);
function buyCooldownSecs() view returns (uint32);
function eoaOnlySecs() view returns (uint32);
function windowMaxBuyBps() view returns (uint16);
function currentWindowCap() view returns (uint256);
function quoteAsset() view returns (address);
```

启动时仍必须用最终 Factory code hash 绑定这套 ABI。若最终 pool 使用 ERC-20 quote，执行器会停止，因为当前 live adapter 只实现 native-ETH payable `buy`，不会把 `buyWithQuote` 猜成同一路径。

`CLOCKIN_MIN_TOKENS_OUT_RAW=1` 是 5U 小额、速度优先画像的最小非零输出，并不是完整价格保护。最大本金暴露由每批 5U 和 sequential receipt gate 限制；若上线前能从 launch parameters 推导稳定的首块价格，应提高该值。

## 生产配置

真实配置不再放在项目目录。复制 [live.env.example](live.env.example) 到项目外的
`~/.Codex/secrets/clockin-sniper/live.env` 并填写；目录权限设为 `0700`，文件权限设为
`0600`。服务器通过 `CLOCKIN_ENV_FILE=/etc/clockin-sniper/live.env` 指向独立的
systemd `EnvironmentFile`；`CLOCKIN_PRIVATE_KEY_FILE` 再指向独立的 mode-`0600`
signer 文件或 systemd credential，不要把 secrets 复制进代码部署目录。

- Chainstack/其他生产 HTTP 与 WSS，只保存在本机环境文件；
- Robinhood 官方 direct Sequencer 默认开启，可在环境变量中显式留空关闭；
- 专用钱包私钥和预期 signer 地址；
- 最终 Factory 地址与 runtime code hash；
- 实际 `5U` 对应的 native wei；
- gas limit 与 EIP-1559 费用上界；
- 可选官方 creator、metadata 绑定；
- 官方 CA 文件或官网字段来源。

不要把私钥、RPC 凭证、完整 signed raw transaction 写进日志或仓库。`.gitignore`
只是第二道防线；`npm run verify` 会先运行仓库 secret 检查，项目目录内出现真实
ClockIn 私钥、钱包备份或带凭证的 Chainstack URL 时直接失败。账本只记录交易哈希、
nonce、payload hash、receipt 与资产变化，文件权限强制为 `0600`。

## 命令

```bash
npm install
npm run verify
npm run smoke:rpc
npm run smoke:wss
npm run smoke:sequencer
npm run live
npm run live:reconcile
```

- `smoke:rpc` / `smoke:wss`：只读验证主网传输，不读取私钥、不签名、不广播。
- `smoke:sequencer`：向官方写入端发送无效空 payload，必须得到确定性解析拒绝；不读取私钥，也不生成或发送有效交易。
- `npm run live`：Factory-first 实盘入口；`CLOCKIN_LIVE=true` 后没有二次确认。
- `npm run live:known-target`：保留的已知 CA/Pool 兼容入口，不是首发推荐路径。
- `npm run live:reconcile`：只恢复账本里已经尝试广播的交易，不读取私钥、不补发新 nonce。

## 已实现与未证明

已经通过本地测试：Factory 精确日志订阅、启动边界补扫、事件 ABI、身份过滤、code-hash 漂移阻断、动态 pool 状态、官方 CA 双门、20 秒 cooldown 调度、分阶段动态签名、官方直连 Sequencer 探测、same-raw fanout、UNKNOWN 重播、上一批 receipt gate、token 到账核账、钱包锁与崩溃恢复。

尚未证明：最终 Factory/creator/CA、最终 ClockIn pool 参数、真实 5U→wei 换算、生产机器到 Sequencer 的延迟、真实交易 receipt、可卖出路径与正期望。买入后会把实际 token 余额记为残余 Position，但自动卖出明确为 `unsupported`；代码存在和测试通过不等于已成交。

官方参考：[ClockIn 官方 X](https://x.com/clockincoin)、[StonkBrokers Launcher](https://www.stonkbrokers.cash/launcher)、[StonkBrokers 文档](https://www.stonkbrokers.cash/docs)、[Robinhood Chain](https://docs.robinhood.com/chain/)、[连接说明](https://docs.robinhood.com/chain/connecting/)。
