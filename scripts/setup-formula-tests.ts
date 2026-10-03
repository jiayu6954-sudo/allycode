import {executeDocumentFormat} from "../src/tools/document-format.js";
const result=await executeDocumentFormat({action:"setup"},{cwd:process.cwd(),timeoutMs:900000});
if(result.isError)throw new Error(result.content);
console.log("Document and formula test components ready.");
