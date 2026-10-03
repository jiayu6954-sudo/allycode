import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isIP } from "node:net";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
export interface AccountProfile { id: string; email: string; createdAt: string }
export interface AccountMailer { send(email: string, code: string): Promise<void> }
export class AccountError extends Error { constructor(public status: number, message: string) { super(message); } }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Passwordless accounts. A user is created only after mailbox ownership is verified. */
export class AccountService {
  private db: DatabaseSync;
  constructor(file: string, private secret: string, private mailer: AccountMailer, private now = Date.now) {
    if (secret.length < 32) throw new Error("ALLYCODE_AUTH_SECRET must contain at least 32 characters");
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  }
  close(): void { this.db.close(); }
  private codeHash(email: string, code: string): string { return createHmac("sha256", this.secret).update(email + "\0" + code).digest("hex"); }
  private rate(key: string, max: number, period: number): void {
    const now = this.now();
    this.db.prepare("DELETE FROM limits WHERE expires <= ?").run(now);
    const row = this.db.prepare("INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count").get(key, now + period) as { count: number };
    if (row.count > max) throw new AccountError(429, "请求过于频繁，请稍后再试。");
  }
  async requestCode(raw: unknown, ip: string): Promise<{ expiresIn: number; retryAfter: number }> {
    const email = emailSchema.parse(raw);
    this.rate("send-ip:" + digest(ip), 20, 3600000);
    this.rate("send-email:" + digest(email), 8, 86400000);
    const now = this.now();
    const previous = this.db.prepare("SELECT sent FROM codes WHERE email=?").get(email) as { sent: number } | undefined;
    if (previous && now - previous.sent < 60000) throw new AccountError(429, "请等待 60 秒后再获取验证码。");
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const hash = this.codeHash(email, code);
    this.db.prepare("INSERT INTO codes VALUES(?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash, expires=excluded.expires, attempts=0, sent=excluded.sent").run(email, hash, now + 600000, now);
    try { await this.mailer.send(email, code); }
    catch { this.db.prepare("DELETE FROM codes WHERE email=? AND hash=?").run(email, hash); throw new AccountError(503, "验证码邮件发送失败，请稍后重试或联系管理员。"); }
    return { expiresIn: 600, retryAfter: 60 };
  }
  verify(raw: unknown, ip: string): { profile: AccountProfile; token: string; expiresAt: string } {
    const { email, code } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).parse(raw);
    this.rate("verify-ip:" + digest(ip), 60, 3600000);
    const row = this.db.prepare("SELECT hash,expires,attempts FROM codes WHERE email=?").get(email) as { hash: string; expires: number; attempts: number } | undefined;
    if (!row || row.expires <= this.now() || row.attempts >= 5) throw new AccountError(400, "验证码无效或已过期，请重新获取。");
    this.db.prepare("UPDATE codes SET attempts=attempts+1 WHERE email=?").run(email);
    if (!timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(this.codeHash(email, code), "hex"))) throw new AccountError(400, "验证码不正确。");
    // No awaits inside the consume/create transaction: concurrent verification cannot reuse a code.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM codes WHERE email=?").run(email);
      this.db.prepare("INSERT OR IGNORE INTO users VALUES(?,?,?)").run(randomBytes(16).toString("hex"), email, new Date(this.now()).toISOString());
      const user = this.db.prepare("SELECT id,email,created_at AS createdAt FROM users WHERE email=?").get(email) as unknown as AccountProfile;
      const token = randomBytes(32).toString("base64url"), expires = this.now() + 30 * 86400000;
      this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(this.now());
      this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(token), user.id, expires);
      this.db.exec("COMMIT");
      return { profile: user, token, expiresAt: new Date(expires).toISOString() };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  profile(token: string): AccountProfile {
    const user = this.db.prepare("SELECT u.id,u.email,u.created_at AS createdAt FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.hash=? AND s.expires>?").get(digest(token), this.now());
    if (!user) throw new AccountError(401, "登录已过期，请重新登录。");
    return user as unknown as AccountProfile;
  }
  logout(token: string): void { this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(token)); }
  deleteAccount(token: string): void {
    const user = this.profile(token);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      this.db.prepare("DELETE FROM codes WHERE email=?").run(user.email);
      this.db.prepare("DELETE FROM users WHERE id=?").run(user.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

export function accountHandler(service: AccountService, trustedProxy = false) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      // Desktop requests originate in the main process; no cookies or browser CORS credentials.
      if (req.headers.origin) throw new AccountError(403, "请从 AllyCode 客户端访问账号服务。");
      if (req.method === "GET" && req.url === "/health") { res.end(JSON.stringify({ ok: true })); return; }
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new AccountError(415, "需要 JSON 请求。");
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) throw new AccountError(413, "请求过大。"); chunks.push(Buffer.from(chunk)); }
        body = z.record(z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      }
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
      // Enable only behind an exclusive reverse proxy that overwrites this header.
      const forwarded = req.headers["x-allycode-client-ip"];
      const ip = trustedProxy && typeof forwarded === "string" && isIP(forwarded)
        ? forwarded : req.socket.remoteAddress ?? "unknown";
      let result: unknown;
      if (req.method === "POST" && req.url === "/v1/code") result = await service.requestCode(body.email, ip);
      else if (req.method === "POST" && req.url === "/v1/verify") result = service.verify(body, ip);
      else if (req.method === "GET" && req.url === "/v1/me") result = { profile: service.profile(token) };
      else if (req.method === "POST" && req.url === "/v1/logout") { service.logout(token); result = { ok: true }; }
      else if (req.method === "POST" && req.url === "/v1/delete") { service.deleteAccount(token); result = { ok: true }; }
      else throw new AccountError(404, "接口不存在。");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof AccountError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
      res.end(JSON.stringify({ error: error instanceof AccountError ? error.message : res.statusCode === 400 ? "请检查邮箱和验证码格式。" : "账号服务暂时不可用。" }));
    }
  };
}
