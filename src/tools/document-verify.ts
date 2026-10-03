import { z } from "zod";
import { findPython, hashDocument } from "./sources-to-excel.js";
import { resolveWorkspacePath, assertSafeWorkspaceRoot } from "./path-guard.js";
import { documentProcess } from "./local-document-process.js";
import type { ToolExecutionContext, ToolResult } from "../types/tools.js";
import { DOCUMENT_PROFILE } from "./document-profile.js";

const Schema = z.object({
  path: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1).max(100),
  expectedText: z.array(z.string().min(1).max(1000)).min(1).max(100),
  minTables: z.number().int().min(0).max(1000).default(0),
  minImages: z.number().int().min(0).max(1000).default(0),
  deliveryFiles: z.array(z.string().min(1)).min(1).max(100).optional(),
});

// Fixed, read-only standard-library validator. Never imports workspace Python modules.
const INSPECT = `import sys,json,zipfile,xml.etree.ElementTree as E
r=json.load(sys.stdin)
with zipfile.ZipFile(r['path']) as z:
 infos=z.infolist()
 assert len(infos)<=10000 and sum(i.file_size for i in infos)<=100*1024*1024, 'DOCX expanded size exceeds limit'
 assert len({i.filename for i in infos})==len(infos), 'Duplicate ZIP entries'
 assert z.testzip() is None, 'DOCX CRC failed'
 assert '[Content_Types].xml' in z.namelist() and 'word/document.xml' in z.namelist(), 'Not a Word document'
 raw=z.read('word/document.xml')
 assert b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw, 'Unsupported XML entities'
 root=E.fromstring(raw)
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 profile=r['profile']
 styles=E.fromstring(z.read('word/styles.xml'))
 def attr(el,key): return el.get('{'+ns['w']+'}'+key) if el is not None else None
 def style_check(style_id,font,size,line,bold):
  style=styles.find("w:style[@w:styleId='"+style_id+"']",ns)
  assert style is not None, 'Missing style: '+style_id
  fonts=style.find('w:rPr/w:rFonts',ns)
  assert attr(fonts,'eastAsia')==font and attr(fonts,'ascii')==profile['latinFont'], 'Font declaration mismatch: '+style_id
  assert attr(style.find('w:rPr/w:sz',ns),'val')==str(size*2), 'Font size mismatch: '+style_id
  spacing=style.find('w:pPr/w:spacing',ns)
  assert attr(spacing,'line')==str(line*20) and attr(spacing,'lineRule')=='exact', 'Line spacing mismatch: '+style_id
  b=style.find('w:rPr/w:b',ns)
  actual=b is not None and attr(b,'val') not in ('0','false','off')
  assert actual==bold, 'Bold mismatch: '+style_id
  italic=style.find('w:rPr/w:i',ns)
  assert italic is None or attr(italic,'val') in ('0','false','off'), 'Unexpected italic style: '+style_id
  assert style.find('w:pPr/w:pBdr',ns) is None, 'Unexpected paragraph border: '+style_id
 style_check('Normal',profile['bodyFont'],profile['bodySizePt'],profile['bodyLinePt'],False)
 style_check('Title',profile['titleFont'],profile['titleSizePt'],profile['titleLinePt'],False)
 for i in range(4): style_check('Heading'+str(i+1),profile['headingFonts'][i],profile['headingSizePt'],profile['bodyLinePt'],profile['headingBold'][i])
 body=list(root.find('w:body',ns))
 title_positions=[i for i,el in enumerate(body) if attr(el.find('w:pPr/w:pStyle',ns),'val')=='Title']
 assert title_positions, 'Missing document title'
 for pos in title_positions[:1]:
  blanks=body[pos+1:pos+1+profile['titleBlankLines']]
  assert len(blanks)==profile['titleBlankLines'] and all(el.tag=='{'+ns['w']+'}p' and not ''.join(el.itertext()).strip() and el.find('.//w:drawing',ns) is None for el in blanks), '标题下必须保留两个空白段落'
 for para in root.findall('.//w:p',ns):
  sid=attr(para.find('w:pPr/w:pStyle',ns),'val') or 'Normal'
  if sid=='Title': expected_font,size,line=profile['titleFont'],profile['titleSizePt'],profile['titleLinePt']
  elif sid in ['Heading1','Heading2','Heading3','Heading4']: expected_font,size,line=profile['headingFonts'][int(sid[-1])-1],profile['headingSizePt'],profile['bodyLinePt']
  else: expected_font,size,line=profile['bodyFont'],profile['bodySizePt'],profile['bodyLinePt']
  spacing=para.find('w:pPr/w:spacing',ns)
  if spacing is not None and attr(spacing,'line') is not None: assert attr(spacing,'line')==str(line*20) and attr(spacing,'lineRule')=='exact', 'Direct line spacing override'
  for run in para.findall('w:r',ns):
   if run.find('w:t',ns) is None: continue
   size_override=attr(run.find('w:rPr/w:sz',ns),'val')
   assert size_override is None or size_override==str(size*2), 'Direct font size override'
   fonts=run.find('w:rPr/w:rFonts',ns)
   assert attr(fonts,'eastAsia') in (None,expected_font) and attr(fonts,'ascii') in (None,profile['latinFont']), 'Direct font override'
 sections=root.findall('.//w:sectPr',ns)
 assert sections, 'Missing page setup'
 for sec in sections:
  for key,cm in [('top',profile['marginTopCm']),('bottom',profile['marginBottomCm']),('left',profile['marginLeftCm']),('right',profile['marginRightCm']),('header',profile['headerCm']),('footer',profile['footerCm'])]:
   assert abs(int(attr(sec.find('w:pgMar',ns),key))-round(cm*1440/2.54))<=1, 'Page margin mismatch: '+key
  sz=sec.find('w:pgSz',ns)
  assert abs(int(attr(sz,'w'))-round(21*1440/2.54))<=1 and abs(int(attr(sz,'h'))-round(29.7*1440/2.54))<=1, 'Paper must be A4'
 footer_alignments=set()
 for name in z.namelist():
  if name.startswith('word/footer') and name.endswith('.xml'):
   footer=E.fromstring(z.read(name))
   if any('PAGE' in (t.text or '') for t in footer.findall('.//w:instrText',ns)):
    footer_alignments.add(attr(footer.find('.//w:pPr/w:jc',ns),'val'))
 assert {'left','right'}.issubset(footer_alignments), 'Missing outer page numbers'
 paragraphs=[''.join(t.text or '' for t in p.findall('.//w:t',ns)) for p in root.findall('.//w:p',ns)]
 text='\\n'.join(paragraphs)
 assert text.strip(), 'Word document has no text'
 missing=[s for s in r['expectedText'] if s not in text]
 tables=len(root.findall('.//w:tbl',ns))
 images=len(root.findall('.//w:drawing',ns))
 assert not missing, 'Missing required text assertions: '+json.dumps(missing,ensure_ascii=False)
 assert tables>=r['minTables'], 'Missing expected tables'
 assert images>=r['minImages'], 'Missing expected images'
 print(json.dumps({'paragraphs':len(paragraphs),'tables':tables,'images':images,'characters':len(text),'assertions':len(r['expectedText']),'profileDeclarations':'passed','visualReview':'not_performed'},ensure_ascii=False))
`;

export async function executeDocumentVerify(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  assertSafeWorkspaceRoot(ctx.cwd);
  const input = Schema.parse(raw);
  const output = resolveWorkspacePath(ctx.cwd, input.path);
  const deliveryFiles = input.deliveryFiles?.map(file => resolveWorkspacePath(ctx.cwd, file));
  if (deliveryFiles && (!deliveryFiles.includes(output) || deliveryFiles.some(file => !/\.docx$/i.test(file)))) throw new Error("正式交付清单必须包含当前报告，且均为项目内 .docx 路径。");
  if (!/\.docx$/i.test(output)) throw new Error("目前支持 .docx；请先生成用户要求的 Word 文件，再执行产物校验。");
  const paths = [...new Set(input.sources.map(source => resolveWorkspacePath(ctx.cwd, source)))];
  if (paths.includes(output)) throw new Error("来源资料不能是报告自身。");
  const sha256 = await hashDocument(output);
  const sources = await Promise.all(paths.map(async source => ({ path: source, sha256: await hashDocument(source) })));
  const python = await findPython(ctx, []);
  if (!python) throw new Error("需要 Python 3.10+ 进行 Word 结构校验，无需安装额外 Python 包。");
  let verification:Record<string,unknown>;
  try {
    verification = JSON.parse(await documentProcess(python.command, [...python.args, "-I", "-X", "utf8", "-c", INSPECT], ctx, JSON.stringify({ ...input, path: output, profile:DOCUMENT_PROFILE }), 60_000)) as Record<string, unknown>;
  } catch(error) { throw new Error("Word 结构、内容或指定格式检查未通过；请用 document_format build 生成符合内置规范的报告后再验收。详细诊断：" + String(error), {cause:error}); }
  if (await hashDocument(output) !== sha256) throw new Error("校验期间 Word 文件发生改变，请重新核对。");
  for (const source of sources) if (await hashDocument(source.path) !== source.sha256) throw new Error("校验期间来源文件发生改变，请重新核对。");
  const documentArtifact = { output, sha256, sources, verification, ...(deliveryFiles ? {deliveryFiles} : {}) };
  return { isError: false, content: JSON.stringify({ ...documentArtifact, scope: "已重新打开 DOCX，检查 ZIP/XML、非空正文、指定文本与表格/图片数量，并绑定来源哈希。未验证分页排版、数据全量覆盖或业务数值正确性；需另行核算与渲染复核。" }), metadata: { documentArtifact } };
}
