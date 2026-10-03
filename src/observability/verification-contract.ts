export const VERIFICATION_CONTRACT = {
  version: 1,
  document: "Word 报告优先 document_format build（固定公文格式、自动保存），再 document_verify：重新打开、格式声明、正文/关键数字文本断言、表格/图片数量、来源哈希。不要求虚构软件测试；此检查不替代全量核算、字体安装检查或渲染复核，软件项目仍需工程测试。PDF 转 Word 仅重建可编辑文本，原版式不保证还原。",
  rule: "验证应在最后相关修改或未知副作用之后成功退出，并属于当前执行轮次和工作区版本；不要求是最后一次工具动作。",
  safeAfterVerification: ["plan_update", "file_read", "glob", "grep", "evidence_read", "verification_status", "phase_checkpoint"],
  invalidation: "源码、测试、配置或普通文档写入，以及未知 shell 副作用会使旧证据失效。不能凭退出码或日志文字绕过失败。",
  finiteTest: "有限测试用 bash 前台独立运行，timeout 最高 900000ms；例如 powershell -NoProfile -ExecutionPolicy Bypass -File tests/run_e2e.ps1。不要拼接计时、清理、Git 或重定向；工具自动保留退出码和证据 ID。",
  receipt: "验收回执由系统保存在任务事件中，不修改用户工程。验证后可更新计划、读取证据；不要为了补写系统回执重跑测试。",
  spreadsheet: "sources_to_excel 原生生成的表格按独立产物证据验收：写后重开、文件/审计/来源哈希和待核实项；仅此类工具操作不要求软件 test/build。若另外修改代码或运行未知 shell，工程门禁照常适用。OCR 识别成功不代表数据准确。",
  scope: "工程检查通过只覆盖实际断言，不能等同所有业务需求交付。",
};
