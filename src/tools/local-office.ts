import fs from "node:fs/promises";
import path from "node:path";
import { documentProcess } from "./local-document-process.js";
import type { ToolExecutionContext } from "../types/tools.js";
import { documentsDirectory } from "../skills/bundled.js";

/** Only application-owned or standard installed runtimes; never a request-supplied executable. */
export async function officePath(): Promise<string | undefined> {
  const candidates = process.platform === "win32"
    ? [path.join(documentsDirectory(), "libreoffice/LibreOffice/program/soffice.com"), path.join(documentsDirectory(), "libreoffice/program/soffice.com"), "C:/Program Files/LibreOffice/program/soffice.com"]
    : [path.join(documentsDirectory(), "libreoffice/opt/libreoffice26.2/program/soffice"), path.join(documentsDirectory(), "libreoffice/program/soffice"), "/usr/bin/libreoffice", "/usr/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  for (const file of candidates) {
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  return undefined;
}

export async function modernOfficeReady(ctx:ToolExecutionContext):Promise<boolean> {
  const office=await officePath();if(!office)return false;
  try {const version=(await documentProcess(office,["--version"],ctx,undefined,15000)).match(/LibreOffice (\d+)\.(\d+)/);
    return !!version&&(Number(version[1])>24||(Number(version[1])===24&&Number(version[2])>=8));
  }catch{return false;}
}
