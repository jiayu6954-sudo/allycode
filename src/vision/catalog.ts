export type VisionEngine = "qwen" | "paddle";
export interface VisionAsset { file:string; url:string; sha256:string; bytes:number }
const paddleBase = "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/511b09642bb324401f15f97cc23bc67e8f0a291d/";
export const QWEN_MODEL = "qwen3.5:9b";
export const QWEN_MANIFEST = {schemaVersion:2,mediaType:"application/vnd.docker.distribution.manifest.v2+json",config:{mediaType:"application/vnd.docker.container.image.v1+json",digest:"sha256:be595b49fe22012bd1f5605ec14c7ffa58331783a88a4fd8c22e5fc8ec42cf9f",size:475},layers:[{mediaType:"application/vnd.ollama.image.model",digest:"sha256:dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c",size:6594462816},{mediaType:"application/vnd.ollama.image.license",digest:"sha256:7339fa418c9ad3e8e12e74ad0fd26a9cc4be8703f9c110728a992b193be85cb2",size:11355},{mediaType:"application/vnd.ollama.image.params",digest:"sha256:9371364b27a52acac9d87f88bd93c9db1174d8d6ec57f6888925cdc1788871ff",size:65}]};
export const WINDOWS_VISION_ASSETS:VisionAsset[] = [
  {file:"downloads/ollama-v0.34.2.zip",url:"https://github.com/ollama/ollama/releases/download/v0.34.2/ollama-windows-amd64.zip",sha256:"8f3fd071a2a2f9497b562f43502c77c2b701a99d1ee5dfda28da8c786373063b",bytes:1460928014},
  {file:"downloads/llama-b10964-vulkan.zip",url:"https://github.com/ggml-org/llama.cpp/releases/download/b10964/llama-b10964-bin-win-vulkan-x64.zip",sha256:"1ee3ad952f4ba71f438bd6d7bebef19e1c7af04adcaa35d08b4ddabb27d4c642",bytes:31674542},
  ...[QWEN_MANIFEST.config,...QWEN_MANIFEST.layers].map(layer=>({file:"models/blobs/"+layer.digest.replace(":","-"),url:"https://registry.ollama.ai/v2/library/qwen3.5/blobs/"+layer.digest,sha256:layer.digest.slice(7),bytes:layer.size})),
  {file:"paddle/model.gguf",url:paddleBase+"PaddleOCR-VL-1.6-GGUF.gguf",sha256:"f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8",bytes:935769056},
  {file:"paddle/mmproj.gguf",url:paddleBase+"PaddleOCR-VL-1.6-GGUF-mmproj.gguf",sha256:"204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a",bytes:881770560},
];
export const LINUX_VISION_ASSETS:VisionAsset[] = [
  {file:"downloads/ollama-v0.34.2-linux.tar.zst",url:"https://github.com/ollama/ollama/releases/download/v0.34.2/ollama-linux-amd64.tar.zst",sha256:"e155b83589986d2c581fdbf1381ea3ebdb16549883679cd5a0627f7cdc05b12b",bytes:1427542079},
  {file:"downloads/llama-b10964-linux.tar.gz",url:"https://github.com/ggml-org/llama.cpp/releases/download/b10964/llama-b10964-bin-ubuntu-x64.tar.gz",sha256:"9abf88aea48a55d0f80edb1ee20220b186848cca0b4e919d71518cfd7ca67443",bytes:16825086},
  ...WINDOWS_VISION_ASSETS.filter(asset=>!asset.file.startsWith("downloads/")),
];
export const VISION_ASSETS = process.platform === "linux" ? LINUX_VISION_ASSETS : WINDOWS_VISION_ASSETS;
export const VISION_MODELS = {qwen:"Qwen3.5-9B Q4_K_M",paddle:"PaddleOCR-VL-1.6 GGUF"} as const;
