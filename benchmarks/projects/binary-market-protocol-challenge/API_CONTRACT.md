# 本地验收接口合同

测试环境固定：API `http://127.0.0.1:4310`，Web `http://127.0.0.1:4174`，`ORACLE_SECRET=challenge-oracle-secret`，`NETWORK_MODE=local_only`。JSON 字段可额外扩展，但下列字段和语义不可缺失。

## 基础与市场

- `GET /health` → `200 { status:"ok", mode:"local_only", dependencies:{...} }`
- `POST /api/markets`，请求头 `Idempotency-Key`，正文 `{slug,question,closesAt,creator,volumeThreshold,creatorBonusBps}` → `200/201`，返回 `{id,status:"open",yesPriceBps,noPriceBps,totalVolume}`
- `GET /api/markets/:id` → 市场、资金池、成交量、结算和价格视图
- `GET /api/markets` → `{items:[...]}`

建市必须拒绝过去的关闭时间、空问题、非法阈值/奖励费率。重复相同键和相同载荷返回同一市场；相同键不同载荷返回 `409`。

## 流动性与交易

- `POST /api/markets/:id/liquidity`，`Idempotency-Key`，正文 `{provider,amount}`
- `POST /api/markets/:id/trades`，`Idempotency-Key`，正文 `{trader,outcome:"YES"|"NO",side:"buy"|"sell",shares,maxCost?,minProceeds?}`
- `GET /api/portfolios/:owner` → `{owner,positions:[...],claimable,...}`

所有数值是安全整数。买入返回服务端计算的 `cost`，卖出返回 `proceeds`；必须拒绝滑点越界、余额不足、超卖、非法枚举和关闭后的交易。重复相同交易不得再次改变余额或成交量。

## 预言机与领取

- `POST /api/markets/:id/resolve`，请求头 `x-oracle-event-id`、`x-oracle-signature`，正文原始 JSON `{outcome:"YES"|"NO",resolvedAt}`
- 签名：`hex(HMAC-SHA256(ORACLE_SECRET, rawBody))`
- 无效签名返回 `401/403` 且无副作用；重复事件幂等；不同结果二次结算返回冲突；
- `POST /api/markets/:id/claims`，`Idempotency-Key`，正文 `{owner}` → `{owner,amount,status:"paid"}`；败方/无持仓不可领取，同一账户不可重复支付。

## 事件、指标与前端

- `GET /api/events?marketId=...` → `{items:[{id,sequence,type,marketId,occurredAt,payload}]}`，sequence 严格递增；
- 事件类型至少覆盖 `market.created`、`liquidity.deposited`、`trade.executed`、`market.resolved`、`claim.paid`，满足条件时含 `creator_bonus.unlocked`；
- `GET /api/metrics` → `{cache:{hits,misses,hitRate},idempotency:{replays,conflicts},oracle:{replays,rejected},events:{published}}`；
- Web 路由：`/`、`/markets`、`/portfolio`、`/activity`、`/risk`，每个路由均返回有效非空页面。
