// dsh-peak-indicator host plugin.
//
// Provides:
//  1. The `peakCost` session projection (key "peakCost") that replays the
//     session log and accumulates actual token usage into costs, priced with
//     the price list in effect at each event's own timestamp: the USD-only flat legacy
//     DeepSeek prices before 2026-08-17, the V4 peak/off-peak price list from
//     2026-08-17, and the V4.1-Flash price list from 2026-09-10 onward.
//  2. Pure helpers (currentPeriod, periodAt, priceFor, ...) exported for the
//     browser half and the test suite.
//
// Policy (official DeepSeek price page):
//   before 2026-08-17: USD-only flat legacy prices; CNY requires explicit overrides
//   from   2026-08-17: peak = Beijing 09:00-12:00 and 14:00-18:00
//                      offpeak = every other minute, billed at half the peak price
//   from   2026-08-23: Saturday and Sunday (Beijing time) are off-peak all day
//   from   2026-09-10 12:00 Beijing: V4.1-Flash prices apply to Flash aliases
import fs from "node:fs";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";

import {
  DEFAULT_PEAK_WINDOWS, BEIJING_OFFSET_MINUTES, OFF_PEAK_DISCOUNT,
  LEGACY_PRICES, MODEL_PRICES, OTHER_MODEL_PRICES, CHINA_HOLIDAY_DATES,
  beijingMinutes, beijingDay, billingPeriod as currentPeriod, isDeepseekModel,
  periodAt, effectiveNewPrices, priceFor, resolveModelPrice
} from "./pricing.js";

/** Host configuration: all fields optional; policy defaults track the official announcement. */
const Config = z.object({
  currency: z.union([z.const("CNY"), z.const("USD")]).default("CNY"),
  peakWindows: z.array(z.tuple([z.number(), z.number()])).default(DEFAULT_PEAK_WINDOWS),
  beijingOffsetMinutes: z.number().default(BEIJING_OFFSET_MINUTES),
  offPeakDiscount: z.number().default(OFF_PEAK_DISCOUNT),
  policyEffectiveDate: z.string().default("2026-08-17T00:00:00+08:00"),
  weekendOffPeakEffectiveDate: z.string().default("2026-08-23T00:00:00+08:00"),
  v41FlashEffectiveDate: z.string().default("2026-09-10T12:00:00+08:00"),
  holidayDates: z.array(z.string()).default(CHINA_HOLIDAY_DATES),
  prices: z.dict(z.object({
    input: z.number(),
    output: z.number(),
    cacheHitInput: z.number()
  })).default({}),
  pricesCny: z.dict(z.object({
    input: z.number(),
    output: z.number(),
    cacheHitInput: z.number()
  })).default({}),
  /*
   * 视为「中转站」的域名列表（含子域）。余额卡据此判定当前路由走的是官方
   * 账户还是中转站：命中则显示中转站额度，否则显示官方账户余额。
   */
  relayHosts: z.array(z.string()).default(["queqiaoapi.com"])
});

/** Projection value schema (validated by the session-projection registry). */
const projectionSchema = zod.object({
  currency: zod.string(),
  totalCost: zod.number().nonnegative(),
  byModel: zod.record(zod.string(), zod.object({
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative()
  }).strict()),
  messageCosts: zod.record(zod.string(), zod.object({
    provider: zod.string(),
    model: zod.string(),
    turn: zod.number().int().nonnegative(),
    period: zod.string(),
    // 这条 usage 计价时走的通道："official"（官方峰谷价）或 "relay"（中转平价）。
    // 中转没有峰谷语义，浏览器据此决定徽标文案与配色。
    channel: zod.union([zod.literal("official"), zod.literal("relay")]),
    cost: zod.number().nonnegative()
  }).strict())
}).strict();

/** Internal fold state persisted by the session-projection cache. */
const projectionStateSchema = zod.object({
  provider: zod.string().nullable(),
  model: zod.string().nullable(),
  /*
   * 最近一次请求头记录的通道（"official" / "relay"），在 request/header 时固化。
   * 投影重放历史事件时按这个值计价，而不是用当前路由表重新判定，否则用户中途
   * 改路由会把历史费用一并改写。
   */
  channel: zod.union([zod.literal("official"), zod.literal("relay")]).nullable(),
  byModel: zod.record(zod.string(), zod.object({
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative()
  }).strict()),
  messageCosts: zod.record(zod.string(), zod.object({
    provider: zod.string(),
    model: zod.string(),
    turn: zod.number().int().nonnegative(),
    period: zod.string(),
    // 这条 usage 计价时走的通道："official"（官方峰谷价）或 "relay"（中转平价）。
    // 中转没有峰谷语义，浏览器据此决定徽标文案与配色。
    channel: zod.union([zod.literal("official"), zod.literal("relay")]),
    cost: zod.number().nonnegative()
  }).strict()),
  last: zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    buckets: zod.object({
      uncachedInputTokens: zod.number().int().nonnegative(),
      outputTokens: zod.number().int().nonnegative(),
      cacheReadTokens: zod.number().int().nonnegative(),
      cacheWriteTokens: zod.number().int().nonnegative()
    }).strict()
  }).strict().nullable()
}).strict();


/*
 * 中转站（queqiaoapi.com）价格表 —— 2026-10-25 从该站 /api/pricing 实测抓取。
 *
 * 计价公式（New API 通用）：
 *   输入 = model_ratio × 2 × group_ratio   元/1M
 *   输出 = 输入 × completion_ratio
 *   缓存 = 输入 × cache_ratio
 * 校验：deepseek-flash 由该式得 0.48 / 1.92；实测扣费反解为 0.474 / 1.9202（误差 <1.3%）。
 *
 * 同名模型在 max 与 kiro 分组价差 2.9 倍（group_ratio 1.56 vs 0.54），
 * 所以按 **路由** 分组，不能只按模型名查表。
 *
 * 未收录：带 `billing_expr` 自定义阶梯计费的模型（6 个 GPT 全部 + claude-haiku-5-5）。
 * 那些系数不是 model_ratio，实测标定未收敛（同一份 usage 反解出相差 3.2 倍的两种结论），
 * 与其显示可能偏 300% 的数字，不如不显示花费。
 */
const RELAY_PRICES = {
  "deepseek-official": {
    "deepseek-flash": { input: 0.48, output: 1.92, cacheHitInput: 0.0096 },
    "deepseek-v4-pro": { input: 2.16, output: 6.48, cacheHitInput: 0.072 },
  },
  "gpt": {
  },
  "claude-max": {
    "claude-fable-5": { input: 15.6, output: 78.0, cacheHitInput: 2.808 },
    "claude-fable-5-1": { input: 15.6, output: 78.0, cacheHitInput: 0.702 },
    "claude-opus-5-5": { input: 6.24, output: 31.2, cacheHitInput: 0.5616 },
    "claude-sonnet-5-5": { input: 3.12, output: 15.6, cacheHitInput: 0.5616 },
    "claude-opus-4-6": { input: 7.8, output: 39.0, cacheHitInput: 1.404 },
    "claude-opus-4-7": { input: 7.8, output: 39.0, cacheHitInput: 1.404 },
    "claude-opus-4-8": { input: 7.8, output: 39.0, cacheHitInput: 1.404 },
    "claude-opus-5": { input: 7.8, output: 39.0, cacheHitInput: 1.404 },
    "claude-sonnet-4-6": { input: 4.68, output: 23.4, cacheHitInput: 0.8424 },
    "claude-sonnet-5": { input: 3.12, output: 15.6, cacheHitInput: 0.5616 },
  },
  "claude-kiro": {
    "claude-fable-5": { input: 5.4, output: 27.0, cacheHitInput: 0.972 },
    "claude-fable-5-1": { input: 5.4, output: 27.0, cacheHitInput: 0.243 },
    "claude-opus-5-5": { input: 2.16, output: 10.8, cacheHitInput: 0.1944 },
    "claude-opus-4-6": { input: 2.7, output: 13.5, cacheHitInput: 0.486 },
    "claude-opus-4-7": { input: 2.7, output: 13.5, cacheHitInput: 0.486 },
    "claude-opus-4-8": { input: 2.7, output: 13.5, cacheHitInput: 0.486 },
    "claude-opus-5": { input: 2.7, output: 13.5, cacheHitInput: 0.486 },
    "claude-sonnet-4-6": { input: 1.62, output: 8.1, cacheHitInput: 0.2916 },
    "claude-sonnet-5": { input: 1.08, output: 5.4, cacheHitInput: 0.1944 },
    "claude-haiku-4-5": { input: 0.54, output: 2.7, cacheHitInput: 0.0972 },
    "claude-haiku-4-5-20251001": { input: 0.54, output: 2.7, cacheHitInput: 0.0972 },
    "claude-opus-4-5-20251101": { input: 2.7, output: 13.5, cacheHitInput: 0.486 },
    "claude-sonnet-4-5-20250929": { input: 1.62, output: 8.1, cacheHitInput: 0.2916 },
  },
};

/**
 * 查一条中转路由上某个模型的单价。
 * @param provider - 路由名（如 claude-kiro）。
 * @param model - 模型 id。
 * @returns {{input,output,cacheHitInput}} 或 null（该模型未收录，不估算）。
 */
function relayPriceFor(provider, model) {
  const table = RELAY_PRICES[provider];
  if (table === undefined) return null;
  const id = String(model ?? "").toLowerCase();
  if (Object.hasOwn(table, id)) return table[id];
  /*
   * 带日期后缀的别名回退：`claude-haiku-4-5-20251001` → `claude-haiku-4-5`。
   * 只接受「键 + '-'」这种边界，避免 `claude-fable-5` 误吃 `claude-fable-50`
   * 这类前缀重合；最长优先，保证更具体的键先命中。
   */
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (id.startsWith(`${key}-`)) return table[key];
  }
  return null;
}
/** Selected-currency cost for a usage record at the given per-1M prices. */
function priceUsage(price, usage) {
  const input = price?.input ?? 0;
  const output = price?.output ?? 0;
  const cacheHitInput = price?.cacheHitInput ?? 0;
  return (usage.inputTokens * input + usage.outputTokens * output + (usage.cacheReadTokens ?? 0) * cacheHitInput) / 1e6;
}

/**
 * Create the "peakCost" session projection: replays request/header and usage
 * events, prices each event's tokens at the rates in effect at its own time,
 * and exposes the session total, per-model buckets and per-message costs.
 *
 * 两种计价来源，按路由区分：
 *  - 走中转站的路由：用 `RELAY_PRICES` 里的中转价（全天平价，无峰谷折扣）。
 *  - 走官方账户的路由：沿用官方峰谷价（`priceFor`）。
 * 中转价缺失（GPT 那类自定义计费模型）时**不估算**，该条 usage 直接跳过，
 * 宁可少一个数字，也不显示可能偏几百个百分点的错数。
 * @param config - 插件配置。
 * @param isRelayRoute - 判断某条路由此刻是否走中转站。
 */
function createPeakCostProjection(config, isRelayRoute) {
  const currency = config.currency ?? "CNY";
  const relayed = typeof isRelayRoute === "function" ? isRelayRoute : () => false;
  const stateSchema = projectionStateSchema.extend({currency: zod.literal(currency)}).strict();
  const viewSchema = projectionSchema.extend({currency: zod.literal(currency)}).strict();
  return {
    key: "peakCost",
    // Kept for DSH releases that used the pre-rc.2 projection field name.
    schema: viewSchema,
    stateSchema,
    init: () => ({
      currency,
      provider: null,
      model: null,
      channel: null,
      byModel: {},
      messageCosts: {},
      last: null
    }),
    apply: (state, event) => {
      if (event.type === "request/header") {
        const headerConfig = event.data.header.config;
        if (typeof headerConfig !== "object" || headerConfig === null) return state;
        const provider = headerConfig.provider;
        const model = headerConfig.model;
        if (typeof provider !== "string" || typeof model !== "string" || provider.length === 0 || model.length === 0) return state;
        /*
         * 通道在请求时固化进状态，而不是每次重放时重新判定。
         *
         * 投影会重放历史事件：如果用户在会话中途把某条路由的 baseURL 从官方改成
         * 中转（或反过来），用「当前」路由表去重算「过去」的用量，历史费用会被
         * 悄悄改写。所以在记录 provider/model 的同时记录当时的通道。
         */
        const channel = relayed(provider) ? "relay" : "official";
        if (state.provider === provider && state.model === model && state.channel === channel) return state;
        return { ...state, provider, model, channel };
      }
      let turn;
      let step;
      let usage;
      let messageId;
      if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
        turn = event.data.turn;
        step = event.data.step;
        usage = event.data.chunk.usage;
      } else if (event.type === "assistant/message" && event.data.usage !== void 0) {
        turn = event.data.turn;
        step = event.data.step;
        usage = event.data.usage;
        messageId = event.data.message?.id;
      } else {
        return state;
      }
      const provider = state.provider;
      const model = state.model;
      const modelKey = typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : model ?? "unknown";
      const period = periodAt(event.time ?? Date.now(), config);
      /*
       * 按「这条请求当时记录的通道」计价（state.channel 在 request/header 时固化），
       * 而不是按当前路由表重新判定 —— 后者会把历史费用按新路由改写。
       * 中转价查不到（GPT 这类自定义计费模型）就返回 null ⇒ 不估算这条 usage。
       */
      const price = state.channel === "relay"
        ? relayPriceFor(provider, model)
        : priceFor(model, period, event.time ?? Date.now(), config);
      if (price === null) return state;
      const cost = priceUsage(price, usage);
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last.buckets : void 0;
      const previousCost = previous === void 0 ? 0 : priceUsage(price, {
        inputTokens: previous.uncachedInputTokens,
        outputTokens: previous.outputTokens,
        cacheReadTokens: previous.cacheReadTokens,
        cacheWriteTokens: previous.cacheWriteTokens
      });
      const prior = state.byModel[modelKey];
      const nextBucket = {
        uncachedInputTokens: (prior?.uncachedInputTokens ?? 0) - (previous?.uncachedInputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) - (previous?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (prior?.cacheReadTokens ?? 0) - (previous?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (prior?.cacheWriteTokens ?? 0) - (previous?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        cost: Math.max(0, (prior?.cost ?? 0) - previousCost + cost)
      };
      return {
        ...state,
        last: {
          turn,
          step,
          buckets: {
            uncachedInputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cacheWriteTokens ?? 0
          }
        },
        byModel: {
          ...state.byModel,
          [modelKey]: nextBucket
        },
        ...messageId !== void 0 ? {
          messageCosts: {
            ...state.messageCosts,
            [messageId]: {
              provider,
              model,
              turn,
              period,
              // 用那条请求记录下来的通道，而不是此刻重新判定。
              channel: state.channel ?? (relayed(provider) ? "relay" : "official"),
              cost
            }
          }
        } : {}
      };
    },
    wire: {
      viewSchema,
      view: (state) => {
      let totalCost = 0;
      const byModel = {};
      for (const [key, bucket] of Object.entries(state.byModel)) {
        byModel[key] = {
          uncachedInputTokens: bucket.uncachedInputTokens,
          outputTokens: bucket.outputTokens,
          cacheReadTokens: bucket.cacheReadTokens,
          cacheWriteTokens: bucket.cacheWriteTokens,
          cost: bucket.cost
        };
        totalCost += bucket.cost;
      }
        return {
          currency: state.currency,
          totalCost,
          byModel,
          messageCosts: state.messageCosts
        };
      }
    },
    // Kept as a read-side alias for older DSH releases and the pure-fold test
    // harness. rc.2 uses wire.view above.
    view: (state) => {
      let totalCost = 0;
      const byModel = {};
      for (const [key, bucket] of Object.entries(state.byModel)) {
        byModel[key] = {
          uncachedInputTokens: bucket.uncachedInputTokens,
          outputTokens: bucket.outputTokens,
          cacheReadTokens: bucket.cacheReadTokens,
          cacheWriteTokens: bucket.cacheWriteTokens,
          cost: bucket.cost
        };
        totalCost += bucket.cost;
      }
      return {
        currency: state.currency,
        totalCost,
        byModel,
        messageCosts: state.messageCosts
      };
    },
    // rc.2 requires explicit internal-state and wire schemas. Bump so old
    // cache rows are never treated as valid under the new projection contract.
    // 计价口径变了（官方价 → 按路由分官方/中转两套价），必须提升版本，
    // 否则旧的会话投影缓存会被当成有效行，历史费用不会按新口径重算。
    // v10：state 新增顶层 `channel`（请求时固化的通道），旧缓存行没有该字段，
    // 不升版本会让它们被当成有效行、继续按旧口径计价。
    stateVersion: currency === "CNY" ? 10 : 9
  };
}

var name = "peak-indicator";
// Pricing is observational: no Loader, token-meter, compaction or agent hooks.
// `webServer`/`connection`/`credentials` are the balance route's carriers: the
// route is optional (a composition without a web server still gets the badge),
// so they are read with ctx.get rather than injected.
var inject = ["sessionProjections"];

/*
 * ── 中转站（第三方 relay）余额通道 ─────────────────────────────────────────
 *
 * 背景：插件原来那张余额卡读的是 DSH 登录的 DeepSeek 官方账户余额。走中转站
 * 时扣的是中转站额度、官方余额不动，所以必须按「当前走哪条通道」显示对应的账。
 *
 * 中转站是 New API 部署，提供 OpenAI 兼容的额度端点：
 *
 *   GET {base}/v1/dashboard/billing/subscription → { hard_limit_usd }  剩余额度
 *
 * 该字段就是剩余额度，数值等于人民币元（New API 的 quota_per_unit=500000 且
 * display_in_currency=true 时 1 单位 = 1 元），实测随请求实时变化。只要中转
 * key，不打模型、不消耗额度。
 *
 * 刻意不读 usage 端点：它的 total_usage 不逐请求结算（标定解出负单价），
 * 拿它算「已花多少」会给出错数。
 *
 * 官方 key 打这些端点会 401，所以「是不是中转」由配置判定而不是靠探测：
 * 只有 baseURL 命中中转域名列表的路由才算中转。判定与余额一起由
 * `/peak-indicator/relay` 返回给浏览器。
 */

/** 视为「中转站」的域名（子域匹配）。可用 Config.relayHosts 覆盖。 */
const DEFAULT_RELAY_HOSTS = ["queqiaoapi.com"];

/**
 * 单路由适配器：插件名 → 它注册的 provider 路由 id。
 *
 * 这些条目的配置里只有顶层 `baseURL`/`apiKeyEnv`，而 provider 名与条目 id
 * 并不相同（`llm-deepseek` 注册的是 `deepseek-official`），所以必须显式对应，
 * 否则「当前会话选了 deepseek-official」会被判成「不知道走哪条」。
 */
const SINGLE_ROUTE_ADAPTERS = {
  "@deepseek-ai/dsh-llm-deepseek-api-key": "deepseek-official",
  "@deepseek-ai/dsh-llm-deepseek-account": "deepseek-account"
};

/** `deepseek-account` 固定打官方源（账号 token 只对官方有效），永远不是中转。 */
const OFFICIAL_ONLY_PROVIDERS = new Set(["deepseek-account"]);

/** 余额端点一次请求的超时；失败不影响徽标，只让卡片显示读取失败。 */
const RELAY_TIMEOUT_MS = 8000;

/** 缓存时长：中转余额变动不频繁，避免每次点击都打端点。 */
const RELAY_CACHE_MS = 20000;

/** 解析 URL 的 hostname；非法输入返回 undefined。 */
function hostOf(url) {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** hostname 是否属于给定域名列表（含子域）。 */
function matchesHost(hostname, hosts) {
  if (typeof hostname !== "string") return false;
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * 从 baseURL 推导出 OpenAI 兼容的 API 根。
 * `https://relay/v1` 与 `https://relay` 都要得到 `https://relay/v1`。
 */
function apiRootOf(baseURL) {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/+$/, "");
  const trimmed = path.endsWith("/v1") ? path.slice(0, -3) : path;
  return `${url.origin}${trimmed}/v1`;
}

/**
 * 读出当前所有 provider 路由的 baseURL 与 key 引用。
 *
 * 三个来源，按可靠性从高到低，前一个拿不到就用下一个：
 *  - `configEditor.configuration()`：每个已装载条目的实时配置
 *    （`llm-pi-ai` 的 `config.providers.<route>.baseURL/apiKeyEnv`、
 *     `llm-deepseek` 的 `config.baseURL/apiKeyEnv`）。这是最直接的一份。
 *  - `settings.describe()`：Settings 表单的投影值，字段名同样是 baseURL。
 *  - `llm.listProviders()`：只有 id 与展示名（适配器不暴露 baseURL），
 *    仅用来补全「这条路由存在」这一事实。
 *
 * 注意 `listProviders()` **不**带 baseURL —— 曾经想当然地读它的 baseUrl 会
 * 永远拿到 undefined，判定就会一直退化成「官方」。只读，不写；任何来源抛错
 * 都当作「这一层没有」，绝不让徽标报错。
 */
function collectRoutes(ctx) {
  const routes = new Map();
  const remember = (provider, baseURL, keyRef) => {
    if (typeof provider !== "string" || provider.length === 0) return;
    const previous = routes.get(provider);
    if (typeof baseURL === "string" && baseURL.length > 0 && previous?.baseURL === undefined) {
      routes.set(provider, { baseURL, keyRef: previous?.keyRef });
    } else if (typeof keyRef === "string" && keyRef.length > 0 && previous !== undefined && previous.keyRef === undefined) {
      routes.set(provider, { ...previous, keyRef });
    } else if (previous === undefined) {
      routes.set(provider, { baseURL: undefined, keyRef: typeof keyRef === "string" ? keyRef : undefined });
    }
  };
  /**
   * 吸收一个配置块：可能是 pi-ai 剖面（`providers` 字典），也可能是单路由
   * 适配器的顶层 `baseURL`/`apiKeyEnv`。
   * @param config - 配置块。
   * @param entryId - Loader 条目 id（用于单路由适配器的映射）。
   * @param pluginName - 条目的插件包名（`SINGLE_ROUTE_ADAPTERS` 的键）。
   */
  const absorb = (config, entryId, pluginName) => {
    if (typeof config !== "object" || config === null) return;
    const providers = config.providers;
    if (typeof providers === "object" && providers !== null) {
      for (const [provider, profile] of Object.entries(providers)) {
        remember(provider, profile?.baseURL, profile?.apiKeyEnv);
      }
    }
    // 单路由适配器：provider 名由插件包名决定，条目 id 只是配置行的名字。
    const single = typeof pluginName === "string" ? SINGLE_ROUTE_ADAPTERS[pluginName] : undefined;
    if (single !== undefined) {
      // `llm-deepseek` 的 apiKeyEnv 在配置里通常不写，走的是适配器默认值
      // `DEEPSEEK_API_KEY`；不补这个默认值，中转余额就会因为找不到 key 而失败。
      remember(single, config.baseURL, config.apiKeyEnv ?? "DEEPSEEK_API_KEY");
    } else if (typeof entryId === "string" && entryId.length > 0) {
      remember(entryId, config.baseURL, config.apiKeyEnv);
    }
  };
  try {
    const configEditor = ctx.get("configEditor", false);
    for (const row of configEditor?.configuration?.() ?? []) {
      const id = row?.entry?.options?.id;
      const pluginName = row?.entry?.options?.name;
      absorb(row?.entry?.options?.config, id, pluginName);
      // 实时配置拿不到 baseURL 时，退到 profile 层（inherited/override）。
      const hasURL = id !== undefined && [...routes.values()].some((route) => route.baseURL !== undefined);
      if (!hasURL) {
        absorb(row?.inherited, id, pluginName);
        absorb(row?.override, id, pluginName);
      }
    }
  } catch {}
  try {
    const settings = ctx.get("settings", false);
    for (const form of settings?.describe?.({ redactSecrets: true }) ?? []) {
      absorb(form?.value, form?.ns, undefined);
    }
  } catch {}
  try {
    const llm = ctx.get("llm", false);
    for (const provider of llm?.listProviders?.() ?? []) {
      remember(provider.id, provider.baseUrl ?? provider.baseURL, undefined);
    }
  } catch {}
  /*
   * 最后一层兜底：直接读 profile 的 patch 文件。
   *
   * 上面三层都依赖「服务已就绪」——而 `ctx.get(name)` 在服务 fiber 未激活时返回
   * undefined（cordis 的 strict 语义），本插件的 apply() 可能比 llm/settings 更早
   * 执行。一旦三层全空，所有路由都会被判成「官方」，余额与费用就会全错。
   * patch 文件是确定存在的，直接从里面读 baseURL 最可靠。
   *
   * 只在「仍有路由缺 baseURL」时补，不覆盖已读到的更准确的值。
   * 只做极简 YAML 解析：目标就是抓 `baseURL:` 和 `apiKeyEnv:` 两种行，按缩进
   * 判断归属，不追求通用性。解析失败一律忽略。
   */
  const missingURL = routes.size === 0 || [...routes.values()].some((route) => route.baseURL === undefined);
  if (missingURL) {
    try {
      // 只补缺的：传入一个会跳过已有 baseURL 的 remember。
      fallbackFromPatchFile(ctx, (provider, baseURL, keyRef) => {
        const existing = routes.get(provider);
        remember(provider, existing?.baseURL === undefined ? baseURL : undefined, existing?.keyRef ?? keyRef);
      });
    } catch {}
  }
  return routes;
}

/**
 * 从 profile 的 cordis.patch.yml 里补出路由的 baseURL。
 *
 * 认两种结构：
 *   - pi-ai 剖面：`providers:` 下每个 route 一个块，块内 `baseURL:`/`apiKeyEnv:`
 *   - 单路由适配器：`- id: llm-deepseek` 块内直接的 `baseURL:`/`apiKeyEnv:`
 * @param ctx - 用于定位 DSH_HOME 的插件上下文。
 * @param remember - 收集回调。
 */
function fallbackFromPatchFile(ctx, remember) {
  const home = (() => {
    try {
      const profileContext = ctx.get("profileContext", false);
      const dir = profileContext?.patchPath;
      if (typeof dir === "string" && dir.length > 0) return dir;
    } catch {}
    const env = typeof process !== "undefined" ? process.env : undefined;
    const root = env?.DSH_HOME ?? env?.HOME;
    return typeof root === "string" && root.length > 0 ? `${root}/profiles/ondevice/cordis.patch.yml` : undefined;
  })();
  if (home === undefined) return;
  let text;
  try {
    text = fs.readFileSync(home, "utf8");
  } catch {
    return;
  }
  /*
   * 逐行扫。三种目标行：
   *   - `providers:` 下的 route 键（`gpt:` / `claude-max:`）→ currentRoute
   *   - `- id: llm-deepseek` / `name: '@deepseek-ai/dsh-llm-deepseek-api-key'`
   *     组成的单路由适配器行 → 由包名映射成真正的 provider 名
   *   - 其后的 `baseURL:` / `apiKeyEnv:`
   */
  let currentRoute = null;
  let inProviders = false;
  let providersIndent = -1;
  let singleId = null;
  let singleRoute = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^providers:\s*$/.test(trimmed)) { inProviders = true; providersIndent = indent; continue; }
    if (inProviders && indent <= providersIndent && !/^providers:/.test(trimmed)) inProviders = false;

    // `- id: llm-deepseek`：开始一条单路由适配器条目
    const idMatch = /^-\s+id:\s*(\S+)\s*$/.exec(trimmed);
    if (idMatch) {
      singleId = idMatch[1];
      singleRoute = SINGLE_ROUTE_ADAPTERS[singleId] ?? singleId;
      currentRoute = null;
      continue;
    }
    // `name: '@deepseek-ai/dsh-llm-deepseek-api-key'`：按包名映射成真正的 provider 名
    const nameMatch = /^name:\s*["']?([^"'\s]+)["']?\s*$/.exec(trimmed);
    if (nameMatch && singleId !== null) {
      singleRoute = SINGLE_ROUTE_ADAPTERS[nameMatch[1]] ?? singleId;
      continue;
    }

    // providers 下的 route 键
    if (inProviders) {
      const keyMatch = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
      if (keyMatch && indent <= providersIndent + 2) { currentRoute = keyMatch[1]; continue; }
    }

    const route = currentRoute ?? singleRoute;
    if (route === null) continue;
    const urlMatch = /^baseURL:\s*["']?([^"'\s]+)["']?\s*$/.exec(trimmed);
    if (urlMatch) { remember(route, urlMatch[1], undefined); continue; }
    const keyMatch2 = /^apiKeyEnv:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(trimmed);
    if (keyMatch2) remember(route, undefined, keyMatch2[1]);
  }
}

/**
 * 读一次中转站余额。
 *
 * New API 这两个端点的字段名有欺骗性，实测（2026-10-25，queqiaoapi.com）：
 *
 *   GET {base}/v1/dashboard/billing/subscription → { hard_limit_usd }
 *        `hard_limit_usd` 是**总额度**（这台站约 102），不是余额！它只会因为
 *        充值/调额变化，与消费无关。
 *   GET {base}/v1/dashboard/billing/usage?start_date&end_date → { total_usage }
 *        `total_usage` 是**累计已用**，单位是「分」（1 元 = 100），所以
 *        已用金额 = total_usage / 100。该站不按 start/end 过滤区间，
 *        传任何区间都返回同一个累计值。
 *
 * 因此：**余额 = hard_limit_usd − total_usage / 100**。
 * 实测校验：101.99 − 454.00/100 = 97.45，与站点后台显示的 97.68 一致。
 *
 * 这两个端点只要中转 key，不打模型、不消耗额度。
 * @param baseURL - 路由的 baseURL（带不带 /v1 都行）。
 * @param apiKey - 该路由的 key。
 * @returns {{remaining: number, total: number, used: number}}，失败时抛出。
 */
async function fetchRelayBalance(baseURL, apiKey) {
  const root = apiRootOf(baseURL);
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  const signal = AbortSignal.timeout(RELAY_TIMEOUT_MS);
  const read = async (url) => {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`relay billing ${response.status}`);
    return response.json();
  };
  // 区间参数是端点签名要求（缺省会 400）；这个站不真的按区间过滤。
  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const [subscription, usage] = await Promise.all([
    read(`${root}/dashboard/billing/subscription`),
    read(`${root}/dashboard/billing/usage?start_date=${start}&end_date=${end}`)
  ]);
  const total = Number(subscription?.hard_limit_usd);
  const used = Number(usage?.total_usage) / 100;
  if (!Number.isFinite(total) || !Number.isFinite(used)) throw new Error("relay billing shape");
  return { remaining: total - used, total, used };
}

/** 站点自定义货币符号；读不到就用 ¥。 */
async function fetchRelayCurrency(baseURL) {
  try {
    const response = await fetch(`${new URL(baseURL).origin}/api/status`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
    });
    if (!response.ok) return "¥";
    const body = await response.json();
    const symbol = body?.data?.custom_currency_symbol;
    return typeof symbol === "string" && symbol.length > 0 ? symbol : "¥";
  } catch {
    return "¥";
  }
}

/**
 * 中转余额读取器：按 (provider, baseURL, keyRef) 记忆，20 秒内复用。
 * 同时并发合并同一路由的重复点击。
 */
function createRelayBalanceReader(ctx, config) {
  const hosts = Array.isArray(config?.relayHosts) && config.relayHosts.length > 0
    ? config.relayHosts.map((host) => String(host).toLowerCase())
    : DEFAULT_RELAY_HOSTS;
  let cache;
  let inflight;
  /** 最近一次扫描到的路由表（`provider → {baseURL, keyRef}`）。 */
  let routes = new Map();
  let scannedAt = 0;

  const scan = (force) => {
    const now = Date.now();
    if (!force && routes.size > 0 && now - scannedAt < 10000) return routes;
    try {
      routes = collectRoutes(ctx);
    } catch {
      routes = new Map();
    }
    scannedAt = now;
    return routes;
  };

  const resolveKey = async (ref) => {
    try {
      const credentials = ctx.get("credentials", false);
      const hit = await credentials?.resolve?.(ref);
      if (typeof hit?.value === "string" && hit.value.length > 0) return hit.value;
    } catch {}
    return undefined;
  };

  /** 这条路由此刻是否走中转站（同步，只读路由表缓存）。 */
  const isRelayRoute = (provider) => {
    if (typeof provider !== "string" || provider.length === 0) return false;
    // 官方账号通道写死官方源，永不当作中转（它连 baseURL 都不可配）。
    if (OFFICIAL_ONLY_PROVIDERS.has(provider)) return false;
    const route = scan().get(provider);
    return matchesHost(hostOf(route?.baseURL), hosts);
  };

  /** 一条路由上各模型的单价（元/1M），供浏览器悬停提示显示中转价。 */
  const pricesFor = (provider) => {
    if (typeof provider !== "string" || provider.length === 0) return {};
    return { ...(RELAY_PRICES[provider] ?? {}) };
  };

  /** 读一条中转路由的余额。 */
  const readRoute = async (provider, route) => {
    if (route === undefined) return { kind: "official", provider };
    const ref = route.keyRef ?? "DEEPSEEK_API_KEY";
    const apiKey = await resolveKey(ref);
    if (apiKey === undefined) {
      return { kind: "relay", status: "no-key", provider, baseURL: route.baseURL, keyRef: ref, prices: pricesFor(provider) };
    }
    const [balance, symbol] = await Promise.all([
      fetchRelayBalance(route.baseURL, apiKey),
      fetchRelayCurrency(route.baseURL)
    ]);
    return {
      kind: "relay",
      status: "ready",
      provider,
      baseURL: route.baseURL,
      keyRef: ref,
      currency: symbol,
      // 余额 = 总额度 − 已用；三个数都返回，界面上余额与用量都能显示。
      remaining: balance.remaining,
      total: balance.total,
      used: balance.used,
      // 悬停提示要显示的中转单价（浏览器内置的是官方峰谷价，对中转是错的）。
      prices: pricesFor(provider)
    };
  };

  /**
   * 判定当前走官方还是中转，并取回对应账本。
   * @param providerHint - 会话选中的路由；有值就只看那一条。
   */
  const compute = async (providerHint) => {
    const current = scan();
    /*
     * 判定顺序：
     *  1. 会话报了当前 provider（正常路径）：只看那一条。命中中转域名 ⇒ 中转，
     *     否则 ⇒ 官方账户 —— 不能因为「别处还有一条中转路由」就把官方会话也
     *     标成中转。
     *  2. 没报（路由还没就位）：退化为「组合里存在中转路由就算中转」。
     */
    if (typeof providerHint === "string" && providerHint.length > 0) {
      const hinted = current.get(providerHint);
      if (!isRelayRoute(providerHint)) return { kind: "official", provider: providerHint };
      return readRoute(providerHint, hinted);
    }
    const relays = [...current].filter(([provider]) => isRelayRoute(provider));
    if (relays.length === 0) return { kind: "official", routes: [...current.keys()] };
    const [provider, route] = relays[0];
    return readRoute(provider, route);
  };

  /**
   * 读一次中转状态。
   * @param fresh - true 时绕过缓存（用户点击余额按钮），否则 20 秒内复用。
   * @param providerHint - 当前会话选中的 provider；决定读哪本账。
   */
  const reader = async (fresh, providerHint) => {
    const key = typeof providerHint === "string" ? providerHint : "";
    const now = Date.now();
    // 缓存按 provider 分键：切模型后不能复用另一条路由的结论。
    if (fresh !== true && cache !== undefined && cache.key === key && now - cache.at < RELAY_CACHE_MS) return cache.value;
    // 并发合并也只合并同一条路由的请求，否则会把 A 的结论答给 B。
    if (inflight !== undefined && inflight.key === key) return inflight.promise;
    const promise = (async () => {
      try {
        const value = await compute(providerHint);
        cache = { at: Date.now(), key, value };
        return value;
      } catch (error) {
        // 失败也短暂缓存，避免界面每次重渲染都打端点。
        const value = { kind: "relay", status: "failed", message: String(error?.message ?? error) };
        cache = { at: Date.now(), key, value };
        return value;
      } finally {
        if (inflight !== undefined && inflight.promise === promise) inflight = undefined;
      }
    })();
    inflight = { key, promise };
    return promise;
  };
  // 两个同步查询挂在同一个函数对象上；在读请求路径里被调用（此时已全部初始化）。
  reader.isRelayRoute = isRelayRoute;
  reader.pricesFor = pricesFor;
  return reader;
}

/**
 * `/peak-indicator/relay`：把「当前走官方还是中转 + 中转余额」告诉浏览器。
 *
 * 安全：先问 composition 的 `connection` 服务要一个拒绝码（Host/Origin 围栏 +
 * 浏览器登录态），和官方 open-in-app 路由同一套；没有 webServer/connection 的
 * 组合直接不注册这条路由。响应 no-store，不含任何密钥。
 */
function registerRelayRoute(ctx, readRelay) {
  // 路由载体是可选服务：`ctx.inject` 让它在 webServer/connection 就位后才注册，
  // 而不是在 apply 这一刻就去读（那时两个服务通常还没起）。
  ctx.inject(["webServer", "connection"], (webCtx) => {
    const sendJson = (res, status, payload) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(payload));
    };
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: "/peak-indicator/relay",
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection?.(req);
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.end();
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("allow", "GET");
          res.end();
          return;
        }
        try {
          const query = new URL(String(req.url), "http://localhost").searchParams;
          // 用户点击（fresh=1）要实时值：绕过 20 秒缓存，仍合并并发请求。
          // provider 由浏览器带上（当前会话选中的路由），Host 据此决定读哪本账。
          sendJson(res, 200, await readRelay(query.has("fresh"), query.get("provider") ?? undefined));
        } catch (error) {
          sendJson(res, 200, { kind: "unknown", status: "failed", message: String(error?.message ?? error) });
        }
      }
    }), "peak-indicator: GET /peak-indicator/relay");
  });
}

/**
 * 插件入口。
 *
 * 三段各自独立降级，一段出错不影响其它段：
 *  1. 余额/通道识别 —— 失败时费用投影退化为「全部按官方价」，但徽标仍可用。
 *  2. 费用投影 —— 失败时只影响费用数字，余额卡仍可用。
 *  3. 余额 HTTP 路由 —— 失败时浏览器拿不到中转余额，其余照常。
 * 这样任何一个环节的意外都不会让整个插件（连峰谷徽标一起）消失。
 */
function apply(ctx, config) {
  let relay;
  try {
    relay = createRelayBalanceReader(ctx, config);
  } catch (error) {
    ctx.logger?.warn?.("peak-indicator: relay reader unavailable: %s", String(error?.message ?? error));
  }
  try {
    // 拿不到 reader 时退回「不走中转」的判定，费用仍按官方价估算。
    const isRelayRoute = relay === undefined ? () => false : (provider) => relay.isRelayRoute(provider);
    ctx.sessionProjections.register(createPeakCostProjection(config, isRelayRoute));
  } catch (error) {
    ctx.logger?.warn?.("peak-indicator: cost projection unavailable: %s", String(error?.message ?? error));
  }
  if (relay !== undefined) {
    try {
      registerRelayRoute(ctx, relay);
    } catch (error) {
      ctx.logger?.warn?.("peak-indicator: relay route unavailable: %s", String(error?.message ?? error));
    }
  }
}
var plugin = { apply, inject, name, Config };

export {
  BEIJING_OFFSET_MINUTES,
  Config,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_RELAY_HOSTS,
  LEGACY_PRICES,
  MODEL_PRICES,
  OFF_PEAK_DISCOUNT,
  OTHER_MODEL_PRICES,
  apiRootOf,
  beijingMinutes,
  beijingDay,
  createPeakCostProjection,
  currentPeriod,
  effectiveNewPrices,
  hostOf,
  isDeepseekModel,
  matchesHost,
  periodAt,
  plugin as default,
  priceFor,
  resolveModelPrice
};
