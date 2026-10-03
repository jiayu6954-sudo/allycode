import {it,expect} from "vitest";
import {simplePaddleTable} from "../../src/vision/table.js";
it("decodes real Paddle tokens while preserving leading zeros and decimals",()=>{expect(simplePaddleTable("<fcel>编号<fcel>00124<nl><fcel>数量<fcel>13<nl><fcel>金额<fcel>1290.53<nl>\n")).toEqual([["编号","00124"],["数量","13"],["金额","1290.53"]]);});
it("does not invent rectangular structure for merged or incomplete tables",()=>{expect(simplePaddleTable("<fcel>A<lcel><nl>")).toBeUndefined();expect(simplePaddleTable("<fcel>A<fcel>B<nl><fcel>C<nl>")).toBeUndefined();expect(simplePaddleTable("plain text")).toBeUndefined();});
