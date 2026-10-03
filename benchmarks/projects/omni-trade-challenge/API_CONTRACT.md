# 固定 API 契约

所有 JSON API 使用 `Content-Type: application/json`。除健康检查外均位于 `/api`。

| 方法与路径 | 核心要求 |
|---|---|
| `GET /health` | 200，返回 `{status:"ok", version, dependencies}` |
| `POST /api/catalog/sync` | 同步供应商目录，返回 `{created, updated, unchanged}` |
| `GET /api/products` | 返回 `{items:[...], total}`；每项含 id/sku/name/cost/salePrice/stock/status |
| `PATCH /api/products/:id/publish` | 发布合法商品，返回更新后的商品 |
| `POST /api/orders` | Header `Idempotency-Key`；body `{customer, items:[{productId,quantity}]}` |
| `GET /api/orders/:id` | 返回订单、金额、状态和 `timeline` |
| `POST /api/webhooks/payment` | Header `x-event-id`、`x-webhook-signature`；body `{orderId,status}` |
| `POST /api/webhooks/shipment` | 同上；body `{orderId,status,trackingNumber}` |
| `POST /api/support/tickets` | body `{orderId,subject,priority,message}` |
| `POST /api/jobs/run` | 执行到期作业，返回 `{processed, failed, skipped}` |
| `POST /api/admin/external-probe` | 验证 503 重试，返回 `{ok:true, attempts}` |
| `GET /api/dashboard` | 返回商品、订单、客服、作业的聚合计数 |
| `GET /api/audit` | 可用 `type` 过滤，返回 `{items,total}` |
| `GET /api/metrics` | 返回下述固定指标结构 |

指标至少包含：

```json
{
  "cache": { "hits": 0, "misses": 0, "hitRate": 0 },
  "external": { "requests": 0, "retries": 0, "failures": 0 },
  "webhooks": { "accepted": 0, "duplicates": 0, "invalidSignatures": 0 },
  "jobs": { "processed": 0, "failed": 0, "pending": 0 }
}
```

## 测试环境变量

```text
PORT=4300
WEB_PORT=4173
EXTERNAL_API_BASE=http://127.0.0.1:4400
SUPPLIER_API_KEY=challenge-supplier-key
WEBHOOK_SECRET=challenge-webhook-secret
ALLYCODE_CHALLENGE=1
```

挑战密钥仅用于本地模拟，不是真实凭据。
