import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { CredentialVault } from "./credential-vault.js";
import type { AccountProfile } from "../src/accounts/service.js";

export interface AccountState { configured: boolean; serviceUrl?: string; profile?: AccountProfile; message?: string }
function deployedAccountUrl():string|undefined {
  if(process.env.ALLYCODE_ACCOUNT_URL)return process.env.ALLYCODE_ACCOUNT_URL;
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  if(!resources)return undefined;
  try {return z.object({url:z.string()}).parse(JSON.parse(fs.readFileSync(path.join(resources,"account-service.json"),"utf8"))).url;}catch{return undefined;}
}
export function accountUrl(raw = deployedAccountUrl()): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("账号服务必须使用 HTTPS；本机开发服务可使用回环 HTTP。");
  return url.origin;
}
const ProfileSchema=z.object({id:z.string().regex(/^[a-f0-9]{32}$/),email:z.string().email(),createdAt:z.string().datetime()});
export class AccountClient {
  private base?:string;
  private configurationError?:string;
  constructor(private vault: CredentialVault, raw=deployedAccountUrl()) {
    try {this.base=accountUrl(raw);}catch{this.configurationError="账号服务地址配置无效，请联系部署者；本地功能可继续使用。";}
  }
  private async request(route: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
    if (!this.base) throw new Error("邮箱服务尚未配置。你可以继续使用本地功能，部署者配置账号服务后即可注册。");
    const response = await fetch(this.base + route, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error.slice(0, 300) : "账号请求失败，请稍后再试。");
    return result;
  }
  async state(): Promise<AccountState> {
    if (!this.base) return { configured: false, message:this.configurationError };
    const token = (await this.vault.getAll()).accountSession;
    if (!token) return { configured: true, serviceUrl: this.base };
    try { return { configured: true, serviceUrl: this.base, profile: ProfileSchema.parse((await this.request("/v1/me", undefined, token)).profile) }; }
    catch { return { configured: true, serviceUrl: this.base, message: "暂时无法确认登录状态。可重试或重新登录；本地任务仍可使用。" }; }
  }
  async send(email: unknown): Promise<void> {
    // Fail before sending mail if the OS cannot safely retain the resulting session.
    await this.vault.initialize();
    await this.request("/v1/code", { email: z.string().trim().email().max(254).parse(email) });
  }
  async verify(email: unknown, code: unknown): Promise<AccountState> {
    const body = z.object({ email: z.string().trim().email(), code: z.string().regex(/^\d{6}$/) }).parse({ email, code });
    const result = await this.request("/v1/verify", body);
    const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(result.token);
    try { await this.vault.setMany({ accountSession: token }); }
    catch (error) { await this.request("/v1/logout", {}, token).catch(() => {}); throw error; }
    return { configured: true, serviceUrl: this.base, profile: ProfileSchema.parse(result.profile) };
  }
  async logout(remove = false): Promise<AccountState> {
    const token = (await this.vault.getAll()).accountSession;
    if (token) await this.request(remove ? "/v1/delete" : "/v1/logout", {}, token);
    await this.vault.setMany({ accountSession: "" });
    return { configured: !!this.base, serviceUrl: this.base };
  }
}
