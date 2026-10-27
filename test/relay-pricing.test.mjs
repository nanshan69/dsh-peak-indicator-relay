import test from "node:test";
import assert from "node:assert/strict";
import { Config, createPeakCostProjection } from "../lib/index.js";

const config = Config["~standard"].validate({ currency: "CNY" }).value;
const relayRoute = (provider) => provider === "gpt" || provider === "gpt-tehui";
const at = Date.parse("2026-10-27T03:35:14+08:00");

function fold(events) {
  const unit = createPeakCostProjection(config, relayRoute);
  let state = unit.init();
  for (const event of events) state = unit.apply(state, event);
  return unit.view(state);
}

function header(provider, model) {
  return { type: "request/header", time: at, data: { header: { config: { provider, model } } } };
}

function message(id, usage, time = at, turn = 1, step = 1) {
  return { type: "assistant/message", time, data: { turn, step, message: { id }, usage } };
}

test("GPT default relay separates input, output, cache-read, and cache-write buckets", () => {
  const view = fold([
    header("gpt", "gpt-6-astra"),
    message("m1", { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 })
  ]);
  // CNY/1M: 100*5.2 + 200*26 + 300*0.52 + 400*6.5 = 8,476.
  assert.equal(view.messageCosts.m1.channel, "relay");
  assert.ok(Math.abs(view.messageCosts.m1.cost - 0.008476) < 1e-12);
  assert.equal(view.byModel["gpt/gpt-6-astra"].cacheWriteTokens, 400);
});

test("GPT tier boundary includes cache tokens, excludes output, and uses <=272K standard", () => {
  const view = fold([
    header("gpt", "gpt-6-astra"),
    message("boundary", { inputTokens: 272000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    message("above", { inputTokens: 272001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, at, 2),
    // Input + cache read + cache write = 272,001, so this uses long-context rates.
    message("cached-above", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 271900, cacheWriteTokens: 1 }, at, 3),
    // A large completion does not increase the input length used to choose a tier.
    message("output-not-tiered", { inputTokens: 100, outputTokens: 999999, cacheReadTokens: 0, cacheWriteTokens: 0 }, at, 4)
  ]);
  assert.ok(Math.abs(view.messageCosts.boundary.cost - 1.4144) < 1e-12);
  assert.ok(Math.abs(view.messageCosts.above.cost - 2.8288104) < 1e-12);
  assert.ok(Math.abs(view.messageCosts["cached-above"].cost - 0.283829) < 1e-12);
  assert.ok(Math.abs(view.messageCosts["output-not-tiered"].cost - 26.000494) < 1e-12);
});

test("GPT-Tehui uses its own route rates and long-context tier", () => {
  const view = fold([
    header("gpt-tehui", "gpt-6-astra"),
    message("standard", { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 }),
    message("long", { inputTokens: 272001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, at, 2)
  ]);
  // Standard CNY/1M: 100*0.9 + 200*4.5 + 300*0.09 + 400*1.125 = 1,467.
  assert.ok(Math.abs(view.messageCosts.standard.cost - 0.001467) < 1e-12);
  assert.ok(Math.abs(view.messageCosts.long.cost - 0.4896018) < 1e-12);
});

test("ordinary GPT uses the long-context rates above 272,000 input tokens", () => {
  const view = fold([
    header("gpt", "gpt-6-astra"),
    message("long", { inputTokens: 272001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  ]);
  assert.ok(Math.abs(view.messageCosts.long.cost - 2.8288104) < 1e-12);
});

test("ordinary and Tehui GPT models use the audited component rates in both context tiers", () => {
  const rates = {
    gpt: {
      "gpt-6-sol": [[1.04,5.2,.104,1.3],[2.08,7.8,.208,2.6]],
      "gpt-6.1-sol": [[1.04,5.2,.052,1.3],[2.08,7.8,.104,2.6]],
      "gpt-5.6-sol": [[2.6,15.6,.26,3.25],[5.2,23.4,.52,6.5]],
      "gpt-5.6-luna": [[1.04,5.2,.052,1.3],[2.08,7.8,.104,2.6]],
      "gpt-5.6-terra": [[1.04,6.24,.104,1.3],[2.08,9.36,.208,2.6]],
      "gpt-6-astra": [[5.2,26,.52,6.5],[10.4,39,1.04,13]]
    },
    "gpt-tehui": {
      "gpt-6-sol": [[.18,.9,.018,.225],[.36,1.35,.036,.45]],
      "gpt-6.1-sol": [[.18,.9,.009,.225],[.36,1.35,.018,.45]],
      "gpt-5.6-sol": [[.45,2.7,.045,.5625],[.9,4.05,.09,1.125]],
      "gpt-5.6-luna": [[.18,.9,.009,.225],[.36,1.35,.018,.45]],
      "gpt-5.6-terra": [[.18,1.08,.018,.225],[.36,1.62,.036,.45]],
      "gpt-6-astra": [[.9,4.5,.09,1.125],[1.8,6.75,.18,2.25]]
    }
  };
  for (const [provider, models] of Object.entries(rates)) {
    for (const [model, [standard, long]] of Object.entries(models)) {
      const standardUsage = {inputTokens:100000,outputTokens:200000,cacheReadTokens:30000,cacheWriteTokens:40000};
      const longUsage = {inputTokens:200000,outputTokens:500000,cacheReadTokens:50000,cacheWriteTokens:22001};
      const view = fold([
        header(provider, model),
        message("standard", standardUsage),
        message("long", longUsage, at, 2)
      ]);
      const expectedStandard = (standardUsage.inputTokens*standard[0]+standardUsage.outputTokens*standard[1]+standardUsage.cacheReadTokens*standard[2]+standardUsage.cacheWriteTokens*standard[3])/1e6;
      const expectedLong = (longUsage.inputTokens*long[0]+longUsage.outputTokens*long[1]+longUsage.cacheReadTokens*long[2]+longUsage.cacheWriteTokens*long[3])/1e6;
      assert.ok(Math.abs(view.messageCosts.standard.cost-expectedStandard)<1e-12, `${provider}/${model} standard`);
      assert.ok(Math.abs(view.messageCosts.long.cost-expectedLong)<1e-12, `${provider}/${model} long`);
    }
  }
});

test("a failed-only turn is included in the session total without a message ID", () => {
  const view = fold([
    header("gpt", "gpt-6-sol"),
    {type:"assistant/attempt",seq:19,time:at,data:{turn:1,step:1,stream:[
      {type:"chunk",time:at,chunk:{type:"usage",usage:{inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheWriteTokens:0}}}
    ]}}
  ]);
  assert.ok(Math.abs(view.totalCost-0.000208)<1e-12);
  assert.ok(Math.abs(view.messageCosts["attempt:19"].cost-0.000208)<1e-12);
  assert.equal(view.messageCosts["attempt:19"].turn,1);
  assert.equal(Object.hasOwn(view.messageCosts,"undefined"),false);
});

test("a failed attempt and successful retry both contribute to the same turn", () => {
  const view = fold([
    header("gpt", "gpt-6-sol"),
    {type:"assistant/attempt",seq:19,time:at,data:{turn:1,step:1,stream:[
      {type:"chunk",time:at,chunk:{type:"usage",usage:{inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheWriteTokens:0}}}
    ]}},
    message("retry-success",{inputTokens:150,outputTokens:40,cacheReadTokens:0,cacheWriteTokens:0},at,1,1)
  ]);
  const failed = view.messageCosts["attempt:19"];
  const succeeded = view.messageCosts["retry-success"];
  const turnTotal = Object.values(view.messageCosts).filter(entry=>entry.turn===1).reduce((sum,entry)=>sum+entry.cost,0);
  assert.ok(Math.abs(failed.cost-0.000208)<1e-12);
  assert.ok(Math.abs(succeeded.cost-0.000364)<1e-12);
  assert.equal(failed.turn,succeeded.turn);
  assert.ok(Math.abs(turnTotal-0.000572)<1e-12);
  assert.ok(Math.abs(view.totalCost-turnTotal)<1e-12);
});

test("cumulative live chunks are not double-charged; successful messages and failed attempts settle once", () => {
  const view = fold([
    header("gpt", "gpt-6-sol"),
    { type: "assistant/chunk", time: at, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } } },
    { type: "assistant/chunk", time: at, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } } } },
    message("success", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, at, 1, 1),
    {
      type: "assistant/attempt", seq: 3, time: at,
      data: { turn: 2, step: 1, stream: [
        { type: "chunk", time: at, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } } },
        { type: "chunk", time: at, chunk: { type: "usage", usage: { inputTokens: 150, outputTokens: 40 } } }
      ] }
    }
  ]);
  assert.ok(Math.abs(view.messageCosts.success.cost - 0.000208) < 1e-12);
  assert.ok(Math.abs(view.messageCosts["attempt:3"].cost - 0.000364) < 1e-12);
  assert.ok(Math.abs(view.totalCost - 0.000572) < 1e-12);
  assert.equal(view.byModel["gpt/gpt-6-sol"].uncachedInputTokens, 250);
});

test("USD projections do not mix CNY relay rates or accumulate a mislabeled USD total", () => {
  const usdConfig = Config["~standard"].validate({ currency: "USD" }).value;
  const unit = createPeakCostProjection(usdConfig, relayRoute);
  let state = unit.apply(unit.init(), header("gpt", "gpt-6-astra"));
  state = unit.apply(state, message("usd", { inputTokens: 100, outputTokens: 100 }));
  assert.equal(unit.view(state).totalCost, 0);
  assert.deepEqual(unit.view(state).byModel, {});
});

test("identical model IDs on unrelated providers do not inherit relay pricing", () => {
  const view = fold([
    header("openai", "gpt-6-astra"),
    message("m1", { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })
  ]);
  assert.equal(view.totalCost, 0);
  assert.deepEqual(view.byModel, {});
});
