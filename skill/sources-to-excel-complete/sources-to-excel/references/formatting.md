# 接口与能力边界

`inspect --input 文件.xlsx` 返回表名、状态、使用范围、原生表范围、前 8 行前 6 列样本和公式计数，不修改文件。

`run --request 请求.json` 读取 UTF-8 JSON。路径相对于进程当前目录；框架建议传绝对路径。

| 参数 | 含义 |
| --- | --- |
| input / output | 必填 .xlsx 路径，禁止指向同一文件 |
| template | 可选只读样式参考 |
| template_sheet | 默认模板第一张表 |
| template_header_row / template_body_row | 默认 1 / 2，提取各行 A 列单元格样式 |
| mode | 默认 preserve；compact 裁剪到 A1 |
| headers | preserve 表名到表头行的映射；默认优先原生表表头，其次首个非空行。含标题的表应显式指定 |
| ranges | compact 必填且覆盖全部工作表；第一行是表头 |
| acknowledge_crop | compact 必须 true，确认范围外内容可以丢弃 |
| layout | preserve 默认保留尺寸；readable 开启换行并估算行高 |
| font / font_size | 覆盖模板；默认宋体 11 号 |
| header_bold / header_border | 覆盖模板表头加粗、细边框开关 |
| overwrite | 默认 false，true 可替换 output，仍不能覆盖 input/template |

preserve 保留内容、公式文本、值类型、数字格式、验证规则、超链接、合并范围与表顺序。compact 用选定纯数据范围新建普通单元格区域，映射超链接和完全落在区域内的验证规则，清除原生表与旧筛选，冻结首行；拒绝引用敏感结构。源文件均不变。

成功退出码 0，stdout 是 JSON，含 `ok`、绝对 `output`、`mode`、`sheets`、`checks` 和 `warnings`；失败退出码 2，含 `ok:false,error`。先写临时文件，重新打开核对值/类型/数字格式及黑字无填充，再替换目标。失败不会用半成品覆盖已有输出。

仅支持普通 xlsx。输入解压大小最多 100 MiB，单表矩形使用范围最多 200,000 格。复杂对象会在预检时拒绝，而不是静默丢弃。脚本不执行公式重算，保存后缓存可能清空，依赖公式缓存的下游须先用 Excel/WPS/LibreOffice 重算。字体显示取决于本机字体；没有分发商业字体。

readable 行高是估算；长 URL 与中文混排仍需实际查看。脚本不联网、不上传、不发送邮件，文件交付由宿主负责。
