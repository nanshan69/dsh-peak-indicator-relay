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
    cacheHitInput: z.number(),
    cacheWriteInput: z.number()
  })).default({}),
  pricesCny: z.dict(z.object({
    input: z.number(),
    output: z.number(),
    cacheHitInput: z.number(),
    cacheWriteInput: z.number()
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
  }).strict())
}).strict();


/*
 * 中转站（queqiaoapi.com）价格表，依据其当前 /api/pricing 返回值整理。
 * 通用模型按 model_ratio × 2 × group_ratio 计算输入价；billing_expr 模型则按表达式
 * 系数 × group_ratio 计算（表达式系数已经是每百万 token 的分项单价），不可重复乘 model_ratio。
 * 输入/输出/缓存读/缓存写分开计价；普通路由按 provider 隔离。
 *
 * 条目有两种形态：
 *  - 平铺 `{ input, output, cacheHitInput, cacheWriteInput }` —— 全天单一价。
 *  - 分档 `{ tiers: [{ upTo, price }, ...] }` —— 按完整输入长度挑档，含 gpt 与 gpt-tehui；
 *    完整输入 = 未缓存输入 + 缓存读 + 缓存写，不含输出。`upTo === null` 表示无上限。
 *
 * 价格是 API 观察快照；模型/费率变更后需要复核，不以 model_ratio 公式覆盖自定义表达式。
 */
const RELAY_PRICES = {
  "deepseek-official": {
    "deepseek-flash": { input: 0.48, output: 1.92, cacheHitInput: 0.0096, cacheWriteInput: 0.48 },
    "deepseek-v4-pro": { input: 2.16, output: 6.48, cacheHitInput: 0.072, cacheWriteInput: 2.16 },
  },
  "gemini": {
    // Gemini 组 billing_expr 系数 × group_ratio 2.73；API 没有缓存写入项，故显式记 0。
    "gemini-4-argon": { tiers: [
      { upTo: 200000, price: { input: 5.46, output: 27.3, cacheHitInput: 0.546, cacheWriteInput: 0 } },
      { upTo: null, price: { input: 5.46, output: 27.3, cacheHitInput: 0.546, cacheWriteInput: 0 } }
    ] },
    "gemini-3.8-flash": { tiers: [
      { upTo: 200000, price: { input: 2.0475, output: 10.2375, cacheHitInput: 0.20475, cacheWriteInput: 0 } },
      { upTo: null, price: { input: 2.0475, output: 10.2375, cacheHitInput: 0.20475, cacheWriteInput: 0 } }
    ] },
    "gemini-3.5-flash": { tiers: [
      { upTo: 200000, price: { input: 4.095, output: 24.57, cacheHitInput: 0.4095, cacheWriteInput: 0 } },
      { upTo: null, price: { input: 4.095, output: 24.57, cacheHitInput: 0.4095, cacheWriteInput: 0 } }
    ] },
    "gemini-3.1-pro-preview": { tiers: [
      { upTo: 200000, price: { input: 5.46, output: 32.76, cacheHitInput: 0.546, cacheWriteInput: 0 } },
      { upTo: null, price: { input: 10.92, output: 49.14, cacheHitInput: 1.092, cacheWriteInput: 0 } }
    ] },
    "gemini-3-flash-preview": { tiers: [
      { upTo: 200000, price: { input: 1.365, output: 8.19, cacheHitInput: 0.1365, cacheWriteInput: 0 } },
      { upTo: null, price: { input: 1.365, output: 8.19, cacheHitInput: 0.1365, cacheWriteInput: 0 } }
    ] }
  },
  "kimi": {
    // Kimi 组通用价格：model_ratio × 2 × group_ratio(0.24)，CNY / 1M tokens。
    "kimi-k3.1-pro": { input: 3.12, output: 16.32, cacheHitInput: 0.312, cacheWriteInput: 3.12 },
    "kimi-k3": { input: 4.8, output: 24, cacheHitInput: 0.48, cacheWriteInput: 4.8 }
  },
  "gpt": {
    // default 组的 billing_expr 系数 × group_ratio 0.52，CNY / 1M tokens。
    "gpt-6-sol": { tiers: [
      { upTo: 272000, price: { input: 1.04, output: 5.2, cacheHitInput: 0.104, cacheWriteInput: 1.3 } },
      { upTo: null, price: { input: 2.08, output: 7.8, cacheHitInput: 0.208, cacheWriteInput: 2.6 } }
    ] },
    "gpt-6.1-sol": { tiers: [
      { upTo: 272000, price: { input: 1.04, output: 5.2, cacheHitInput: 0.052, cacheWriteInput: 1.3 } },
      { upTo: null, price: { input: 2.08, output: 7.8, cacheHitInput: 0.104, cacheWriteInput: 2.6 } }
    ] },
    "gpt-5.6-sol": { tiers: [
      { upTo: 272000, price: { input: 2.6, output: 15.6, cacheHitInput: 0.26, cacheWriteInput: 3.25 } },
      { upTo: null, price: { input: 5.2, output: 23.4, cacheHitInput: 0.52, cacheWriteInput: 6.5 } }
    ] },
    "gpt-5.6-luna": { tiers: [
      { upTo: 272000, price: { input: 1.04, output: 5.2, cacheHitInput: 0.052, cacheWriteInput: 1.3 } },
      { upTo: null, price: { input: 2.08, output: 7.8, cacheHitInput: 0.104, cacheWriteInput: 2.6 } }
    ] },
    "gpt-5.6-terra": { tiers: [
      { upTo: 272000, price: { input: 1.04, output: 6.24, cacheHitInput: 0.104, cacheWriteInput: 1.3 } },
      { upTo: null, price: { input: 2.08, output: 9.36, cacheHitInput: 0.208, cacheWriteInput: 2.6 } }
    ] },
    "gpt-6-astra": { tiers: [
      { upTo: 272000, price: { input: 5.2, output: 26, cacheHitInput: 0.52, cacheWriteInput: 6.5 } },
      { upTo: null, price: { input: 10.4, output: 39, cacheHitInput: 1.04, cacheWriteInput: 13 } }
    ] }
  },
  "gpt-tehui": {
    /*
     * GPT 特惠组（group_ratio 0.09）。六个模型的标准档/长上下文档均按当前
     * /api/pricing.billing_expr 系数乘路由倍率；价格单位为 CNY / 1M tokens。
     * 分档输入长度 = 未缓存输入 + 缓存读 + 缓存写，不含输出；缓存写有独立单价。
     * 当前 API pricing_version: a42d372ccf0b5dd13ecf71203521f9d2。
     * gpt-6.1-sol 实扣样例 p=8019、c=2413：估算 ¥0.00361512，实扣 ¥0.003616。
     */
    "gpt-6-sol": {
      tiers: [
        { upTo: 272000, price: { input: 0.18, output: 0.9, cacheHitInput: 0.018, cacheWriteInput: 0.225 } },
        { upTo: null, price: { input: 0.36, output: 1.35, cacheHitInput: 0.036, cacheWriteInput: 0.45 } }
      ]
    },
    "gpt-6.1-sol": {
      tiers: [
        { upTo: 272000, price: { input: 0.18, output: 0.9, cacheHitInput: 0.009, cacheWriteInput: 0.225 } },
        { upTo: null, price: { input: 0.36, output: 1.35, cacheHitInput: 0.018, cacheWriteInput: 0.45 } }
      ]
    },
    "gpt-5.6-sol": {
      tiers: [
        { upTo: 272000, price: { input: 0.45, output: 2.7, cacheHitInput: 0.045, cacheWriteInput: 0.5625 } },
        { upTo: null, price: { input: 0.9, output: 4.05, cacheHitInput: 0.09, cacheWriteInput: 1.125 } }
      ]
    },
    "gpt-5.6-luna": {
      tiers: [
        { upTo: 272000, price: { input: 0.18, output: 0.9, cacheHitInput: 0.009, cacheWriteInput: 0.225 } },
        { upTo: null, price: { input: 0.36, output: 1.35, cacheHitInput: 0.018, cacheWriteInput: 0.45 } }
      ]
    },
    "gpt-5.6-terra": {
      tiers: [
        { upTo: 272000, price: { input: 0.18, output: 1.08, cacheHitInput: 0.018, cacheWriteInput: 0.225 } },
        { upTo: null, price: { input: 0.36, output: 1.62, cacheHitInput: 0.036, cacheWriteInput: 0.45 } }
      ]
    },
    "gpt-6-astra": {
      tiers: [
        { upTo: 272000, price: { input: 0.9, output: 4.5, cacheHitInput: 0.09, cacheWriteInput: 1.125 } },
        { upTo: null, price: { input: 1.8, output: 6.75, cacheHitInput: 0.18, cacheWriteInput: 2.25 } }
      ]
    }
  },
  "claude-max": {
    "claude-fable-5": { input: 15.6, output: 78.0, cacheHitInput: 2.808, cacheWriteInput: 19.5 },
    "claude-fable-5-1": { input: 15.6, output: 78.0, cacheHitInput: 0.702, cacheWriteInput: 19.5 },
    "claude-opus-5-5": { input: 6.24, output: 31.2, cacheHitInput: 0.5616, cacheWriteInput: 7.8 },
    "claude-sonnet-5-5": { input: 3.12, output: 15.6, cacheHitInput: 0.5616, cacheWriteInput: 3.9 },
    "claude-opus-4-6": { input: 7.8, output: 39.0, cacheHitInput: 1.404, cacheWriteInput: 9.75 },
    "claude-opus-4-7": { input: 7.8, output: 39.0, cacheHitInput: 1.404, cacheWriteInput: 9.75 },
    "claude-opus-4-8": { input: 7.8, output: 39.0, cacheHitInput: 1.404, cacheWriteInput: 9.75 },
    "claude-opus-5": { input: 7.8, output: 39.0, cacheHitInput: 1.404, cacheWriteInput: 9.75 },
    "claude-sonnet-4-6": { input: 4.68, output: 23.4, cacheHitInput: 0.8424, cacheWriteInput: 5.85 },
    "claude-sonnet-5": { input: 3.12, output: 15.6, cacheHitInput: 0.5616, cacheWriteInput: 3.9 },
  },
  "claude-kiro": {
    "claude-fable-5": { input: 5.4, output: 27.0, cacheHitInput: 0.972, cacheWriteInput: 6.75 },
    "claude-fable-5-1": { input: 5.4, output: 27.0, cacheHitInput: 0.243, cacheWriteInput: 6.75 },
    "claude-opus-5-5": { input: 2.16, output: 10.8, cacheHitInput: 0.1944, cacheWriteInput: 2.7 },
    "claude-opus-4-6": { input: 2.7, output: 13.5, cacheHitInput: 0.486, cacheWriteInput: 3.375 },
    "claude-opus-4-7": { input: 2.7, output: 13.5, cacheHitInput: 0.486, cacheWriteInput: 3.375 },
    "claude-opus-4-8": { input: 2.7, output: 13.5, cacheHitInput: 0.486, cacheWriteInput: 3.375 },
    "claude-opus-5": { input: 2.7, output: 13.5, cacheHitInput: 0.486, cacheWriteInput: 3.375 },
    "claude-sonnet-4-6": { input: 1.62, output: 8.1, cacheHitInput: 0.2916, cacheWriteInput: 2.025 },
    "claude-sonnet-5": { input: 1.08, output: 5.4, cacheHitInput: 0.1944, cacheWriteInput: 1.35 },
    "claude-haiku-4-5": { input: 0.54, output: 2.7, cacheHitInput: 0.0972, cacheWriteInput: 0.675 },
    "claude-haiku-4-5-20251001": { input: 0.54, output: 2.7, cacheHitInput: 0.0972, cacheWriteInput: 0.675 },
    "claude-opus-4-5-20251101": { input: 2.7, output: 13.5, cacheHitInput: 0.486, cacheWriteInput: 3.375 },
    "claude-sonnet-4-5-20250929": { input: 1.62, output: 8.1, cacheHitInput: 0.2916, cacheWriteInput: 2.025 },
  },
};

/**
 * 查一条中转路由上某个模型的单价。
 * @param provider - 路由名（如 claude-kiro）。
 * @param model - 模型 id。
 * @returns {{input,output,cacheHitInput,cacheWriteInput}|{tiers}|null}；未收录模型返回 null。
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
/**
 * Pick the price tier for a usage record.
 *
 * 价格表条目有两种形态：
 *  - 平铺：`{ input, output, cacheHitInput }` —— 全天单一价（deepseek / claude 路由）。
 *  - 分档：`{ tiers: [{ upTo, price }, ...] }` —— 按「完整输入长度」挑档
 *    （gpt-tehui 的 standard / long_context）。`upTo === null` 表示无上限。
 *
 * 分档的判定量是 usage 里的输入长度，即 未缓存输入 + 缓存读 + 缓存写
 * （缓存命中的也算进「完整输入长度」——站点文档写的是「完整输入长度 ≤ 272K」）。
 */
function priceTierFor(entry, usage) {
  if (entry === null || typeof entry !== "object") return null;
  if (!Array.isArray(entry.tiers)) return entry;
  const inputLength = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  for (const tier of entry.tiers) {
    if (tier.upTo === null || inputLength <= tier.upTo) return tier.price ?? null;
  }
  // 所有档位都有上限且都超了：取最后一档兜底，避免返回 null 导致整条不估算。
  return entry.tiers[entry.tiers.length - 1]?.price ?? null;
}
/** Selected-currency cost for a usage record at the given per-1M prices. */
function priceUsage(price, usage) {
  const input = price?.input ?? 0;
  const output = price?.output ?? 0;
  const cacheHitInput = price?.cacheHitInput ?? 0;
  const cacheWriteInput = price?.cacheWriteInput ?? input;
  return (usage.inputTokens * input + usage.outputTokens * output
    + (usage.cacheReadTokens ?? 0) * cacheHitInput
    + (usage.cacheWriteTokens ?? 0) * cacheWriteInput) / 1e6;
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
      messageCosts: {}
    }),
    apply: (state, event) => {
      if (event.type === "request/header") {
        const headerConfig = event.data.header.config;
        if (typeof headerConfig !== "object" || headerConfig === null) return state;
        const provider = headerConfig.provider;
        const model = headerConfig.model;
        if (typeof provider !== "string" || typeof model !== "string" || provider.length === 0 || model.length === 0) return state;
        // Persist the route classification with the header so later configuration changes
        // cannot rewrite historical estimates.
        const channel = relayed(provider) ? "relay" : "official";
        if (state.provider === provider && state.model === model && state.channel === channel) return state;
        return { ...state, provider, model, channel };
      }

      // Live usage chunks are cumulative snapshots and can be followed by a durable
      // message/attempt carrying the same final usage. Only settle durable events below.
      // A failed attempt has no message event, so take its most recent usage snapshot
      // from the compact stream and charge that attempt exactly once.
      let usage;
      let turn;
      let step;
      let messageId;
      let chargeKey;
      let chargeTime = event.time ?? Date.now();
      if (event.type === "assistant/message") {
        usage = event.data.usage;
        turn = event.data.turn;
        step = event.data.step;
        messageId = event.data.message?.id;
        if (typeof messageId !== "string" || usage === void 0) return state;
        chargeKey = messageId;
      } else if (event.type === "assistant/attempt") {
        turn = event.data.turn;
        step = event.data.step;
        let latest;
        for (const record of event.data.stream ?? []) {
          if (record?.type === "chunk" && record.chunk?.type === "usage") {
            latest = record.chunk.usage;
            chargeTime = record.time ?? chargeTime;
          }
        }
        usage = latest;
        if (usage === void 0) return state;
        chargeKey = `attempt:${event.seq}`;
      } else {
        return state;
      }
      if (!Number.isInteger(turn) || !Number.isInteger(step) || typeof usage !== "object" || usage === null) return state;
      const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
      const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
      const cacheReadTokens = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
      const cacheWriteTokens = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
      if (inputTokens < 0 || outputTokens < 0 || cacheReadTokens < 0 || cacheWriteTokens < 0) return state;
      const buckets = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens};
      const provider = state.provider;
      const model = state.model;
      if (typeof provider !== "string" || typeof model !== "string") return state;
      const modelKey = `${provider}/${model}`;
      const period = periodAt(chargeTime, config);
      // Relay snapshots are denominated in CNY. Never mix them into a USD
      // session total; without a dated FX source, omitting the estimate is safer.
      const priceEntry = state.channel === "relay"
        ? (currency === "CNY" ? relayPriceFor(provider, model) : null)
        : priceFor(model, period, chargeTime, config);
      if (priceEntry === null) return state;
      const price = priceTierFor(priceEntry, buckets);
      if (price === null) return state;
      const cost = priceUsage(price, buckets);
      const prior = state.byModel[modelKey];
      const nextBucket = {
        uncachedInputTokens: (prior?.uncachedInputTokens ?? 0) + inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) + outputTokens,
        cacheReadTokens: (prior?.cacheReadTokens ?? 0) + cacheReadTokens,
        cacheWriteTokens: (prior?.cacheWriteTokens ?? 0) + cacheWriteTokens,
        cost: (prior?.cost ?? 0) + cost
      };
      return {
        ...state,
        byModel: {...state.byModel, [modelKey]: nextBucket},
        messageCosts: {
          ...state.messageCosts,
          [chargeKey]: {
            provider,
            model,
            turn,
            period,
            channel: state.channel ?? (relayed(provider) ? "relay" : "official"),
            cost
          }
        }
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
    // v12：CNY relay 档位与四类 token 费率更新后，使旧估算失效重算。
    // USD 同步递增到 v11，避免继续保留旧的 CNY relay 美元估算。
    stateVersion: currency === "CNY" ? 12 : 11
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
 *   GET {base}/v1/dashboard/billing/subscription → { hard_limit_usd } 总额度
 *   GET {base}/v1/dashboard/billing/usage?start_date&end_date → { total_usage } 累计已用
 *
 * 此 New API 配置下，hard_limit_usd 表示总额度，不是剩余余额；total_usage 是累计已用，
 * 单位按该站 quota_per_unit 标定换算。当前实现按 total − used 计算余额；如果计算值与站点
 * 后台显示不一致，应先重新核对这两个字段的单位与语义，不能把不一致的样例写成已验证。
 * 两个端点都只需要中转 key，不打模型、不消耗额度。
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
      routes.set(provider, { baseURL, keyRef: previous?.keyRef ?? keyRef });
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
      // Merge each row independently. A URL on a sibling route must not suppress
      // this row's profile values. Prefer live config, then explicit override,
      // then inherited values; `remember` only fills missing fields, so a keyRef
      // from an override is retained when the live config supplied only baseURL.
      absorb(row?.entry?.options?.config, id, pluginName);
      absorb(row?.override, id, pluginName);
      absorb(row?.inherited, id, pluginName);
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
   * 按缩进限制两种配置的作用域，避免上一个 section 的 URL 被归给
   * provider / adapter：providers 的字段只能来自 route 子节点，单路由
   * adapter 的字段只能来自其 config 子节点。
   */
  let currentRoute = null;
  let currentRouteIndent = -1;
  let inProviders = false;
  let providersIndent = -1;
  let itemIndent = -1;
  let singleRoute = null;
  let configIndent = -1;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Any sibling/ancestor YAML node ends scopes started by deeper nodes.
    // Leaving an adapter's config mapping also ends its route attribution, even
    // when the enclosing list item continues with other plugin fields.
    if (configIndent >= 0 && indent <= configIndent) {
      configIndent = -1;
      singleRoute = null;
    }
    if (itemIndent >= 0 && indent <= itemIndent) {
      itemIndent = -1;
      singleRoute = null;
      configIndent = -1;
    }
    if (inProviders && indent <= providersIndent && !/^providers:\s*$/.test(trimmed)) {
      inProviders = false;
      providersIndent = -1;
      currentRoute = null;
      currentRouteIndent = -1;
    } else if (inProviders && currentRoute !== null && indent <= currentRouteIndent) {
      currentRoute = null;
      currentRouteIndent = -1;
    }
    if (inProviders && currentRoute === null && indent > providersIndent + 2) {
      // A route profile may contain nested maps; do not retain it past a sibling.
      currentRouteIndent = -1;
    }

    if (/^providers:\s*$/.test(trimmed)) {
      inProviders = true;
      providersIndent = indent;
      currentRoute = null;
      currentRouteIndent = -1;
      continue;
    }

    // A list item's id starts a new possible adapter scope. Only the explicit
    // adapter names below can acquire a route; arbitrary plugin ids are ignored.
    const idMatch = /^-\s+id:\s*(\S+)\s*$/.exec(trimmed);
    if (idMatch) {
      itemIndent = indent;
      singleRoute = SINGLE_ROUTE_ADAPTERS[idMatch[1]] ?? null;
      configIndent = -1;
      currentRoute = null;
      currentRouteIndent = -1;
      continue;
    }
    const nameMatch = /^name:\s*["']?([^"'\s]+)["']?\s*$/.exec(trimmed);
    if (itemIndent >= 0 && indent === itemIndent + 2 && nameMatch) {
      singleRoute = SINGLE_ROUTE_ADAPTERS[nameMatch[1]] ?? null;
      continue;
    }
    const configMatch = /^config:\s*(?:#.*)?$/.test(trimmed);
    if (itemIndent >= 0 && singleRoute !== null && indent === itemIndent + 2 && configMatch) {
      configIndent = indent;
      continue;
    }

    // Provider profiles are direct children of `providers:`; their URL/key
    // fields are direct children of that route key.
    if (inProviders) {
      const routeMatch = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
      if (routeMatch && indent === providersIndent + 2) {
        currentRoute = routeMatch[1];
        currentRouteIndent = indent;
        continue;
      }
      if (currentRoute !== null && indent === currentRouteIndent + 2) {
        const urlMatch = /^baseURL:\s*["']?([^"'\s]+)["']?\s*$/.exec(trimmed);
        if (urlMatch) { remember(currentRoute, urlMatch[1], undefined); continue; }
        const keyMatch = /^apiKeyEnv:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(trimmed);
        if (keyMatch) { remember(currentRoute, undefined, keyMatch[1]); continue; }
      }
      continue;
    }

    // A single-route plugin contributes only direct config fields. In
    // particular, later patch actions/sections cannot inherit its route.
    if (singleRoute !== null && configIndent >= 0 && indent === configIndent + 2) {
      const urlMatch = /^baseURL:\s*["']?([^"'\s]+)["']?\s*$/.exec(trimmed);
      if (urlMatch) { remember(singleRoute, urlMatch[1], undefined); continue; }
      const keyMatch = /^apiKeyEnv:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(trimmed);
      if (keyMatch) remember(singleRoute, undefined, keyMatch[1]);
    }
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
 * 样例算术：101.99 − 454.00/100 = 97.45；此前记录的后台值为 97.68，差 ¥0.23。
 * 这组数据并未对上，不能据此声称公式已与后台校验一致；需要重新核对字段单位或样例快照。
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

  /**
   * 一条路由上各模型的单价（元/1M），供浏览器悬停提示显示中转价。
   *
   * 分档条目（gpt-tehui 的 standard / long_context）在这里展开成第一档的价格：
   * tooltip 只显示一行概括价，用最低档报价更符合「起步价」的直觉；实际计费
   * 由 priceTierFor 按每次请求的输入长度挑档，不受这里影响。
   */
  const pricesFor = (provider) => {
    if (typeof provider !== "string" || provider.length === 0) return {};
    const table = RELAY_PRICES[provider] ?? {};
    const out = {};
    for (const [model, entry] of Object.entries(table)) {
      if (Array.isArray(entry?.tiers)) {
        // Keep every tier intact for the client tooltip; flattening here made
        // tiered GPT routes render undefined prices and hid the long-context rates.
        out[model] = { tiers: entry.tiers.map((tier) => ({
          upTo: tier.upTo,
          price: { ...tier.price }
        })) };
      } else {
        out[model] = { ...entry };
      }
    }
    return out;
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
