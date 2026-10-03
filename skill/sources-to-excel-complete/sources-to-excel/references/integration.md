# 跨框架接入

此 Skill 包含平台无关的执行说明与 Python 工具。宿主需要：读取用户授权文件、可执行 Python、理解资料的大模型，以及处理图片/扫描件时可调用的视觉或 OCR。没有任何一个固定模型、行业字段或服务商依赖。不能把“任意框架可适配”理解为“所有平台上传后零配置可用”。

## Agent 工作流

把 SKILL.md 注入任务上下文，并暴露 `scan`、`build` 两个工具。一次用户请求内部执行：

1. scan 清点并取得原文。
2. Agent 分批读取清单，调用宿主解析器/视觉/OCR 补全。
3. Agent 推断表头、生成结构化记录、进行数值与证据核验。
4. build 生成 Excel，Agent 检查结果并交付。

不要直接把 scan 输出连到 build，也不要要求最终用户填写 schema、manifest、evidence。这些均由 Agent 准备。可使用 `assets/sources-tool.schema.json` 定义宿主工具的参数；build 的动态字段由 Agent 在运行时确定。

## 进程适配器

在隔离环境按需安装 requirements.txt（扫描 PDF 需要 pypdf，XLSX 读写需要 openpyxl；不含 OCR 引擎）。宿主先校验路径属于本次获准范围，再使用参数数组启动，勿拼接 shell：

```python
import json, subprocess, sys, tempfile
from pathlib import Path

def run_excel_tool(command, arguments, skill_dir):
    if command not in {'scan', 'build'}:
        raise ValueError('unsupported command')
    with tempfile.TemporaryDirectory() as temp:
        request = Path(temp) / 'request.json'
        request.write_text(json.dumps(arguments, ensure_ascii=False), encoding='utf-8')
        process = subprocess.run(
            [sys.executable, str(Path(skill_dir)/'scripts'/'sources_to_excel.py'),
             command, '--request', str(request)],
            capture_output=True, text=True, encoding='utf-8', timeout=300)
    result = json.loads(process.stdout)
    if process.returncode:
        raise RuntimeError(result.get('error', 'execution failed'))
    return result
```

也可将 scripts 加入 Python 模块路径，调用 `sources_to_excel.scan(arguments)` / `build(arguments)`。若宿主强制专用写入后端，使用该后端生成文件并保留相同校验与审计约束。

## 框架接入位置

- 原生 Skills：加载整个文件夹，执行 SKILL.md。
- MCP：注册 JSON schema 和相应 handler；本包未自带常驻 MCP 服务。
- LangChain/LangGraph、AutoGen、CrewAI：用当前框架的函数工具接口包装上述函数，并为 Agent 提供 OCR/视觉和文件读取工具。
- Dify 等工作流：在支持文件访问和依赖的容器/服务中运行脚本，在模型节点完成字段推断与提取。受限代码节点未必支持直接安装依赖。

这些是适配契约，不表示所有框架版本均已完成测试。执行 `python scripts/test_sources_to_excel.py` 验证混合来源、覆盖与证据约束、精度、普通样式及失败保护。原排版功能另有 `python scripts/test_plain_excel.py`。
