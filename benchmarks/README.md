# AllyCode Provider/Agent 基准

这是 Alpha.9 的可复跑兼容性门槛，用真实 API 响应回答“这个模型在 AllyCode 当前传输层上是否真正可用”。它不会用模型名称猜能力，也不会在 API 不可用时生成推测分数。

当前套件覆盖：

- 基础流式对话与精确指令遵循；
- 原生结构化工具调用；
- 工具结果返回后的第二轮续接（包括需要保留的思考/响应状态）；
- 一个受控的“虚假执行声明”哨兵；
- 每次调用的总延迟、首个流事件延迟；
- 输入、输出、缓存读取和缓存创建 token（以 Provider 实际上报为准）。

## 运行

基准会产生真实 API 调用和费用。密钥只应通过标准环境变量传入，不要写入 suite、命令行参数或报告。

PowerShell 示例（DeepSeek V4 Pro）：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
npm run benchmark:provider -- --provider deepseek --model deepseek-v4-pro --protocol chat_completions --output .benchmark-results/deepseek-v4-pro.json
Remove-Item Env:DEEPSEEK_API_KEY
```

OpenAI Responses API 示例：

```powershell
$env:OPENAI_API_KEY = "你的密钥"
npm run benchmark:provider -- --provider openai --model "你的模型ID" --protocol responses --output .benchmark-results/openai-responses.json
Remove-Item Env:OPENAI_API_KEY
```

本地 Ollama 示例：

```powershell
npm run benchmark:provider -- --provider ollama --model "本地模型名称" --output .benchmark-results/local.json
```

查看全部参数且不发起请求：

```powershell
npm run benchmark:provider -- --help
```

桌面端的 API 密钥保存在 Electron 安全密钥库中。独立 Node 基准脚本刻意不绕过系统去解密它；运行基准时请为当前终端临时设置对应环境变量：

| Provider | 环境变量 |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Qwen / DashScope | `DASHSCOPE_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |

缺少密钥、模型不存在、协议不兼容或网络失败时，命令会清楚退出且不产生成绩：配置问题退出码为 `2`；基准实际运行但必测项未通过时退出码为 `1`；所有必测项通过时退出码为 `0`。

## 结果解释

JSON 报告包含运行配置（不含密钥）、逐调用延迟、截断后的模型文本、工具调用参数、usage、逐项证据和限制说明。`suitePassRate` 的分母只包括 `required: true` 的合成用例。

`agentReadyForThisSuite: true` 只说明模型通过当前 Alpha.9 的核心协议门槛，不代表：

- 通过 SWE-bench、Terminal-Bench、τ-bench 或任何外部排行榜；
- 能稳定处理真实大型仓库、百万 token 上下文或长时间自主任务；
- 获得了通用“幻觉率”结论；
- 本地硬件速度、显存和量化精度已经满足生产要求。

缓存用例是信息型用例。`not_observed_or_unreported` 可能表示未命中、提示长度未达到供应商门槛，或 API 根本未上报缓存明细；框架不会把零值包装成“已支持缓存”。

做模型对比时，应固定 suite、协议、reasoning 设置和网络环境，至少独立运行三次，并基于原始 JSON 计算中位数/置信区间。不要只选最好的一次结果。

## 套件与安全边界

默认套件位于 [`suites/alpha9-agent-core.json`](./suites/alpha9-agent-core.json)。所有工具结果均由框架合成：它不会读取项目、运行 shell、修改文件或发起搜索。因此它验证的是“模型 + API 传输 + AllyCode 状态续接”，不是完整工具执行器。

要宣称达到外部国际基准，必须另行固定公开数据集版本、容器镜像、采样参数、预算、失败重试规则和评分器，并公开原始运行记录。Alpha.9 当前框架为这些评测提供可审计的基础协议报告，但不伪造或替代外部基准成绩。

