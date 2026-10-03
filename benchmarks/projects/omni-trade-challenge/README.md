# OmniTrade 工业级 Agent 挑战

这是 AllyCode Alpha.9 的高难度本地工程挑战。目标不是修复一个预制缺陷，而是让 Agent 根据需求、契约和黑盒验收，从零交付一个可运行的全渠道电商自动化系统。

项目初始只包含需求和不可修改的 `.challenge/` 验收工具，不包含业务实现。被测 Agent 需要自行设计并创建前端、后端、领域逻辑、持久化、网络适配器、钩子、异步作业和测试。

## 被测能力

- 从长需求中建立可恢复计划并持续更新；
- 前端、后端、数据、网络与测试的跨层实现；
- 商品同步、定价、库存、订单、支付、物流、客服、回访完整闭环；
- 外部 API 重试、超时、熔断、ETag、Webhook 签名与幂等；
- Outbox/作业、领域钩子、审计和失败恢复；
- 业务缓存命中率和 Provider 上报的模型缓存观测；
- 用真实工具和测试证据完成任务，而不是只生成说明文档。

## 开始测试

1. 在 AllyCode 中新建任务并选择本目录。
2. 将 [`ALLYCODE_TASK_PROMPT.md`](ALLYCODE_TASK_PROMPT.md) 全文发送给 AllyCode。
3. 执行期间打开左侧“Agent 检测台”。
4. AllyCode 完成后，在本目录运行：

```powershell
node .challenge/run-all.mjs
```

也可以运行 `npm test`，但最终以直接运行上述固定验收器为准。

## 重要边界

- 不得修改 `.challenge/`、`REQUIREMENTS.md`、`API_CONTRACT.md` 或 `EVALUATION.md`；
- 可以修改 `package.json` 中 `start:test`，让它同时启动 API 和 Web；
- 默认测试端口：API `4300`、Web `4173`、外部模拟服务 `4400`；
- 验收器不需要真实支付、物流或供应商账户，不会产生真实交易；
- 本挑战的 100 分是项目验收分，不是国际通用 Agent 排名。

## 缓存说明

黑盒测试会预热商品查询并要求业务缓存命中率达到 80% 以上，同时验证供应商 ETag 条件请求。模型上下文缓存属于 DeepSeek/Provider 传输层，只能在 AllyCode 的 Agent 检测台查看 Provider 实际上报的 `cacheReadTokens`。它受模型、端点、提示前缀、会话连续性和供应商策略影响，挑战项目不能伪造或保证固定比例。
