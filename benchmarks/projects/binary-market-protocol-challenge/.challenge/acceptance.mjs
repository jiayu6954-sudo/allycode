import crypto from "node:crypto";

const apiBase = process.env.TARGET_API ?? "http://127.0.0.1:4310";
const webBase = process.env.TARGET_WEB ?? "http://127.0.0.1:4174";
const oracleSecret = process.env.ORACLE_SECRET ?? "challenge-oracle-secret";

export async function runAcceptance() {
  const results = [];
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  let market;
  let yesTrade;

  await check(results, "health_local_boundary", "基础运行", 6, async () => {
    const { response, body } = await request(`${apiBase}/health`);
    assert(response.status === 200 && body.status === "ok", "健康检查未返回 status=ok");
    assert(body.mode === "local_only", `运行模式必须是 local_only，实际 ${body.mode}`);
    assert(body.dependencies && typeof body.dependencies === "object", "缺少 dependencies 状态");
  });

  const marketPayload = {
    slug: `solana-throughput-${suffix}`,
    question: "本地验证器在目标窗口内是否达到吞吐阈值？",
    closesAt: new Date(Date.now() + 3_600_000).toISOString(),
    creator: `creator-${suffix}`,
    volumeThreshold: 1,
    creatorBonusBps: 100,
  };

  await check(results, "market_create_idempotency", "建市与幂等", 8, async () => {
    const first = await request(`${apiBase}/api/markets`, { method: "POST", headers: { "Idempotency-Key": `market-${suffix}` }, json: marketPayload });
    assert([200, 201].includes(first.response.status), `建市失败：${first.response.status}`);
    market = first.body;
    assert(market.id && market.status === "open", "市场 ID 或状态无效");
    assert(Number.isSafeInteger(market.yesPriceBps) && Number.isSafeInteger(market.noPriceBps), "价格必须是安全整数");
    const replay = await request(`${apiBase}/api/markets`, { method: "POST", headers: { "Idempotency-Key": `market-${suffix}` }, json: marketPayload });
    assert(replay.response.ok && replay.body.id === market.id, "相同建市请求没有幂等返回原市场");
    const conflict = await request(`${apiBase}/api/markets`, { method: "POST", headers: { "Idempotency-Key": `market-${suffix}` }, json: { ...marketPayload, question: "不同问题" } });
    assert(conflict.response.status === 409, `幂等键载荷冲突应返回 409，实际 ${conflict.response.status}`);
  });

  await check(results, "market_validation", "建市与幂等", 4, async () => {
    const invalid = await request(`${apiBase}/api/markets`, { method: "POST", headers: { "Idempotency-Key": `invalid-${suffix}` }, json: { ...marketPayload, slug: `invalid-${suffix}`, closesAt: new Date(Date.now() - 60_000).toISOString(), creatorBonusBps: 20_000 } });
    assert([400, 422].includes(invalid.response.status), "过去关闭时间和非法奖励费率未被拒绝");
  });

  await check(results, "liquidity_idempotency", "流动性与定价", 6, async () => {
    const payload = { provider: `lp-${suffix}`, amount: 1_000_000 };
    const first = await request(`${apiBase}/api/markets/${market.id}/liquidity`, { method: "POST", headers: { "Idempotency-Key": `lp-${suffix}` }, json: payload });
    assert([200, 201].includes(first.response.status), `注入流动性失败：${first.response.status}`);
    const replay = await request(`${apiBase}/api/markets/${market.id}/liquidity`, { method: "POST", headers: { "Idempotency-Key": `lp-${suffix}` }, json: payload });
    assert(replay.response.ok, "流动性幂等重放失败");
    const current = await getMarket(market.id);
    assert(Number.isSafeInteger(current.liquidity) && current.liquidity >= 1_000_000, "流动性不是安全整数或未入账");
  });

  await check(results, "price_invariants", "流动性与定价", 6, async () => {
    const current = await getMarket(market.id);
    assert(current.yesPriceBps + current.noPriceBps === 10_000, `YES/NO 价格和应为 10000，实际 ${current.yesPriceBps + current.noPriceBps}`);
    for (const value of [current.yesPriceBps, current.noPriceBps, current.totalVolume, current.liquidity]) {
      assert(Number.isSafeInteger(value) && value >= 0, "市场数值必须是非负安全整数");
    }
  });

  const buyPayload = { trader: `buyer-${suffix}`, outcome: "YES", side: "buy", shares: 10_000, maxCost: 1_000_000 };
  await check(results, "trade_pricing_idempotency", "交易安全", 8, async () => {
    const first = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `buy-${suffix}` }, json: buyPayload });
    assert([200, 201].includes(first.response.status), `买入失败：${first.response.status}`);
    yesTrade = first.body;
    assert(yesTrade.id && Number.isSafeInteger(yesTrade.cost) && yesTrade.cost > 0, "服务端未返回有效整数 cost");
    const before = await getMarket(market.id);
    const replay = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `buy-${suffix}` }, json: buyPayload });
    const after = await getMarket(market.id);
    assert(replay.response.ok && replay.body.id === yesTrade.id, "相同交易未返回原交易");
    assert(after.totalVolume === before.totalVolume, "幂等重放重复增加成交量");
  });

  await check(results, "trade_attack_guards", "交易安全", 8, async () => {
    const slippage = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `slip-${suffix}` }, json: { ...buyPayload, trader: `slip-${suffix}`, maxCost: 0 } });
    assert([409, 422].includes(slippage.response.status), "买入滑点上限未生效");
    const oversell = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `oversell-${suffix}` }, json: { trader: `empty-${suffix}`, outcome: "YES", side: "sell", shares: 1, minProceeds: 0 } });
    assert([409, 422].includes(oversell.response.status), "无持仓卖出未被拒绝");
    const invalid = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `enum-${suffix}` }, json: { ...buyPayload, outcome: "MAYBE" } });
    assert([400, 422].includes(invalid.response.status), "非法 outcome 未被拒绝");
  });

  const resolution = { outcome: "YES", resolvedAt: new Date().toISOString() };
  await check(results, "oracle_reject_no_side_effect", "预言机结算", 5, async () => {
    const before = await getMarket(market.id);
    const invalid = await request(`${apiBase}/api/markets/${market.id}/resolve`, { method: "POST", headers: { "x-oracle-event-id": `bad-${suffix}`, "x-oracle-signature": "invalid" }, json: resolution });
    assert([401, 403].includes(invalid.response.status), "非法预言机签名未被拒绝");
    const after = await getMarket(market.id);
    assert(after.status === before.status && !after.outcome, "非法签名改变了市场状态");
  });

  await check(results, "oracle_replay_and_finality", "预言机结算", 9, async () => {
    const first = await signedResolution(market.id, `resolve-${suffix}`, resolution);
    assert(first.response.ok && first.body.status === "resolved" && first.body.outcome === "YES", `有效结算失败：${first.response.status}`);
    const replay = await signedResolution(market.id, `resolve-${suffix}`, resolution);
    assert(replay.response.ok && replay.body.outcome === "YES", "相同预言机事件未幂等成功");
    const changed = await signedResolution(market.id, `change-${suffix}`, { outcome: "NO", resolvedAt: new Date().toISOString() });
    assert([409, 422].includes(changed.response.status), "已结算结果仍可被更改");
    const closedTrade = await request(`${apiBase}/api/markets/${market.id}/trades`, { method: "POST", headers: { "Idempotency-Key": `closed-${suffix}` }, json: { ...buyPayload, trader: `late-${suffix}` } });
    assert([409, 422].includes(closedTrade.response.status), "结算后仍允许交易");
  });

  await check(results, "winner_claim_once", "领取与激励", 6, async () => {
    const payload = { owner: `buyer-${suffix}` };
    const first = await request(`${apiBase}/api/markets/${market.id}/claims`, { method: "POST", headers: { "Idempotency-Key": `claim-${suffix}` }, json: payload });
    assert([200, 201].includes(first.response.status) && first.body.status === "paid" && Number.isSafeInteger(first.body.amount) && first.body.amount > 0, "胜方领取失败");
    const replay = await request(`${apiBase}/api/markets/${market.id}/claims`, { method: "POST", headers: { "Idempotency-Key": `claim-${suffix}` }, json: payload });
    assert(replay.response.ok && replay.body.amount === first.body.amount, "领取幂等失败");
    const loser = await request(`${apiBase}/api/markets/${market.id}/claims`, { method: "POST", headers: { "Idempotency-Key": `loser-${suffix}` }, json: { owner: `empty-${suffix}` } });
    assert([404, 409, 422].includes(loser.response.status), "无胜方持仓账户可以领取");
  });

  await check(results, "creator_bonus_once", "领取与激励", 4, async () => {
    const current = await getMarket(market.id);
    assert(current.creatorBonus && current.creatorBonus.unlocked === true, "成交量达到阈值后创建者奖励未解锁");
    assert(Number.isSafeInteger(current.creatorBonus.amount) && current.creatorBonus.amount >= 0, "创建者奖励金额无效");
  });

  await check(results, "ordered_domain_events", "事件与观测", 6, async () => {
    const events = await request(`${apiBase}/api/events?marketId=${encodeURIComponent(market.id)}`);
    assert(events.response.ok && Array.isArray(events.body.items), "事件接口无效");
    const sequences = events.body.items.map((item) => item.sequence);
    assert(sequences.every((value, index) => Number.isSafeInteger(value) && (index === 0 || value > sequences[index - 1])), "事件 sequence 不是严格递增");
    const types = new Set(events.body.items.map((item) => item.type));
    for (const type of ["market.created", "liquidity.deposited", "trade.executed", "market.resolved", "claim.paid", "creator_bonus.unlocked"]) {
      assert(types.has(type), `缺少领域事件 ${type}`);
    }
  });

  await check(results, "cache_and_metrics", "事件与观测", 6, async () => {
    for (let index = 0; index < 20; index += 1) await getMarket(market.id);
    const metrics = await request(`${apiBase}/api/metrics`);
    const cache = metrics.body.cache;
    assert(Number.isSafeInteger(cache?.hits) && Number.isSafeInteger(cache?.misses) && Number.isFinite(cache?.hitRate), "缓存指标结构无效");
    assert(cache.hitRate >= 0.75, `预热后缓存命中率 ${cache.hitRate} 低于 0.75`);
    assert(metrics.body.idempotency?.replays >= 3 && metrics.body.idempotency?.conflicts >= 1, "幂等观测指标不完整");
    assert(metrics.body.oracle?.replays >= 1 && metrics.body.oracle?.rejected >= 1, "预言机观测指标不完整");
    assert(metrics.body.events?.published >= 6, "事件发布指标无效");
  });

  await check(results, "frontend_routes", "中文前端", 10, async () => {
    const pages = [["/", "总览"], ["/markets", "市场"], ["/portfolio", "组合"], ["/activity", "活动"], ["/risk", "风险"]];
    for (const [pathname, label] of pages) {
      const response = await fetch(`${webBase}${pathname}`, { signal: AbortSignal.timeout(3_000) });
      const html = await response.text();
      assert(response.ok && html.length >= 150 && /<html|<div/i.test(html), `前端路由 ${pathname} 不可用`);
      assert(html.includes(label) || html.includes("root"), `前端路由 ${pathname} 缺少 ${label} 页面证据`);
    }
    const risk = await (await fetch(`${webBase}/risk`, { signal: AbortSignal.timeout(3_000) })).text();
    assert(/本地|devnet|风险|测试/.test(risk), "风险页缺少本地测试/风险边界说明");
  });

  return results;
}

async function getMarket(id) {
  const current = await request(`${apiBase}/api/markets/${encodeURIComponent(id)}`);
  assert(current.response.ok, `读取市场失败：${current.response.status}`);
  return current.body;
}

async function signedResolution(marketId, eventId, body) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", oracleSecret).update(raw).digest("hex");
  return request(`${apiBase}/api/markets/${marketId}/resolve`, { method: "POST", headers: { "x-oracle-event-id": eventId, "x-oracle-signature": signature }, raw });
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
