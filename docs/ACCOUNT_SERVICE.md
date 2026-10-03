# AllyCode 邮箱账号服务部署说明

本文面向部署维护者。alpha.22 提供可部署的邮箱验证码注册与登录服务；普通用户在客户端填写邮箱即可，无需自行维护服务器。当前项目未配置正式邮箱发送服务或域名，客户端会明确提示服务未上线，并允许继续使用本地能力。

## 账号边界

首次验证邮箱后建立账号，已注册邮箱用同一流程登录。验证码 10 分钟有效，间隔 60 秒可重发，每码最多尝试 5 次；默认每 IP 每小时 20 次发送、60 次验证，每邮箱每天 8 次发送。登录会话有效期 30 天；退出撤销当前会话，注销删除服务器账号及全部会话。

服务数据库仅保存邮箱、账号 ID、创建时间、验证码 HMAC、会话哈希和限流计数，不保存密码。桌面会话凭据放在操作系统密钥库保护的凭据文件中，不注入模型配置或提示词。邮箱会交给配置的邮件服务用于验证码发送。

本轮不是企业身份平台：没有 SSO、RBAC、管理员后台、账号云同步、跨系统账号数据隔离和滥用检测平台。同一操作系统用户的本地任务库仍共享；任务窗口本身继续按既有 task/session 隔离。账号注销不会删除本机项目文件。共享电脑应使用不同操作系统用户。

## 部署前准备

维护者需要一台支持 Docker Compose 的 Linux 服务器、指向它的域名，以及 Resend 已验证的发信域名和邮件 API 凭据。Resend 为首批接入的邮件供应商，不是 AllyCode 模型供应商。正式发信和公网部署未在本轮执行。

1. 复制 `deploy/accounts/.env.example` 为同目录 `.env`，仅在服务器本机填写变量。
2. `ACCOUNT_DOMAIN` 填写账号域名；`ALLYCODE_MAIL_FROM` 填写已验证发信地址；`RESEND_API_KEY` 使用邮件供应商颁发的密钥。
3. `ALLYCODE_AUTH_SECRET` 使用密码管理器生成至少 32 字符的随机值，不能沿用示例占位文字。可在可信终端运行 `openssl rand -hex 32`；不要把输出发到聊天或提交到仓库。
4. 防火墙允许 TCP 80/443。不要向公网发布账号容器的 8787 端口。
5. 在项目根目录执行：

```sh
docker compose --env-file deploy/accounts/.env -f deploy/accounts/compose.yml up -d --build
docker compose --env-file deploy/accounts/.env -f deploy/accounts/compose.yml ps
curl --fail https://你的账号域名/health
```

Compose 包含 Caddy HTTPS 入口与非 root 账号服务；账号数据保存在独立 volume。账号容器使用只读根文件系统并移除 Linux capabilities。`ALLYCODE_TRUST_PROXY=1` 仅适用于该独占反向代理拓扑：Caddy 覆盖客户端 IP 标头，后端不暴露端口。独立运行默认不信任代理标头；若自行改变拓扑，不应盲目启用。

健康接口成功仅证明进程与数据库可用，不证明邮件能送达。正式交付前，用维护者自有邮箱从客户端执行一次验证码收取、登录、重启保持、退出与注销测试，并验证重发限流。不要在日志中打印验证码、会话令牌或密钥。

## 连接桌面客户端

部署者在根目录 `account-service.json` 的 `url` 中填写 `https://你的账号域名`，然后重新构建客户端；该配置作为应用资源内置，普通用户不必设置环境变量。开发环境可用 `ALLYCODE_ACCOUNT_URL` 覆盖，HTTP 仅允许 loopback；禁止带用户名、密码、路径、查询参数的服务地址。客户端拒绝 HTTP 重定向，不会自动向跳转目标传递会话。

Linux 需要桌面密钥库（例如 GNOME Keyring）已解锁；当 Electron 只能使用 `basic_text` 后端时，客户端拒绝保存秘密，不降级为明文。

## 单进程部署与维护

当前 Node.js 22.13+ 单实例 SQLite 架构适合首轮部署，不宣称高可用或大规模认证验收。使用 WAL 与同步事务防止验证码重复兑换。邮箱和会话数据库需备份、限制访问，并按运营隐私要求定义保留周期。备份时建议停止账号容器后复制整个数据卷；恢复时使用匹配的服务版本与配置。

管理员换密钥后，已发验证码将失效；已有会话仍按数据库有效期处理。若需撤销全部会话，应在维护窗口通过专用运维流程处理，当前没有管理员界面。暂不支持多副本共享 SQLite。

本地开发构建：`npm run build:accounts`。设置上述发信参数、可选 `ALLYCODE_AUTH_DATA` 后执行 `npm run accounts:start`；默认仅监听 `127.0.0.1:8787`。不配置邮件服务会拒绝启动，不提供假验证码注册后门。

## 本轮证据

- 验证码、过期、限流、失败次数、会话撤销、数据库重开、HTTP 边界和代理身份测试，使用注入的模拟邮件发送器。
- Docker 镜像成功构建；非 root、只读根文件系统启动，健康接口 HTTP 200。
- UI 已验证未配置服务提示、邮箱表单与发送失败提示。未冒充真实发信验收。
- 实际公网 HTTPS 签发、邮件送达、运营隐私流程与多用户压力测试尚未执行。

参考：[Resend 发信接口](https://resend.com/docs/api-reference/emails/send-email)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。
