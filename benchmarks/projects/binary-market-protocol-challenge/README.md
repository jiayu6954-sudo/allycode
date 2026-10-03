# Binary Market Protocol 工业级盲测

这是一个从空骨架开始的 AllyCode Agent 能力测试，不是示例项目，也没有参考实现。请先阅读全部公开文档，再把 `ALLYCODE_TASK_PROMPT.md` 原样交给 AllyCode。

测试要求交付一个可在本机运行的二元结果市场产品切片：Solana/Anchor 合约工程、确定性领域模拟器、索引/API 服务、React/TypeScript 前端、预言机结算、安全防护和自动化测试。

安全边界：仅允许本地模拟器、local validator 或 devnet；禁止主网、真钱、真实钱包私钥、下注或任何代客金融操作。外部验收器不在本工作区内，验收时由 AllyCode 桌面端调用。

快速顺序：

1. 阅读 `SOURCE.md`、`REQUIREMENTS.md`、`API_CONTRACT.md`、`EVALUATION.md`。
2. 在 AllyCode 中使用 `ALLYCODE_TASK_PROMPT.md`。
3. Agent 完成后先运行自己的测试。
4. 回到“评测实验室”，点击“运行独立验收”。
5. 在“实时检测台”导出本次 Agent 执行报告。
