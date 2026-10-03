# AllyCode

[![CI](https://github.com/jiayu6954-sudo/allycode/actions/workflows/ci.yml/badge.svg)](https://github.com/jiayu6954-sudo/allycode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

**0.11.0-alpha.22 · 本地优先的桌面与终端 AI Agent**

用自然语言描述任务，AllyCode 组织模型、计划、工具与验收证据，在所选项目目录中执行软件开发、资料整理、Word 报告及 Excel 表格任务。适合希望看清步骤、权限和产物的用户，也提供开发者可审查、修改的源码。

这是开发中的 alpha 版本，不代表完成生产安全认证、任意行业数据识别或全部操作系统验收。公开范围、测试口径与限制见 [公开版本说明](docs/PUBLIC_RELEASE.md)。

## 已开放的模块

| 模块 | 当前实现与边界 |
|---|---|
| 桌面与 CLI | Electron/React 桌面、Ink 终端、无界面 CLI；中文设置与授权说明、项目路径及历史任务 |
| Agent 与长任务 | 可见步骤清单、阶段执行、检查点续接、上下文压缩、任务预算；不保证无限自动执行 |
| 任务与记忆 | SQLite 事件、任务独立记忆、恢复记录；语义检索模块存在，但尚未接入主循环记忆入口 |
| 模型与引擎 | 多供应商协议适配、模型发现、工具续接探测；目录中的模型参数不是供应商实时承诺 |
| 工具与扩展 | 文件、Shell、Git、网页、浏览器、桌面操作、MCP、Skills、插件；权限及平台限制仍适用 |
| Word / PDF | 公文格式生成、标题空行、文档检查、Word 转 PDF、PDF 重建可编辑文字；不承诺无损版式还原 |
| Excel | 按资料设计字段与分表、来源追溯、精度保护、LibreOffice 公式重算与预期值比对；业务理解仍需复核 |
| 视觉与 OCR | 系统 OCR、Qwen3.5-9B 与 PaddleOCR-VL-1.6 下载及运行适配；模型权重不随源码发布 |
| 检测与验收 | 本地检测台、用量/缓存数据、工具结果、分类验收与系统回执；不等同业务正确性认证 |
| 可部署账号服务 | 邮箱验证码注册/登录、会话撤销、注销；需自行配置域名、邮件服务与密钥，可不登录使用本地功能 |
| 安装与组件 | Windows 打包、Ubuntu 24.04 x64 DEB/AppImage 与组件准备；其他发行版/ARM/Wayland 尚未完整验收 |

## 从源码运行

需要 Node.js **22.13+**、npm。桌面安装包自带运行时，普通用户无需自行安装 Node.js。源码构建会下载依赖；模型 API、模型权重、Python/办公组件不是开源仓库内置文件。

```sh
git clone https://github.com/jiayu6954-sudo/allycode.git
cd allycode
npm ci
npm run build
npm run desktop
```

终端使用：

```sh
npm run build:cli
node dist/index.js setup
node dist/index.js --help
```

首次打开桌面后，在“开始设置”配置自己有权使用的模型，并运行连接检查。办公/OCR 按需安装组件；完整视觉模型体积较大，无需作为所有任务的前提。邮箱服务未配置时可继续本地使用。

- Windows 本地预览包：`npm run desktop:package`（未签名预览，不等同正式签名发行）。
- Linux 安装包：`npm run desktop:linux`，见 [Linux 安装与限制](docs/LINUX_SETUP.md)。
- 账号部署：[邮箱账号服务](docs/ACCOUNT_SERVICE.md)，`npm run build:accounts`。
- 扩展办公工作流：[资料整理成 Excel Skill](skill/sources-to-excel-complete/sources-to-excel/SKILL.md)。

任务输出保存到所选项目。默认设置与任务数据位于 `~/.allycode/`，可用 `ALLYCODE_DATA_DIR` 更改。桌面凭据由操作系统密钥库保护；同一个操作系统用户的本地任务库不是企业多租户隔离。服务端账号不自动同步项目文件。

## 模型兼容性

源码包含 Anthropic、OpenAI/Responses、DeepSeek、Qwen、Groq、Gemini、OpenRouter、Moonshot/Kimi、自定义兼容端点与本地模型适配。默认模型 ID 是配置值；可用性以用户账号的发现及实际连接检查为准。协议适配不代表所有模型、工具、视觉和计量功能都经过实测。

兼容性探测会真实调用模型，可能产生费用。普通软件回归不需要付费模型 API。不要将 API 密钥提交到 GitHub。

## 开发验证

```sh
npm run typecheck
npm run typecheck:desktop
npm run lint
npm run test:run
npm run build
npm run build:accounts
npm audit --omit=dev
```

完整办公回归需要 Python 依赖与公式引擎，准备方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。现有测试结果与已知未验收范围见 [公开版本说明](docs/PUBLIC_RELEASE.md)，CI 徽章显示远端实际状态。

## 文档与开源边界

- [架构与代码入口](docs/ARCHITECTURE.md)
- [任务、记忆与平台边界](docs/AGENT_PLATFORM_ARCHITECTURE.md)
- [本地 Agent 检测台](docs/AGENT_MONITOR.md)
- [版本记录](CHANGELOG.md)、[贡献说明](CONTRIBUTING.md)、[安全说明](SECURITY.md)
- [第三方组件与再分发边界](THIRD_PARTY_NOTICES.md)

AllyCode 项目代码按 [MIT](LICENSE) 发布。依赖、模型、字体及外部服务保留各自许可和使用条件。内部工作流、真实用户项目/票据/对话、运行数据库、凭据、模型文件及本机维护脚本不在公开范围内。`OPEN_SOURCE_MANIFEST.json` 提供本次公开源文件清单、大小及 SHA-256，不是全仓库覆盖率或安全认证。
