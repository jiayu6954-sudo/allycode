import crypto from "node:crypto";

const apiBase = process.env.TARGET_API ?? "http://127.0.0.1:4300";
const webBase = process.env.TARGET_WEB ?? "http://127.0.0.1:4173";
const mockBase = process.env.EXTERNAL_API_BASE ?? "http://127.0.0.1:4400";
const secret = process.env.WEBHOOK_SECRET ?? "challenge-webhook-secret";

export async function runAcceptance() {
  const results = [];
  let products = [];
  let product;
  let order;

  await check(results, "health", "基础运行", 3, async () => {
    const { response, body } = await request(`${apiBase}/health`);
    assert(response.status === 200 && body.status === "ok", "健康检查未返回 status=ok");
    assert(body.dependencies && typeof body.dependencies === "object", "缺少 dependencies");
  });

  await check(results, "catalog_sync", "商品", 6, async () => {
    const first = await request(`${apiBase}/api/catalog/sync`, { method: "POST" });
    assert(first.response.ok, `首次同步失败：${first.response.status}`);
    const listed = await request(`${apiBase}/api/products`);
    products = listed.body.items;
    assert(Array.isArray(products) && products.length === 3, "同步后应有 3 个商品");
    assert(new Set(products.map((item) => item.sku)).size === 3, "SKU 不唯一");
  });

  await check(results, "catalog_etag", "商品", 4, async () => {
    const second = await request(`${apiBase}/api/catalog/sync`, { method: "POST" });
    assert(second.response.ok, "第二次同步失败");
    const metrics = await request(`${mockBase}/__control/metrics`);
    assert(metrics.body.supplierConditional >= 1, "第二次同步没有发送 If-None-Match");
  });

  await check(results, "pricing_publish", "商品", 5, async () => {
    product = products[0];
    assert(Number.isFinite(product.salePrice) && product.salePrice >= product.cost, "销售价未由服务端正确生成");
    const published = await request(`${apiBase}/api/products/${encodeURIComponent(product.id)}/publish`, { method: "PATCH" });
    assert(published.response.ok && published.body.status === "published", "商品发布失败");
    product = published.body;
  });

  const orderPayload = () => ({
    customer: { name: "测试客户", email: "buyer@example.test", phone: "13800000000" },
    items: [{ productId: product?.id, quantity: 2 }],
  });

  await check(results, "order_create", "订单库存", 7, async () => {
    const created = await request(`${apiBase}/api/orders`, { method: "POST", headers: { "Idempotency-Key": "order-case-001" }, json: orderPayload() });
    assert([200, 201].includes(created.response.status), `下单失败：${created.response.status}`);
    assert(created.body.id && created.body.status === "pending_payment", "订单状态或 ID 错误");
    assert(Number.isFinite(created.body.total) && created.body.total === round(product.salePrice * 2), "服务端订单总价错误");
    order = created.body;
  });

  await check(results, "order_idempotent_replay", "订单库存", 5, async () => {
    const replay = await request(`${apiBase}/api/orders`, { method: "POST", headers: { "Idempotency-Key": "order-case-001" }, json: orderPayload() });
    assert(replay.response.ok && replay.body.id === order.id, "相同幂等键没有返回原订单");
  });

  await check(results, "order_idempotency_conflict", "订单库存", 4, async () => {
    const conflictPayload = orderPayload();
    conflictPayload.items[0].quantity = 1;
    const conflict = await request(`${apiBase}/api/orders`, { method: "POST", headers: { "Idempotency-Key": "order-case-001" }, json: conflictPayload });
    assert(conflict.response.status === 409, `相同 key 不同载荷应返回 409，实际 ${conflict.response.status}`);
  });

  await check(results, "inventory_guard", "订单库存", 4, async () => {
    const payload = orderPayload();
    payload.items[0].quantity = 999999;
    const insufficient = await request(`${apiBase}/api/orders`, { method: "POST", headers: { "Idempotency-Key": "order-case-stock" }, json: payload });
    assert([409, 422].includes(insufficient.response.status), "库存不足未被拒绝");
  });

  await check(results, "webhook_invalid_signature", "Webhook", 5, async () => {
    const before = await request(`${apiBase}/api/orders/${order.id}`);
    const invalid = await request(`${apiBase}/api/webhooks/payment`, { method: "POST", headers: { "x-event-id": "pay-invalid-1", "x-webhook-signature": "invalid" }, json: { orderId: order.id, status: "paid" } });
    assert([401, 403].includes(invalid.response.status), "无效签名未被拒绝");
    const after = await request(`${apiBase}/api/orders/${order.id}`);
    assert(after.body.status === before.body.status, "无效签名改变了订单状态");
  });

  await check(results, "payment_webhook", "Webhook", 5, async () => {
    const raw = JSON.stringify({ orderId: order.id, status: "paid" });
    const accepted = await signedWebhook("payment", "pay-valid-1", raw);
    assert(accepted.response.ok, `支付回调失败：${accepted.response.status}`);
    const current = await request(`${apiBase}/api/orders/${order.id}`);
    assert(["paid", "fulfilling"].includes(current.body.status), "支付后订单状态错误");
  });

  await check(results, "webhook_replay", "Webhook", 3, async () => {
    const raw = JSON.stringify({ orderId: order.id, status: "paid" });
    const replay = await signedWebhook("payment", "pay-valid-1", raw);
    assert(replay.response.ok, "重复 Webhook 应幂等成功");
    const metrics = await request(`${apiBase}/api/metrics`);
    assert(metrics.body.webhooks.duplicates >= 1, "未记录重复 Webhook 指标");
  });

  await check(results, "shipment_webhook", "Webhook", 2, async () => {
    const raw = JSON.stringify({ orderId: order.id, status: "delivered", trackingNumber: "ALLY20260820001" });
    const accepted = await signedWebhook("shipment", "ship-valid-1", raw);
    assert(accepted.response.ok, "物流送达回调失败");
    const current = await request(`${apiBase}/api/orders/${order.id}`);
    assert(current.body.status === "delivered", "订单未进入 delivered");
    assert(Array.isArray(current.body.timeline) && current.body.timeline.length >= 3, "订单缺少状态时间线");
  });

  await check(results, "external_retry", "网络与钩子", 6, async () => {
    const probe = await request(`${apiBase}/api/admin/external-probe`, { method: "POST" });
    assert(probe.response.ok && probe.body.ok === true && probe.body.attempts >= 3, "不稳定服务未通过有界重试恢复");
    const metrics = await request(`${apiBase}/api/metrics`);
    assert(metrics.body.external.retries >= 2, "重试指标未增加");
  });

  await check(results, "hook_audit", "网络与钩子", 4, async () => {
    const audit = await request(`${apiBase}/api/audit?type=hook`);
    const serialized = JSON.stringify(audit.body);
    for (const name of ["after_catalog_sync", "after_product_published", "after_order_paid", "after_shipment_delivered"]) {
      assert(serialized.includes(name), `缺少钩子审计：${name}`);
    }
  });

  await check(results, "support_followup_job", "客服与作业", 10, async () => {
    const ticket = await request(`${apiBase}/api/support/tickets`, { method: "POST", json: { orderId: order.id, subject: "包装反馈", priority: "normal", message: "需要回访" } });
    assert([200, 201].includes(ticket.response.status) && ticket.body.id, "客服工单创建失败");
    const firstRun = await request(`${apiBase}/api/jobs/run`, { method: "POST" });
    const secondRun = await request(`${apiBase}/api/jobs/run`, { method: "POST" });
    assert(firstRun.response.ok && secondRun.response.ok, "作业运行失败");
    const mockMetrics = await request(`${mockBase}/__control/metrics`);
    assert(mockMetrics.body.notifications === 1, `回访通知应只发送一次，实际 ${mockMetrics.body.notifications}`);
  });

  await check(results, "cache_observability", "缓存与观测", 10, async () => {
    for (let index = 0; index < 20; index++) await request(`${apiBase}/api/products`);
    const metrics = await request(`${apiBase}/api/metrics`);
    const cache = metrics.body.cache;
    assert(Number.isFinite(cache.hits) && Number.isFinite(cache.misses) && Number.isFinite(cache.hitRate), "缓存指标结构无效");
    assert(cache.hitRate >= 0.8, `业务缓存命中率 ${cache.hitRate} 低于 0.80`);
    assert(metrics.body.external && metrics.body.webhooks && metrics.body.jobs, "指标分类不完整");
  });

  await check(results, "frontend_routes", "前端", 10, async () => {
    for (const pathname of ["/", "/products", "/orders", "/support", "/automation"]) {
      const response = await fetch(`${webBase}${pathname}`, { signal: AbortSignal.timeout(3_000) });
      const html = await response.text();
      assert(response.ok && html.length >= 100 && /<html|<div/i.test(html), `前端路由 ${pathname} 不可用`);
    }
  });

  return results;
}

async function signedWebhook(kind, eventId, raw) {
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return request(`${apiBase}/api/webhooks/${kind}`, { method: "POST", headers: { "x-event-id": eventId, "x-webhook-signature": signature }, raw });
}

async function request(url, options = {}) {
  const headers = { accept: "application/json", ...options.headers };
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = options.raw;
  }
  const response = await fetch(url, { method: options.method ?? "GET", headers, body, signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { response, body: parsed };
}

async function check(results, id, section, points, action) {
  try {
    await action();
    results.push({ id, section, points, earned: points, passed: true, detail: "通过" });
  } catch (error) {
    results.push({ id, section, points, earned: 0, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
