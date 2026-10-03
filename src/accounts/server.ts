import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AccountService, accountHandler } from "./service.js";

const key = process.env.RESEND_API_KEY, from = process.env.ALLYCODE_MAIL_FROM;
if (!key || !from) throw new Error("配置 RESEND_API_KEY 与 ALLYCODE_MAIL_FROM 后才能启动真实邮箱注册服务。");
const directory = path.resolve(process.env.ALLYCODE_AUTH_DATA ?? "./account-data");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
process.umask(0o077);
const service = new AccountService(path.join(directory, "accounts.sqlite"), process.env.ALLYCODE_AUTH_SECRET ?? "", {
  async send(email, code) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: "AllyCode 邮箱验证码", text: `你的 AllyCode 验证码为 ${code}，10 分钟内有效。请勿向他人提供。若非本人操作，请忽略此邮件。` }),
    });
    if (!response.ok) throw new Error("Mail delivery rejected");
  },
});
const server = createServer(accountHandler(service, process.env.ALLYCODE_TRUST_PROXY === "1"));
server.requestTimeout = 20000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1", () => console.log("AllyCode account service ready"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => { service.close(); process.exit(0); }));
