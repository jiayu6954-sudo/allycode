/** Decode only unmerged rectangular OTSL tables; preserve unsupported structures as raw evidence. */
export function simplePaddleTable(text:string):string[][]|undefined {
  if(/<(?:lcel|ucel|xcel)>/.test(text))return undefined;
  const lines=text.trim().split("<nl>");if(lines.at(-1)?.trim()==="")lines.pop();
  if(!lines.length||lines.length>200)return undefined;
  const rows:string[][]=[];
  for(const line of lines){
    if(!/^\s*<(?:fcel|ecel)>/.test(line))return undefined;
    const cells=line.trim().split(/<(?:fcel|ecel)>/).slice(1).map(cell=>cell.trim());
    if(!cells.length||cells.length>100||rows.length&&cells.length!==rows[0]!.length)return undefined;
    rows.push(cells);
  }
  return rows.reduce((count,row)=>count+row.length,0)>2000?undefined:rows;
}
