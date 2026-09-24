# Kairos：从“0 访问的研究台”到“AI agent 愿意付费的下单前检查”

## 1. 为什么现在是 0 访问

1. **头条永远是 0。** 首页只回答一个问题：“现在有没有扣费后的套利？”答案几乎每次都是 0。一个永远不变的数字不带任何信息，所以没人会回来看，你自己也不会。
2. **问题本身卖不出去。** 真正能成交的套利会在毫秒级被机器人吃掉，每天两次的静态快照不可能交付它。“有没有边”这个产品，在这个更新频率下注定是 0。
3. **有价值的东西藏在“回执”里。** 研究台真正会、而别人不会的，是三件“下单前”的事实：
   - 每个市场的**真实费率**：`feeSchedule.rate`，p(1−p) 形状，只收 taker。很多 bot 仍然按 0 费率算。
   - **哪些 NegRisk 组是假套利**：Person-*/Other 占位腿买不到，加总看起来 < $1，其实是缺腿。
   - 跨市场**合约口径是否一致**：Polymarket 对 CME FedWatch。
   这些信息变化慢，一天更新几次完全够用，正好配得上现在的节奏。
4. **agent 找不到、也读不懂。** 没有 llms.txt，没有 OpenAPI，JSON 是写给人看的叙事字段，也没有付费入口。另外 GoatCounter 只统计浏览器里跑 JS 的访问，agent 拉 JSON 本来就不会被计数。所以“0 访问”里，一部分只是看不见。

## 2. 定位：给预测型 agent 用的“下单前检查”

目标用户是在 Polymarket 上做预测、做交易的 AI agent。它们手里已经有一个概率 p，缺的是这一句：

> **我的 p 要高过多少，买 YES 才是扣完手续费、价差、滑点之后的正期望？**

对每个市场、每个规模（1 股、$100、$1,000）给出：

- `buy_yes_if_p_above`：在该规模按卖盘吃单，均价加 taker 费，就是买 YES 的盈亏平衡概率
- `buy_no_if_p_below`：买 NO 的对应阈值
- 两者之间是**不交易带**，也就是摩擦成本
- flags：`FEES_ON`、`FEE_UNKNOWN`（费率未知就不给阈值，绝不默认 0）、`THIN`、`WIDE_SPREAD`、`NEGRISK_INCOMPLETE`、`PAST_END`……

agent 为什么愿意用：自己算这一套，要调 Gamma、调 CLOB 盘口、搞清楚费率字段、处理 NegRisk 占位腿，每次都容易算错。这里一个查询就能得到答案，而且算法开源、可复核。

## 3. 免费和付费怎么分

| | 免费（GitHub Pages 静态 JSON） | 付费（Cloudflare Worker，x402 按次付费） |
|---|---|---|
| 新鲜度 | 约每 2 小时重建 | 实时拉盘口 |
| 规模 | 固定：1 股 / $100 / $1,000 | 任意 `usd`，最高 $100k |
| 覆盖 | 24h 成交量前约 300 个事件 | 任意市场、任意事件 |
| 内容 | markets / sets / changes | `/v1/quote`、`/v1/set` |
| 价格 | 0 | $0.01 / $0.02 每次（USDC） |

**为什么用 x402，不用订阅：** agent 没法注册账号、填信用卡。x402 是 HTTP 402 加 USDC 的按次付费协议，带钱包的 agent 遇到 402 会自动付款后重试，不需要 API key。同时通过 Bazaar 扩展把服务登记到 facilitator 的目录里，agent 可以按关键词搜到它。等以后有稳定的人类或机构用户，再加月度 key（Stripe）也不晚。

免费层负责被发现、建立信任；付费层卖的是“实时 + 你的规模”。这两样免费层在结构上给不了。

## 4. 这次已经实施的

- `lib/pretrade.mjs`：核心算法（费用、吃单、阈值、NegRisk 审计、flags）。纯函数，零依赖，免费 feed 和付费 API 共用同一份代码。
- `scripts/build-feed.mjs`：拉 Polymarket 公开接口，生成 `docs/v1/{index,markets,sets,changes}.json`。
- `test/`：12 个测试，用的是 desk.json 里的真实数字。民主党提名组的净成本算出来是 0.9604，和你私有引擎回执里的 0.96036 一致。
- `.github/workflows/pages.yml`：每 2 小时，以及每次你的 Mac 推送时，重建 feed 并部署 Pages。**不写回 main**，所以不会和 Mac 上的 routine 抢推送。Mac 宕机时 feed 照样更新。构建失败会回退到上一版 feed。
- `worker/`：付费实时 API（Hono + `@x402/hono`）。本地验证过：未付款返回 402 和付款说明，没配收款地址时返回 503（不会误免费）。
- `docs/index.html`：首页改成“你要赢过的概率是多少”，有市场查询表、假套利列表、变动列表、给 agent 的接入说明。原来的研究台回执（Fed 口径缺口、冻盘记分卡）保留在下方，作为可信度背书。
- `docs/llms.txt`、`docs/openapi.json`：让 agent 和 LLM 工具能自动读懂接口。

## 5. 需要你做的（我在这个环境里做不了）

1. **GitHub → Settings → Pages → Source 改成 “GitHub Actions”。** 不改的话，新的 feed 不会上线。
2. 部署付费 API（大约 10 分钟）：按 `worker/README.md` 操作，先在 Base Sepolia 测试网跑通，再切主网。部署后在仓库 Settings → Variables 里加 `PAID_API_BASE`，首页和 index.json 会自动显示付费入口。
3. 分发。有用只是前提，没人知道就还是 0：
   - 把 x402 服务登记到 Bazaar（部署后第一次成功结算会自动登记），也可以提交到 x402 生态列表
   - 在 X 上每天发一条“今天的假套利 / 费率陷阱”，附 sets.json 链接。这是现成的内容来源
   - 在 Polymarket 开发者 Discord 和 agent 框架社区（ElizaOS、Olas 等）介绍免费 feed
   - 以后做一个 MCP server（Phase 3），上架 MCP 注册表

## 6. 怎么判断有没有用（4 周）

- 第 1 周：Actions 连续成功，`fee_unknown` 接近 0（否则说明 Gamma 的费率字段名需要调整，构建日志会报警）
- 第 2–4 周：Worker 日志里的免费和付费请求数、402 转付费的比例、有没有回头客（同一个付款地址多次付费）
- 如果 4 周内没有任何付费调用：保留免费 feed 做获客，把精力转向 MCP 分发，或者把阈值数据直接卖给一两个做 Polymarket bot 的团队

## 7. 后续（未实施）

- Phase 3：MCP server（工具 `pretrade_quote`、`negrisk_audit`），上架 MCP 注册表
- 把私有引擎的 Fed 跨市场口径对齐，做成付费端点 `/v1/fed`（这是真正的独家信息差）
- 解析结算规则风险（resolution source、UMA 争议历史），做成 flag
- feed 历史归档，方便回测不交易带对 agent 盈亏的影响
