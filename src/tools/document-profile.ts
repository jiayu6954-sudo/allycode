import { z } from "zod";

/** Transcribed from the user's 2026-09-21 formatting reference. */
export const DOCUMENT_PROFILE = {
  id: "official-zh-20260921", paper: "A4", latinFont: "Times New Roman",
  bodyFont: "仿宋_GB2312", bodySizePt: 16, bodyLinePt: 28, firstLineChars: 2,
  titleFont: "方正小标宋简体", titleSizePt: 22, titleLinePt: 30, titleBlankLines: 2,
  headingFonts: ["黑体", "楷体_GB2312", "仿宋_GB2312", "仿宋_GB2312"],
  headingSizePt: 16, headingBold: [false, true, true, true],
  marginTopCm: 3.7, marginBottomCm: 3.5, marginLeftCm: 2.8, marginRightCm: 2.7,
  headerCm: 1.4, footerCm: 2.2, pageNumberFont: "宋体", pageNumberSizePt: 14,
  source: "用户提供的微信图片_20260921164216_38_6.png；西文字体按标准名称 Times New Roman 记录。",
} as const;

const Table = z.object({ headers: z.array(z.string()).min(1).max(8), rows: z.array(z.array(z.string())).max(1000) })
  .refine(t=>t.rows.every(row=>row.length===t.headers.length),"表格每行必须与表头列数相同");
export const DocumentRequest = z.object({
  output: z.string().min(1), sources: z.array(z.string().min(1)).min(1).max(100),
  title: z.string().min(1).max(300), summary: z.string().min(1).max(20000),
  sections: z.array(z.object({
    heading: z.string().min(1).max(300), level: z.number().int().min(1).max(4).default(1),
    paragraphs: z.array(z.string().max(30000)).max(200).default([]),
    tables: z.array(Table).max(20).default([]),
  })).min(1).max(100),
  attachments: z.array(z.string().min(1).max(300)).max(50).default([]),
  issuer: z.string().max(200).optional(), date: z.string().max(100).optional(), contact: z.string().max(300).optional(),
});
