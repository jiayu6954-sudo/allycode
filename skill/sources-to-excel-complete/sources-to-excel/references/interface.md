# 扫描与生成接口

Python 3.10+。UTF-8 JSON 参数文件；路径建议为绝对路径。CLI 成功退出 0，stdout 为 JSON；失败退出 2，含 `ok:false,error`。函数接口 `scan(dict)` / `build(dict)` 同义，异常由调用方处理。

## scan

```json
{"inputs":["/data/batch","/data/extra.txt"],"output":"/work/manifest.json","exclude":["/data/batch/outputs"]}
```

扫描目录及子目录，不跟随符号链接。输出清单包含每个文件 `id,path,sha256,status,segments,warnings`；每个 segment 包含 `locator,text`，结构化来源另带原值/格式。文本按行、CSV/TSV 按记录、Excel 按单元格、PDF 按页、DOCX 按 XML 部件和段落定位。

状态：`extracted`、`duplicate`（有 `duplicate_of`）、`needs_ocr`、`needs_visual_review`、`unsupported`、`unreadable`、`symlink_skipped`。`extracted` 代表已取出原文，尚未完成语义整理。保留所有状态，包括失败项。

CSV 默认逗号，TSV 默认制表符；其他分隔符用宿主解析后补充 segments。编码先 UTF-8 BOM，再尝试 GB18030；必须核对中文是否正确，不确定则重读。XLSX 同时记录公式及缓存，不执行公式。DOCX 文本提取不能证明表格结构正确，须用宿主文档工具核对。旧版 XLS、压缩包、邮件及其他格式用宿主工具补充，不把“不支持”当作跳过许可。

单文件及 Office 解压大小 100 MiB；XLSX 单表范围 200,000 格。超出则按页/区域/批次用宿主工具读取并登记，不能截断后标记全部完成。未打开的压缩包不能声称其中每个文件都被扫描。

## 补充 OCR / 原生读取证据

Agent 调用视觉或 OCR 后，为对应文件的 `segments` **追加**内容，保留扫描结果与哈希，例如：

```json
{"locator":"page:2:ocr","text":"识别出的原文，保持原始数字","method":"host-vision","reviewed":true}
```

只有实际复核后才能写 `reviewed:true`。含表格时用行/单元格定位保留行列关系。不直接改写原生提取文字来迎合期望值。`coverage.review_note` 记录所用读取方式和复核范围；如有仍未读部分但有可用记录，将该文件记为 `partial`，在 reason 列明遗漏页/区域并保留可用记录；完全不可用才记为 `unreadable`，避免误报完整覆盖。粘贴文字可原样保存为 UTF-8 来源文件后扫描，不改写原话。

## build

```json
{
  "manifest":"/work/manifest.json",
  "output":"/work/资料汇总.xlsx",
  "coverage":{
    "F000001":{"status":"included"},
    "F000002":{"status":"duplicate","duplicate_of":"F000001","reason":"内容哈希相同"},
    "F000003":{"status":"unreadable","reason":"图片金额模糊，待提供清晰版"}
  },
  "sheets":[{
    "name":"资料汇总",
    "columns":[
      {"key":"item","header":"事项","type":"text"},
      {"key":"count","header":"数量","type":"integer"}
    ],
    "rows":[{
      "values":{"item":"桌椅","count":"12"},
      "evidence":{
        "item":[{"file_id":"F000001","locator":"line:1","quote":"桌椅"}],
        "count":[{"file_id":"F000001","locator":"line:1","quote":"12"}]
      },
      "issues":[]
    }]
  }]
}
```

示例字段只是示例；按实际任务重新设计。`columns` 为动态字段，`rows[].values` 必须完整覆盖键，缺失用 null 并在 `issues` 说明。每个非空字段 `evidence` 至少有一项，必须指向已纳入文件中存在的 locator 和原文子串。归一化日期、数值可以不同于原文，但 Agent 要核实转换并可在行内增加 `normalizations` 说明。派生值在 `derivations` 写计算方法、输入及结果，并为该字段列出输入数据证据；写入器不验证计算公式或证据与值之间的语义关系，由 Agent 用确定性计算复核。

支持 `text`（默认，必须字符串）、`integer`、`decimal`（均传十进制字符串或整数，不传 float）、`date`（YYYY-MM-DD）、`boolean`（JSON 布尔）。超过 Excel 可靠精度的数值自动按文本存储并产生 warning。模糊日期不要强行归一；可用文本保留原文并记问题。文本中 `=` 不会执行为公式。

每个文件必须出现在 coverage，状态为 `included/partial/duplicate/out_of_scope/unreadable`。partial 和排除项必须说明 reason；duplicate 还须有指向纳入文件的 duplicate_of；需要额外读取的 included/partial 文件必须有 review_note。included/partial 文件必须贡献字段证据，排除文件不得提供字段证据。无相关内容但成功读取的文件记为 out_of_scope 并说明；未读文件不能如此归类。来源文件内容哈希会重新核验；若变化须重扫。

输出审计 JSON 包含请求、来源清单、逐字段证据、问题及精度警告。业务表不自动追加固定来源列。Audit 含原始资料，应按输入资料同等权限处理，交付/分享对象由用户授权决定。输出仅创建新文件，已有同名文件报错。每表最多 200,000 格、16,384 列、1,048,575 条数据；超过须分批/拆表，不能丢弃记录。重开校验不等于在 Excel/WPS 中完成视觉检查，必要时用宿主预览工具检查。


### Word 自适应结构与设计记录

DOCX 额外提供 structure.tables（坐标、行数、网格列数、合并情况、首行原文）和 structure.headings；首行不自动认定为表头。table_row 段包含 values 和 cells（colspan、vmerge），与段落是互补视图，不能重复统计。嵌套表、跨行合并和图片仍需复核。

通过 AllyCode 内置工具生成含 Word 来源的表格时，每张 sheets 项必须提供非空 rowMeaning、designReason，说明一行代表的实体/粒度及字段选择依据。模型自行决定字段、行数和分表，不固定行业模板。这些说明保存在审计 JSON 中，不作为装饰行插入业务 Excel。


### 显式公式列

新增 type=formula，值为包含 formula、expected、resultType、explanation 的对象；执行协议及函数范围见 [行业与公式技能](formulas.md)。普通文本仍永不执行为公式。单独使用 Python build 只写公式，审计标记 pending_recalculation；只有 AllyCode 内置工具完成本地 Calc 重算、预期值比对和缓存重开校验，才发布正式结果。
