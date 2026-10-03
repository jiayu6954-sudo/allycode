# AllyCode alpha.22 架构与代码入口

本文描述当前代码入口。平台愿景、未接通模块与未验收能力不视为已落地功能。

```text
Electron 桌面 / Ink 终端 / CLI
        ↓
Agent loop → 模型适配与协议续接
        ↓
权限与工具注册 → 文件 / Shell / Git / 联网 / 浏览器 / 桌面 / 办公 / 视觉
        ↓
计划、检查点、任务事件、产物验证、系统回执
```

## 主要目录

| 目录 | 职责 |
|---|---|
| `src/agent` | 模型与工具循环、历史预算与压缩、计划、完成门禁、系统提示 |
| `src/providers` | 流式协议、模型目录、实时兼容性探测与用量 |
| `src/tools` | 原生工具、路径边界、Word/Excel/OCR/浏览器/桌面实现 |
| `src/storage` | SQLite 任务、事件、检查点和工作区快照 |
| `src/memory` | 任务记忆、会话、嵌入及语义检索模块（后两者不代表已接入主循环） |
| `src/permissions`、`src/sandbox` | 工具授权与可选 Docker 执行 |
| `src/mcp`、`src/skills`、`src/plugins`、`src/engines` | 协议连接、工作流和执行扩展 |
| `src/observability`、`src/evals` | 本地检测、回放与评测工具 |
| `src/accounts` | 独立部署的邮箱验证码账号服务 |
| `desktop` | Electron 主进程、凭据保护、IPC、任务编排及 React UI |
| `skill/sources-to-excel-complete/sources-to-excel` | 办公/数据处理 Python 脚本、接口与工作流 |
| `deploy/accounts` | Docker、Compose、HTTPS 反向代理部署样例 |
| `test` | 自动化测试与脱敏/合成夹具 |

## 协议与恢复

模型返回的工具调用及对应工具结果需组成完整事务才能成为恢复依据。私有 provider continuation 用于协议续接，不作为可见思考文本，也不能跨供应商直接转发。上下文压缩保留摘要和必要执行状态；完整事件与任务检查点用于追溯，不意味着任意长任务永不遗忘或失败。

## 办公执行链

资料扫描和确定性读取 → 模型理解并设计字段/报告 → 必要时 OCR/视觉 → 生成文件 → 公式重算/结构与来源校验 → 验收回执。对识别、业务语义、排版及工程执行分别说明证据，避免用一次测试退出码证明所有内容正确。

## 权限与隔离

专用文件工具做工作区路径与符号链接边界检查。用户批准的宿主 Shell、插件、MCP 或钩子仍受操作系统账号权限约束。Docker 默认不回退宿主；严格模式禁止联网。桌面 renderer 使用隔离 IPC，凭据不直接发给页面。

账号服务是可选独立服务，不承载本地模型推理、项目文件同步或企业 RBAC。部署方法见 [账号服务](ACCOUNT_SERVICE.md)。
