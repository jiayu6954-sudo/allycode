import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.MOCK_PORT ?? 4400);

export function createMockServer() {
  const state = freshState();
  const paymentByKey = new Map();
  const notificationByKey = new Map();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (request.method === "POST" && url.pathname === "/__control/reset") {
      Object.assign(state, freshState());
      paymentByKey.clear();
      notificationByKey.clear();
      return send(200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/__control/metrics") {
      return send(200, { ...state, payments: paymentByKey.size, notifications: notificationByKey.size });
    }
    if (request.method === "GET" && url.pathname === "/supplier/v1/products") {
      state.supplierRequests++;
      if (request.headers["x-api-key"] !== "challenge-supplier-key") return send(401, { error: "invalid_supplier_key" });
      if (request.headers["if-none-match"] === '"catalog-v1"') {
        state.supplierConditional++;
        response.writeHead(304, { etag: '"catalog-v1"' });
        return response.end();
      }
      return send(200, { items: catalog }, { etag: '"catalog-v1"' });
    }
    if (request.method === "GET" && url.pathname === "/unstable/v1/ping") {
      state.unstableCalls++;
      if (state.unstableCalls <= 2) return send(503, { error: "temporary_unavailable", attempt: state.unstableCalls });
      return send(200, { ok: true, attempt: state.unstableCalls });
    }
    if (request.method === "POST" && url.pathname === "/payment/v1/intents") {
      state.paymentRequests++;
      const key = String(request.headers["idempotency-key"] ?? "");
      if (!key) return send(400, { error: "missing_idempotency_key" });
      const existing = paymentByKey.get(key);
      if (existing) return send(200, existing);
      const body = await readJson(request).catch(() => null);
      if (!body) return send(400, { error: "invalid_json" });
      const created = { id: `pay_${paymentByKey.size + 1}`, status: "created", amount: body.amount };
      paymentByKey.set(key, created);
      return send(201, created);
    }
    if (request.method === "GET" && url.pathname === "/shipping/v1/quote") {
      state.shippingRequests++;
      return send(200, { carrier: "ALLY-EXPRESS", fee: 12.5, etaDays: 3 });
    }
    if (request.method === "POST" && url.pathname === "/notification/v1/messages") {
      state.notificationRequests++;
      const key = String(request.headers["idempotency-key"] ?? "");
      if (!key) return send(400, { error: "missing_idempotency_key" });
      const existing = notificationByKey.get(key);
      if (existing) return send(200, existing);
      const created = { id: `msg_${notificationByKey.size + 1}`, accepted: true };
      notificationByKey.set(key, created);
      return send(202, created);
    }
    return send(404, { error: "mock_route_not_found", path: url.pathname });
  });
}

function freshState() {
  return {
    supplierRequests: 0,
    supplierConditional: 0,
    unstableCalls: 0,
    paymentRequests: 0,
    shippingRequests: 0,
    notificationRequests: 0,
  };
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || "{}");
}

const catalog = [
  { sku: "ALLY-LAMP-001", name: "智能护眼台灯", cost: 120, stock: 24, category: "home" },
  { sku: "ALLY-HUB-002", name: "七合一桌面扩展坞", cost: 210.55, stock: 15, category: "digital" },
  { sku: "ALLY-CHAIR-003", name: "人体工学办公椅", cost: 899, stock: 6, category: "office" },
];

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const server = createMockServer();
  server.listen(port, host, () => console.log(`OmniTrade mock services listening on http://${host}:${port}`));
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
