# AllyCode 内置适配

优先调用专用工具，用户无需安装 Skill、填写 JSON 或执行命令。先发布中文计划。
本流程适用于用户需要交付 Excel 文件的任务；讨论表格、开发表格界面或排查 Excel 相关代码时，遵循实际目标，不擅自改成资料整理任务。
**输入格式不决定交付格式**：用户要求 Word 汇报材料时，只复用本技能的来源提取与核算步骤，交付 `.docx`，不要额外生成 Excel 替代报告。用 `document_verify` 复核报告结构与已核实关键文本，另行检查核算和排版。只含原生表格时无需调用视觉/OCR。大表用确定性代码完整读取并产出精简统计，不能让全量数据反复占用上下文。

## Word 报告与 PDF 转换

- 使用 `document_format status` 查看依赖和公文字体；缺失组件可 `setup`，联网授权与生成操作分开。
- `build` 使用结构化内容（title、summary、sections、sources），固定套用用户指定的三号正文、标题层级、行距与页边距。内容可先写项目内 JSON，然后传 `request={specFile:"结果/报告内容.json"}`；输出 Word 和审计文件自动保存在当前项目，不覆盖原件。无需临时编写几十 KB 的 Word 生成脚本。
- `word_to_pdf` 使用本机 LibreOffice，并验证输出 PDF 页数；仍需按页检查字体替代与版面。
- `pdf_to_word` 是按页重建可编辑文本并套用指定公文格式。复杂表格、图形、签章、公式和原版式不保证还原；转换限制写在生成文件与审计记录内。扫描页先使用现有 OCR，按原文件哈希及页码绑定证据，禁止静默跳过无文字页。
- Word 生成后，用 `document_verify` 对关键数字、章节和表格做独立断言；写入样式并不证明字体已安装，不能隐瞒字体缺失。

1. `sources_to_excel(action=status)` 检查 Python 与依赖；缺失时解释将为本项目安装隔离的 Excel 组件，再调用 `action=setup`。这是联网安装，遵循宿主权限决定；拒绝后不要绕过。没有 Python 时明确告知需要 Python 3.10+，不能声称已经可用。
2. `action=scan`，`request={inputs:[...],output:"结果/manifest.json",exclude:["结果",".allycode"]}`。输入和输出都须在当前项目内，默认排除 `.allycode` 和清单输出目录；建议资料放 `资料/`，输出放 `结果/`。读取清单、分批累计全部文件状态。
   使用 `action=inspect,request={manifest:"结果/manifest.json",start:0,limit:40}` 分页查看文件索引；带 `fileId` 时分页查看该文件的 segments。按 next 游标持续读取至 null；大清单不要依赖 file_read 的首段输出。嵌入技能已提供接口，无需越出项目读取安装目录。
3. 图片/扫描 PDF 先用 `vision_analyze(action=status)` 检查内置视觉；已安装时优先用 `engine=paddle,mode=text,page:1,output:"结果/ocr-1.json"` 按页提取，并用 Qwen 回答需要理解版式/图表的问题。组件缺失且用户暂不安装时，可明确使用 Windows 文字识别备选 `document_ocr(action=recognize,path:...,startPage:1,endPage:5,language:"zh-Hans",output:"结果/ocr-1.json")`，先检查本机 OCR 语言。页码从 1 起，按 totalPages/processedPages 补齐全部页；两种引擎都保留原文件哈希和 reviewed:false，不能把部分页或局部裁剪当成全量读取。
4. OCR 成功后用 `sources_to_excel(action=attach_ocr,request={manifest:"结果/manifest.json",fileId:"F000001",ocr:"结果/ocr-1.json"})`。工具核对源文件哈希与页/行定位，追加识别证据，保留原生提取和待复核状态。用 file_read/evidence_read 查看完整输出。不把 OCR 自动标为人工/视觉已复核；复杂表格、印章、手写、图表语义可能仍需视觉模型或用户复核。
5. 理解资料、动态确定列与粒度，使用十进制计算核对金额。`sources_to_excel(action=build,request:{manifest,output,coverage,sheets})`；schema 见 references/interface.md。每个非空字段都要来源定位与原文，所有文件都要覆盖记录。工具自动生成 xlsx 与 audit.json、重新打开检查并返回 SHA256。不要拿简单文件生成冒充完整资料核验；未读/模糊项必须准确列出。
6. 更新计划并交付输出绝对路径、文件数、行数、待核实数量。原始图片 OCR 在本机运行，无额外视觉 API 调用；识别文本会作为工具结果进入当前已配置模型的任务上下文。没有额外云端 OCR 服务。

这套 Excel 任务不属于“从零开发软件平台”，无需让用户先选架构。复杂度不在于让用户配置中间数据，而在于 Agent 正确核对数据。原包命令行仍可独立使用；内置适配会校验工作区与原文件版本。

## 内置视觉增强

可先调用 vision_analyze status。通用看图用 engine=qwen 和中文 question；扫描件原文用 engine=paddle, mode=text 按页识别，output 为新的 JSON 路径。完整页面识别证据可用 attach_ocr 合并；问答、区域裁剪与单个表格识别不是全页覆盖，不能据此标记全部资料已读。Paddle 当前直连识别模型，不包含官方版面分析完整流水线，复杂页面需分区域复核；所有数字和表格关系仍保留未复核标记。
