// dsh-peak-indicator client bundle (hand-built ModuleLoader format, mirrors the
// output shape of the other dsh web plugins). Shows a badge in the conversation
// session header marking whether the DeepSeek API is currently in its peak
// (高峰) or off-peak / half-price (闲时) billing window. Policy per the official
// DeepSeek peak/off-peak pricing scheme effective 2026-08-17 00:00 Beijing time;
// V4.1-Flash prices take effect 2026-09-10 12:00 Beijing time:
//   peak    = Beijing 09:00-12:00 and 14:00-18:00
//   offpeak = every other minute, billed at half the peak price
window.__ModuleLoader__.load({
  id: "dsh-peak-indicator",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    //#region src/client.js
    var client_exports = {};
    __export(client_exports, {
      NS: () => NS,
      PeakBadge: () => PeakBadge,
      BalanceBadge: () => BalanceBadge,
      TurnCost: () => TurnCost,
      createRelayStore: () => createRelayStore,
      apply: () => apply,
      beijingMinutes: () => beijingMinutes,
      currentPeriod: () => currentPeriod,
      default: () => client_default,
      en: () => en,
      formatPrice: () => formatPrice,
      inject: () => inject,
      isDeepseekModel: () => isDeepseekModel,
      modelPrices: () => modelPrices,
      badgeTooltip: () => badgeTooltip,
      modelDisplayName: () => modelDisplayName,
      nextTransitionInMinutes: () => nextTransitionInMinutes,
      zh: () => zh
    });
    module.exports = __toCommonJS(client_exports);
    var import_react = __toESM(require("react"), 1);
    var NS = "peakIndicator";
    var zh = {
      "badge.peak": "⚡ 高峰", "badge.offpeak": "🌙 闲时", "badge.other": "🌿 其它模型",
      "badge.relay": "🔀 中转·平价",
      "badge.next": " · {countdown} 后切换", "badge.cost": " · {symbol}{amount}",
      "turn.cost": "本轮 {symbol}{amount}", "turn.tip": "本轮 Token 费用估算",
      "tip.price": "输入 {symbol}{input} · 输出 {symbol}{output} · 缓存读 {symbol}{cacheHitInput} · 缓存写 {symbol}{cacheWriteInput} / 百万 tokens",
      "tip.tierStandard": "标准档（完整输入 ≤ {limit} tokens）",
      "tip.tierLong": "长上下文档（完整输入 > {limit} tokens）",
      "tip.scope": "按已知 Token 估算，不含搜索/抓取费",
      "tip.countdown": "距下次切换：{countdown}",
      "tip.sessionCost": "本次会话累计 {symbol}{amount}",
      "tip.unknown": "暂未取得模型单价", "tip.loading": "模型加载中", "tip.unavailable": "当前模型暂不可用"
    };
    var en = {
      "badge.peak": "⚡ Peak", "badge.offpeak": "🌙 Off-peak", "badge.other": "🌿 Other",
      "badge.relay": "🔀 Relay·flat",
      "badge.next": " · switches in {countdown}", "badge.cost": " · {symbol}{amount}",
      "turn.cost": "Turn {symbol}{amount}", "turn.tip": "Estimated token cost for this turn",
      "tip.price": "Input {symbol}{input} · Output {symbol}{output} · Cache read {symbol}{cacheHitInput} · Cache write {symbol}{cacheWriteInput} / 1M tokens",
      "tip.tierStandard": "Standard tier (full input ≤ {limit} tokens)",
      "tip.tierLong": "Long-context tier (full input > {limit} tokens)",
      "tip.scope": "Known tokens only; excludes Search/Fetch",
      "tip.countdown": "Next switch in {countdown}",
      "tip.sessionCost": "Session total {symbol}{amount}",
      "tip.unknown": "Model rate unavailable", "tip.loading": "Loading model", "tip.unavailable": "Current model unavailable"
    };

    Object.assign(zh, {
      "balance.amount": "账户余额 {amount}", "balance.tip": "DSH 登录账户 · 充值 {recharge} · 赠金 {bonus}，点击刷新",
      "balance.loading": "账户余额加载中…", "balance.signed-out": "账户余额：未登录", "balance.failed": "账户余额：读取失败",
      "balance.unavailable": "账户余额：暂不可用", "balance.no-cny": "账户余额：无人民币钱包", "balance.retry": "DSH 登录账户余额，点击重试",
      "balance.login": "请先在 DSH 设置中登录 DeepSeek 账户", "balance.wait": "正在读取 DSH 登录账户余额", "balance.offline": "DSH 账户余额接口暂不可用"
    });
    Object.assign(zh, {
      "balance.relay": "中转 {amount}", "balance.relay-tip": "中转站（{provider}）· 余额 {remaining} · 总额度 {total} · 已用 {used}，点击实时刷新",
      "balance.relay-loading": "中转余额…", "balance.relay-failed": "中转余额：读取失败",
      "balance.relay-nokey": "中转余额：未配置 key", "balance.relay-retry": "中转站余额读取失败，点击重试"
    });
    Object.assign(en, {
      "balance.relay": "Relay {amount}", "balance.relay-tip": "Relay ({provider}) · {remaining} left · total {total} · used {used}; click to refresh",
      "balance.relay-loading": "Relay balance…", "balance.relay-failed": "Relay balance: failed",
      "balance.relay-nokey": "Relay balance: no key", "balance.relay-retry": "Relay balance read failed; click to retry"
    });
    Object.assign(en, {
      "balance.amount": "Account balance {amount}", "balance.tip": "DSH account · Recharge {recharge} · Bonus {bonus}; click to refresh",
      "balance.loading": "Loading account balance…", "balance.signed-out": "Account balance: signed out", "balance.failed": "Account balance: failed",
      "balance.unavailable": "Account balance: unavailable", "balance.no-cny": "Account balance: no CNY wallet", "balance.retry": "DSH account balance; click to retry",
      "balance.login": "Sign in to your DeepSeek account in DSH settings", "balance.wait": "Reading the DSH account balance", "balance.offline": "DSH account balance service is unavailable"
    });

    // BEGIN SHARED PRICING
    // Official snapshot checked 2026-10-20. Prices are per 1M tokens.
    // USD: https://api-docs.deepseek.com/quick_start/pricing/
    // CNY: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    // Model version: https://api-docs.deepseek.com/zh-cn/updates/
    const PRICING_CHECKED_AT = "2026-10-20";
    const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
    const BEIJING_OFFSET_MINUTES = 480;
    const OFF_PEAK_DISCOUNT = 0.5;
    const LEGACY_PRICES = {
      "deepseek-flash": { input: 1.0, output: 2.0, cacheHitInput: 0.02 },
      "deepseek-v4-flash": { input: 1.0, output: 2.0, cacheHitInput: 0.02 },
      "deepseek-v4-flash-vision-exp": { input: 1.0, output: 2.0, cacheHitInput: 0.02 },
      "deepseek-v4-pro": { input: 3.0, output: 6.0, cacheHitInput: 0.025 }
    };
    const V4_MODEL_PRICES = {
      "deepseek-flash": { input: 0.44, output: 1.32, cacheHitInput: 0.014 },
      "deepseek-v4-flash": { input: 0.44, output: 1.32, cacheHitInput: 0.014 },
      "deepseek-v4-flash-vision-exp": { input: 0.44, output: 1.32, cacheHitInput: 0.014 },
      "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheHitInput: 0.044 }
    };
    const MODEL_PRICES = {
      "deepseek-flash": { input: 0.30, output: 1.20, cacheHitInput: 0.006 },
      "deepseek-v4-flash": { input: 0.30, output: 1.20, cacheHitInput: 0.006 },
      "deepseek-v4-flash-vision-exp": { input: 0.30, output: 1.20, cacheHitInput: 0.006 },
      "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheHitInput: 0.044 }
    };
    // Official historical CNY peak rates, effective 2026-08-17.
    // https://api-docs.deepseek.com/zh-cn/img/v4_260813_price_cn.png
    const V4_MODEL_PRICES_CNY = {
      "deepseek-flash": {input: 3, output: 9, cacheHitInput: 0.10},
      "deepseek-v4-pro": {input: 9, output: 27, cacheHitInput: 0.30}
    };
    const CURRENCY_SYMBOLS = {CNY: "¥", USD: "$"};
    const MODEL_PRICES_CNY = {
      "deepseek-flash": {input: 2, output: 8, cacheHitInput: 0.04},
      "deepseek-v4-pro": {input: 9, output: 27, cacheHitInput: 0.30}
    };
    // Currency-specific custom rates never cross the selected currency boundary.
    const OTHER_MODEL_PRICES = {};
    const SEARCH_FETCH_PRICING = {
      usdPerSuccessfulRequest: 0.00075,
      cnyPerSuccessfulRequest: 0.005,
      serverToolsBillFrom: "2026-11-01T00:00:00+08:00"
    };
    // Official published 2026 holiday breaks (including announced days off).
    // https://www.gov.cn/zhengce/content/202511/content_7047090.htm
    // Weekend make-up workdays stay off-peak: DeepSeek explicitly excludes weekends.
    const HOLIDAY_YEARS = [2026];
    const CHINA_HOLIDAY_DATES = [
      ["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"],
      ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"],
      ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"],
      ["2026-10-01", "2026-10-07"]
    ].flatMap(([start, end]) => {
      const days = [];
      for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
      return days;
    });
    const DEFAULT_POLICY = {
      currency: "CNY",
      peakWindows: DEFAULT_PEAK_WINDOWS,
      offPeakDiscount: OFF_PEAK_DISCOUNT,
      policyEffectiveDate: "2026-08-17T00:00:00+08:00",
      weekendOffPeakEffectiveDate: "2026-08-23T00:00:00+08:00",
      v41FlashEffectiveDate: "2026-09-10T12:00:00+08:00",
      holidayDates: CHINA_HOLIDAY_DATES,
      prices: {},
      pricesCny: {}
    };
    function beijingMinutes(now) {
      return (now.getUTCHours() * 60 + now.getUTCMinutes() + BEIJING_OFFSET_MINUTES) % 1440;
    }
    function beijingDay(now) {
      return new Date(now.getTime() + BEIJING_OFFSET_MINUTES * 60000).getUTCDay();
    }
    function beijingDate(now) {
      return new Date(now.getTime() + BEIJING_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
    }
    function canonicalModelId(model) {
      const m = String(model ?? "").toLowerCase();
      if (/^deepseek-(?:flash(?:-\d{4})?|v4\.1-flash(?:-\d{4})?|v4-flash(?:-vision-exp|-\d{4})?)$/.test(m)) return "deepseek-flash";
      if (/^deepseek-v4-pro(?:-\d{4})?$/.test(m)) return "deepseek-v4-pro";
      return null;
    }
    function modelDisplayName(model) {
      const id = canonicalModelId(model);
      return id === "deepseek-flash" ? "DeepSeek-V4.1-Flash-1017" : id === "deepseek-v4-pro" ? "DeepSeek-V4-Pro-0813" : String(model ?? "");
    }
    function isDeepseekModel(provider, model) {
      return String(provider ?? "").toLowerCase().includes("deepseek") && canonicalModelId(model) !== null;
    }
    function billingPeriod(now = new Date(), config = DEFAULT_POLICY) {
      const bj = beijingMinutes(now);
      if (now.getTime() >= Date.parse(config.policyEffectiveDate)
        && (config.holidayDates ?? CHINA_HOLIDAY_DATES).includes(beijingDate(now))) return {period: "offpeak", beijingMinutes: bj};
      if (now.getTime() >= Date.parse(config.weekendOffPeakEffectiveDate)) {
        const day = beijingDay(now);
        if (day === 0 || day === 6) return {period: "offpeak", beijingMinutes: bj};
      }
      const peak = config.peakWindows.some(([a, b]) => bj >= a * 60 && bj < b * 60);
      return {period: peak ? "peak" : "offpeak", beijingMinutes: bj};
    }
    function periodAt(timeMs, config = DEFAULT_POLICY) {
      return billingPeriod(new Date(timeMs), config).period;
    }
    function resolveModelPrice(model, table) {
      const m = String(model ?? "").toLowerCase();
      if (Object.hasOwn(table, m)) return table[m];
      for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
        if (m.startsWith(key + "-")) return table[key];
      }
      const canonical = canonicalModelId(m);
      if (canonical && Object.hasOwn(table, canonical)) return table[canonical];
      if (canonical === "deepseek-flash") return table["deepseek-v4-flash"] ?? null;
      return null;
    }
    function effectiveNewPrices(config = DEFAULT_POLICY) {
      return config.currency === "USD" ? {...MODEL_PRICES, ...config.prices} : {...MODEL_PRICES_CNY, ...config.pricesCny};
    }
    function priceFor(model, period, timeMs, config = DEFAULT_POLICY) {
      const currency = config.currency ?? "CNY";
      const overrides = currency === "USD" ? config.prices ?? {} : config.pricesCny ?? {};
      const custom = resolveModelPrice(model, overrides);
      if (canonicalModelId(model) === null) return custom;
      if (timeMs < Date.parse(config.policyEffectiveDate)) {
        // Earlier CNY promotions changed several times. Do not convert the old
        // USD snapshot or invent an incomplete CNY timeline. Explicit overrides
        // can price these records; the built-in CNY schedule starts on Aug 17.
        return custom ?? (currency === "USD" ? resolveModelPrice(model, LEGACY_PRICES) : null);
      }
      const current = timeMs >= Date.parse(config.v41FlashEffectiveDate);
      const table = currency === "USD" ? (current ? MODEL_PRICES : V4_MODEL_PRICES)
        : (current ? MODEL_PRICES_CNY : V4_MODEL_PRICES_CNY);
      const price = custom ?? resolveModelPrice(model, table);
      if (price === null) return null;
      const factor = period === "offpeak" ? config.offPeakDiscount : 1;
      return {
        input: price.input * factor,
        output: price.output * factor,
        cacheHitInput: price.cacheHitInput * factor,
        ...(price.cacheWriteInput === undefined ? {} : {cacheWriteInput: price.cacheWriteInput * factor})
      };
    }
    function modelPrices(model, period, currency = "CNY") {
      return priceFor(model, period, Date.now(), {...DEFAULT_POLICY, currency});
    }
    function nextTransitionInMinutes(now = new Date(), config = DEFAULT_POLICY) {
      const origin = Math.floor(now.getTime() / 60000) * 60000;
      const midnight = Date.parse(beijingDate(now) + "T00:00:00+08:00");
      const boundaries = [...new Set([0, ...config.peakWindows.flat().map(x => x * 60)])].sort((a,b) => a-b);
      for (let day = 0; day <= 370; day++) for (const minutes of boundaries) {
        const t = midnight + day * 86400000 + minutes * 60000;
        if (t > origin && periodAt(t - 1, config) !== periodAt(t, config)) return (t - origin) / 60000;
      }
      return null;
    }
    function formatPrice(value) { return String(Math.round(value * 1e4) / 1e4); }
    function formatBeijingClock(now) {
      const bj = beijingMinutes(now);
      return `${String(Math.floor(bj / 60)).padStart(2, "0")}:${String(bj % 60).padStart(2, "0")}`;
    }
    function formatCountdown(minutes) {
      if (minutes === null) return "—";
      const hours = Math.floor(minutes / 60), rest = minutes % 60;
      return hours === 0 ? `${rest} 分钟` : `${hours} 小时 ${rest} 分钟`;
    }
    // END SHARED PRICING
    function currentPeriod(now) { return billingPeriod(now).period; }

    function badgeTooltip(model, period, currency, t, loading = true, extraLines = [], relayPrice = null) {
      /*
       * 走中转站时用 Host 下发的中转价（全天平价）；中转缺价或币种不符时显示
       * 「暂未取得单价」，而不是回退套用官方费率。
       */
      const prices = relayPrice === false ? undefined
        : relayPrice !== null ? relayPrice : modelPrices(model, period, currency);
      const priceLine = (price) => t("tip.price", {
        symbol: CURRENCY_SYMBOLS[currency],
        input: formatPrice(price.input),
        output: formatPrice(price.output),
        cacheHitInput: formatPrice(price.cacheHitInput),
        // Legacy flat prices without a cache-write field fall back to input price.
        cacheWriteInput: formatPrice(price.cacheWriteInput ?? price.input)
      });
      const priceLines = Array.isArray(prices?.tiers)
        ? prices.tiers.flatMap((tier) => [
            t(tier.upTo === null ? "tip.tierLong" : "tip.tierStandard", {limit: "272,000"}),
            priceLine(tier.price)
          ])
        : prices !== null && prices !== undefined ? [priceLine(prices)] : [t("tip.unknown")];
      return [model ? modelDisplayName(model) : t(loading ? "tip.loading" : "tip.unavailable"),
        ...extraLines, ...priceLines, t("tip.scope")].join("\n");
    }

    /** No-op store faces for the "directory not available yet" case. */
    var noopSubscribe = () => () => {};
    var noopSnapshot = () => null;

    /**
     * The peak/off-peak badge rendered into the conversation session header.
     * Only hidden when the session's current model is positively known NOT to
     * be a DeepSeek flash/pro model; an unknown or still-loading selection
     * keeps the badge visible so it never silently disappears. The model
     * directory is re-loaded on a short retry loop until the selection lands;
     * the billing period recomputes every 30 seconds.
     */
    // BEGIN SHARED BALANCE
    // Account balance uses DSH's authenticated Host RPC; credentials never enter the browser.
    function decimalParts(text) {
      const match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:e([+-]?\d+))?$/i.exec(text);
      if (!match) throw new Error("Invalid wallet amount");
      const [whole, fraction = ""] = match[2].split(".");
      const exponent = Number(match[3] ?? 0);
      if (Math.abs(exponent) > 400 || fraction.length > 400 || whole.length > 400) throw new Error("Wallet amount out of range");
      let units = BigInt((whole || "0") + fraction) * (match[1] === "-" ? -1n : 1n);
      let scale = fraction.length - exponent;
      if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
      return {units, scale};
    }
    function sumWallets(wallets) {
      const parts = wallets.map(wallet => decimalParts(wallet.balance));
      const scale = Math.max(0, ...parts.map(part => part.scale));
      return {units: parts.reduce((sum, part) => sum + part.units * 10n ** BigInt(scale - part.scale), 0n), scale};
    }
    function formatWallet({units, scale}) {
      const negative = units < 0n;
      const abs = negative ? -units : units;
      const cents = scale > 2 ? abs / 10n ** BigInt(scale - 2) : abs * 10n ** BigInt(2 - scale);
      if (abs !== 0n && cents === 0n) return negative ? "-<¥0.01" : "<¥0.01";
      const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return `${negative ? "-" : ""}¥${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
    }
    function summarizeBalance(result) {
      if (result === null) return {status: "signed-out"};
      if (result?.status !== "ready") return {status: "failed"};
      try {
        const recharge = result.value.filter(wallet => wallet.currency === "CNY");
        const bonus = result.bonusWallets.filter(wallet => wallet.currency === "CNY");
        if (!recharge.length && !bonus.length) return {status: "no-cny"};
        return {status: "ready", total: formatWallet(sumWallets([...recharge, ...bonus])),
          recharge: formatWallet(sumWallets(recharge)), bonus: formatWallet(sumWallets(bonus))};
      } catch { return {status: "failed"}; }
    }

    // One shared store across session headers. Account changes invalidate outstanding reads.
    function createBalanceStore() {
      let snapshot = {status: "unavailable"};
      let remote, metadata, revision = 0, pending, disposed = false, signedIn = false;
      const listeners = new Set();
      const publish = value => { if (!disposed) { snapshot = value; for (const listener of listeners) listener(); } };
      const refresh = () => {
        if (disposed || !remote || !signedIn) return Promise.resolve();
        if (pending) return pending;
        const generation = revision;
        publish({status: "loading"});
        const task = Promise.resolve().then(() => remote.account.getBalance(metadata())).then(result => {
          if (!disposed && generation === revision) publish(result.ok ? summarizeBalance(result.value) : {status: "failed"});
        }).catch(() => { if (!disposed && generation === revision) publish({status: "failed"}); });
        pending = task;
        task.finally(() => { if (pending === task) pending = undefined; });
        return task;
      };
      const accountChanged = view => {
        revision++; pending = undefined;
        signedIn = view?.status === "credential-stored";
        publish({status: signedIn ? "loading" : "signed-out"});
        if (signedIn) void refresh();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        refresh,
        connect(api, getMetadata) {
          remote = api; metadata = getMetadata;
          const stream = api.$stream({name: "account", open: signal => api.account.watch(signal), ended: () => new Error("Account stream ended")});
          let connected = true;
          void (async () => {
            try {
              for await (const frame of stream) {
                if (!connected || disposed) break;
                accountChanged(frame.value);
                frame.accept();
              }
            } catch { /* The next watch snapshot refreshes after reconnection. */ }
            if (connected && !disposed) { revision++; pending = undefined; signedIn = false; publish({status: "unavailable"}); }
          })();
          const timer = setInterval(() => { void refresh(); }, 60000);
          return () => { connected = false; revision++; pending = undefined; signedIn = false; remote = undefined; clearInterval(timer); publish({status: "unavailable"}); return stream.dispose(); };
        },
        dispose() { disposed = true; revision++; listeners.clear(); }
      };
    }
    // END SHARED BALANCE

    /*
     * BEGIN SHARED RELAY
     * 中转站余额卡：官方余额卡之外的第二张卡。
     *
     * 为什么要两张：官方账户余额（deepseekAccount RPC）与中转站额度是两本账。
     * 走中转时扣的是中转额度，官方余额不动；只看官方那张卡会以为「没花钱」。
     *
     * 数据来源是 Host 自己的 `/peak-indicator/relay` 路由（同一台 webServer、
     * 同一套登录态围栏），浏览器拿不到也不该拿中转 key。返回形状：
     *   { kind: "relay"|"official"|"unknown", status, currency, remaining, used,
     *     provider, baseURL, keyRef, message }
     * `kind` 决定余额按钮显示哪本账：
     *   relay    → 中转站额度（点一下实时重查）
     *   official → DSH 登录的官方账户余额（原有行为）
     *   unknown  → 按钮保持原样，不给错误结论
     */
    var RELAY_ROUTE = "/peak-indicator/relay";

    /** 金额格式化：中转额度可能是浮点，统一保留两位。 */
    function formatRelayAmount(currency, value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const symbol = typeof currency === "string" && currency.length > 0 ? currency : "¥";
      return symbol + value.toFixed(2);
    }

    /** Keep positive sub-cent estimates visible instead of rounding them to zero. */
    function formatCostAmount(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      if (value <= 0 || value >= 0.01) return value.toFixed(2);
      const rounded = Math.round(value * 1e8) / 1e8;
      if (rounded === 0) return "<0.00000001";
      return rounded.toFixed(8).replace(/\.?0+$/, "");
    }

    /**
     * 中转余额 store：轮询 Host 路由。
     * 与官方余额 store 一样是共享单例 + useSyncExternalStore 订阅。
     */
    function createRelayStore() {
      let snapshot = {kind: "unknown", status: "loading"};
      let listeners = new Set(), disposed = false, pending, timer;
      /*
       * 当前会话选中的 provider。徽标每次渲染都会 update()，Host 据此决定读
       * 哪本账（官方账户 or 中转站），而不是「组合里有没有中转路由」。
       */
      let provider;
      let lastQueried;
      let requestGeneration = 0;
      const publish = value => {
        if (disposed) return;
        snapshot = value;
        for (const listener of listeners) listener();
      };
      const refresh = (force) => {
        if (disposed) return Promise.resolve();
        // 只合并「同一条路由」的在途请求：切了 provider 就必须重新查，
        // 否则会把上一条路由的余额显示成当前这条的。
        if (pending !== undefined && pending.provider === provider && force !== true) return pending.task;
        const params = new URLSearchParams();
        // force（用户点击）带上 fresh=1，绕过 Host 侧的短缓存，拿的就是实时值。
        if (force === true) params.set("fresh", "1");
        if (typeof provider === "string" && provider.length > 0) params.set("provider", provider);
        const query = params.toString();
        const url = query.length > 0 ? RELAY_ROUTE + "?" + query : RELAY_ROUTE;
        const askedFor = provider;
        const generation = ++requestGeneration;
        lastQueried = provider;
        const task = Promise.resolve().then(() => fetch(url, {
          headers: {accept: "application/json"}, credentials: "same-origin"
        })).then(response => {
          if (!response.ok) throw new Error("relay route " + response.status);
          return response.json();
        }).then(body => {
          // 迟到的响应不能覆盖已经切换过去的路由的结论。
          if (disposed || askedFor !== provider || generation !== requestGeneration) return;
          if (body === null || typeof body !== "object") { publish({kind: "unknown", status: "failed"}); return; }
          const kind = body.kind === "relay" || body.kind === "official" ? body.kind : "unknown";
          // 中转价表由 Host 下发（浏览器内置的是官方峰谷价，对中转是错的）。
          const prices = kind === "relay" && body.prices !== null && typeof body.prices === "object" ? body.prices : undefined;
          if (kind !== "relay") { publish({kind, status: body.status ?? "ready"}); return; }
          const remaining = formatRelayAmount(body.currency, body.remaining);
          if (body.status !== "ready" || remaining === null) {
            publish({kind: "relay", status: body.status ?? "failed", provider: body.provider, keyRef: body.keyRef, prices});
            return;
          }
          publish({kind: "relay", status: "ready", remaining,
            total: formatRelayAmount(body.currency, body.total),
            used: formatRelayAmount(body.currency, body.used),
            provider: body.provider, keyRef: body.keyRef, prices});
        }).catch(() => { if (!disposed && askedFor === provider && generation === requestGeneration) publish({kind: "unknown", status: "failed"}); });
        pending = { provider: askedFor, task };
        task.finally(() => { if (pending !== undefined && pending.task === task) pending = undefined; });
        return task;
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        refresh: (force) => refresh(force),
        /** 会话切了 provider 就立刻重查（读缓存，不强制打端点）。 */
        update(next) {
          if (disposed) return;
          if (next === provider) return;
          const previous = provider;
          provider = next;
          if (previous !== next) publish({kind: "unknown", status: "loading"});
          if (lastQueried !== next) void refresh(false);
        },
        start() {
          if (timer !== undefined) return () => {};
          void refresh();
          // 60 秒一轮：中转额度不会每轮对话都变，够用且不打扰 Host。
          timer = setInterval(() => { void refresh(); }, 60000);
          return () => { clearInterval(timer); timer = undefined; };
        },
        dispose() { disposed = true; listeners.clear(); if (timer !== undefined) { clearInterval(timer); timer = undefined; } }
      };
    }
    // END SHARED RELAY

    const unavailableBalanceSnapshot = {status: "unavailable"};
    const unavailableBalance = {
      getSnapshot: () => unavailableBalanceSnapshot,
      subscribe: () => () => {},
      refresh: () => Promise.resolve()
    };
    const unavailableRelaySnapshot = {kind: "unknown", status: "unavailable"};
    const unavailableRelay = {
      getSnapshot: () => unavailableRelaySnapshot,
      subscribe: () => () => {},
      refresh: () => Promise.resolve()
    };
    /*
     * The badges are inline-styled, so they cannot inherit the shell's palette
     * on their own. ui-layout publishes the resolved scheme as
     * `body[data-ds-dark-theme]`, which is the only scheme marker the official
     * theme plugin documents, so the badges read it instead of guessing from
     * the clock or from `prefers-color-scheme` (the user may pick a scheme that
     * contradicts the OS).
     */
    const DARK_THEME_ATTRIBUTE = "data-ds-dark-theme";
    function isDarkScheme() {
      if (typeof document === "undefined") return false;
      const body = document.body;
      if (!body || typeof body.hasAttribute !== "function") return false;
      return body.hasAttribute(DARK_THEME_ATTRIBUTE);
    }
    function subscribeScheme(onChange) {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
      const body = document.body;
      if (!body) return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(body, { attributes: true, attributeFilter: [DARK_THEME_ATTRIBUTE] });
      return () => observer.disconnect();
    }
    /** Live dark-scheme flag: the shell's DOM attribute, re-read on every change. */
    function useDarkScheme() {
      // Server snapshots read the same marker: the bundle is client-rendered,
      // so this only matters to tests and keeps hydration free of a scheme flip.
      return import_react.default.useSyncExternalStore(subscribeScheme, isDarkScheme, isDarkScheme);
    }
    /** Pill palette per scheme: off-peak is green, third-party neutral, peak red. */
    function pillColors(dark, state) {
      if (state === "peak") return { color: "#ffffff", background: dark ? "#c93a3f" : "#e5484d", border: dark ? "#c93a3f" : "#e5484d" };
      if (state === "neutral") {
        return dark
          ? { color: "#d1d5db", background: "#2b3138", border: "#3f464e" }
          : { color: "#5b6470", background: "#f3f4f6", border: "#d1d5db" };
      }
      return dark
        ? { color: "#7fd6a8", background: "#1b2f24", border: "#2f5541" }
        : { color: "#0f7b3d", background: "#d9f2e2", border: "#7fd6a8" };
    }
    /** Balance badge palette: ready, failed and the neutral waits. */
    function balanceColors(dark, status) {
      if (status === "ready") {
        return dark
          ? { color: "#7fd6a8", background: "#1b2f24", border: "#2f5541" }
          : { color: "#126b3b", background: "#e8f7ef", border: "#a8d9bb" };
      }
      if (status === "failed") {
        return dark
          ? { color: "#e8c97b", background: "#332913", border: "#5c4a22" }
          : { color: "#8a5a00", background: "#fff6e5", border: "#e8c97b" };
      }
      return dark
        ? { color: "#9ca3af", background: "#2b3138", border: "#3f464e" }
        : { color: "#5b6470", background: "#f3f4f6", border: "#d1d5db" };
    }

    function BalanceBadge({ t, balance = unavailableBalance, relay = unavailableRelay }) {
      const snapshot = import_react.default.useSyncExternalStore(balance.subscribe, balance.getSnapshot, balance.getSnapshot);
      const relaySnapshot = import_react.default.useSyncExternalStore(relay.subscribe, relay.getSnapshot, relay.getSnapshot);
      const dark = useDarkScheme();
      /*
       * 一个按钮，两种账本：Host 说当前路由走中转站（kind === "relay"）就显示
       * 中转站额度，否则显示 DSH 登录的官方账户余额。判定在 Host 侧完成
       * （按 baseURL 命中中转域名），浏览器不做猜测。
       */
      const relayMode = relaySnapshot.kind === "relay";
      if (relayMode) {
        const ready = relaySnapshot.status === "ready";
        const noKey = relaySnapshot.status === "no-key";
        const failed = relaySnapshot.status === "failed";
        const palette = balanceColors(dark, ready ? "ready" : failed || noKey ? "failed" : "idle");
        const label = ready ? t("balance.relay", {amount: relaySnapshot.remaining})
          : noKey ? t("balance.relay-nokey") : failed ? t("balance.relay-failed") : t("balance.relay-loading");
        const tip = ready ? t("balance.relay-tip", {provider: relaySnapshot.provider ?? "relay",
            remaining: relaySnapshot.remaining,
            total: relaySnapshot.total ?? "—",
            used: relaySnapshot.used ?? "—"})
          : noKey ? t("balance.relay-nokey") : failed ? t("balance.relay-retry") : t("balance.relay-loading");
        return import_react.default.createElement("button", {
          type: "button", className: "dsh-peak-indicator-balance", title: tip,
          "data-channel": "relay", "data-status": relaySnapshot.status, "aria-live": "polite",
          // 点击即实时重查（fresh=1 绕过 Host 侧短缓存）。
          onClick: () => { void relay.refresh(true); },
          style: {padding: "1px 8px", borderRadius: 999,
            border: "1px solid " + palette.border,
            background: palette.background,
            color: palette.color, fontSize: 12, fontWeight: 600,
            whiteSpace: "nowrap", lineHeight: "18px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}
        }, label);
      }
      const ready = snapshot.status === "ready";
      const failed = snapshot.status === "failed";
      const disabled = ["loading", "signed-out", "unavailable"].includes(snapshot.status);
      const palette = balanceColors(dark, ready ? "ready" : failed ? "failed" : "idle");
      const label = ready ? t("balance.amount", {amount: snapshot.total}) : t("balance." + snapshot.status);
      const tip = ready ? t("balance.tip", {recharge: snapshot.recharge, bonus: snapshot.bonus})
        : t(snapshot.status === "signed-out" ? "balance.login" : snapshot.status === "loading" ? "balance.wait"
          : snapshot.status === "unavailable" ? "balance.offline" : "balance.retry");
      return import_react.default.createElement("button", {
        type: "button", className: "dsh-peak-indicator-balance", title: tip,
        "data-channel": "official", "data-status": snapshot.status, "aria-live": "polite",
        onClick: () => { void balance.refresh(); }, disabled,
        style: {padding: "1px 8px", borderRadius: 999,
          border: "1px solid " + palette.border,
          background: palette.background,
          color: palette.color, fontSize: 12, fontWeight: 600,
          whiteSpace: "nowrap", lineHeight: "18px", cursor: disabled ? "default" : "pointer", fontVariantNumeric: "tabular-nums"}
      }, label);
    }

    function PeakBadge({ t, directory, load, useProjection, balance, relay }) {
      const state = import_react.default.useSyncExternalStore(
        (fn) => directory ? directory.subscribe(fn) : noopSubscribe(),
        () => directory ? directory.getSnapshot() : noopSnapshot(),
        () => directory ? directory.getSnapshot() : noopSnapshot()
      );
      const projection = useProjection("peakCost");
      // Selection is durable session data. Reading it directly does not wait
      // for the advisory model catalog to load, authenticate or reconnect.
      const selection = useProjection("modelSelection");
      const current = selection?.next ?? state?.current ?? selection?.lastUsed ?? null;
      const [now, setNow] = import_react.default.useState(() => new Date());
      const [modelReadExpired, setModelReadExpired] = import_react.default.useState(false);
      const dark = useDarkScheme();
      const period = currentPeriod(now);
      import_react.default.useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(id);
      }, []);
      import_react.default.useEffect(() => {
        setModelReadExpired(false);
        if (current !== null) return;
        if (typeof load === "function") load();
        let retries = 0;
        const retryId = setInterval(() => {
          if (directory?.getSnapshot().current != null) { clearInterval(retryId); return; }
          if (retries >= 8) { setModelReadExpired(true); clearInterval(retryId); return; }
          if (typeof load === "function") load();
          retries += 1;
        }, 2000);
        return () => clearInterval(retryId);
      }, [directory, load, current?.provider, current?.model]);
      const isOther = current !== null && !isDeepseekModel(current.provider, current.model);
      /*
       * 余额按钮要显示哪本账，取决于「当前会话选中的路由」：会话切模型后把
       * provider 交给 relay store，它据此向 Host 重查。Host 侧按 baseURL 判定
       * 这条路由走的是中转站还是官方账户。
       */
      const relayStore = relay ?? unavailableRelay;
      import_react.default.useEffect(() => {
        if (typeof relayStore.update === "function") relayStore.update(current?.provider);
      }, [relayStore, current?.provider]);
      /*
       * 花费现在由 Host 侧按路由计价：中转路由用中转价（全天平价），官方路由用
       * 官方峰谷价。查不到价格的模型（带自定义 billing_expr 的那几个）Host 直接
       * 不计入，所以这里的 totalCost 自然只包含可估的模型 —— 不需要再按通道屏蔽。
       */
      const currency = projection?.currency === "USD" ? "USD" : "CNY";
      const knownCurrency = projection?.currency === "USD" || projection?.currency === "CNY";
      const totalCost = knownCurrency && typeof projection.totalCost === "number" ? projection.totalCost : 0;
      const costAmount = formatCostAmount(totalCost);
      const costSuffix = totalCost > 0 ? t("badge.cost", {symbol: CURRENCY_SYMBOLS[currency], amount: costAmount}) : "";
      const loadingModel = !modelReadExpired && state?.status !== "error" && state?.status !== "ready";
      /*
       * 走中转站时**没有峰谷**：中转全天平价，显示「高峰/闲时」和「X 后切换」
       * 都是假信息。所以中转路由把时段标签换成「中转·平价」，倒计时整段去掉。
       */
      const relayState = import_react.default.useSyncExternalStore(
        relayStore.subscribe,
        relayStore.getSnapshot,
        relayStore.getSnapshot
      );
      const relayChannel = relayState.kind === "relay";
      // Relay rates are CNY snapshots. `false` marks an unavailable relay price,
      // so badgeTooltip renders an unknown rate instead of official prices.
      const relayPrice = relayChannel
        ? (currency === "CNY" && current?.model !== undefined
          ? (relayState.prices?.[String(current.model).toLowerCase()] ?? false)
          : false)
        : null;
      /*
       * dshm-ui-fix: 窄屏（手机折叠/分屏）把徽标拆成三段渲染，由样式表按宽度决定
       * 保留哪几段 —— 原文是拼成一个长串，窄屏只能整体溢出或整体消失，没有中间档。
       * 拆分后：宽屏仍是完整一行；窄屏只留「时段」，倒计时与费用回到悬停提示里。
       */
      const periodLabel = relayChannel
        ? t("badge.relay")
        : isOther ? t("badge.other") : t("badge." + period);
      const countdownText = formatCountdown(nextTransitionInMinutes(now));
      // 中转没有切换点，倒计时与「距下次切换」都不显示。
      const countdownLabel = relayChannel || isOther ? "" : t("badge.next", {countdown: countdownText});
      const tip = badgeTooltip(current?.model, period, currency, t, loadingModel, [
        relayChannel || isOther ? "" : t("tip.countdown", {countdown: countdownText}),
        costSuffix.length > 0 ? t("tip.sessionCost", {symbol: CURRENCY_SYMBOLS[currency], amount: costAmount}) : ""
      ].filter((line) => line.length > 0), relayPrice);
      // 中转用中性色（没有峰谷语义），其它模型也中性，只有官方 DeepSeek 才分峰谷配色。
      const neutral = isOther || relayChannel;
      const palette = pillColors(dark, neutral ? "neutral" : period === "offpeak" ? "offpeak" : "peak");
      const [hovered, setHovered] = import_react.default.useState(false);
      const [tooltipPos, setTooltipPos] = import_react.default.useState(null);
      const showTooltip = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        /*
         * dshm-ui-fix: 窄屏上提示框原本固定 380px 宽、left 取徽标左边界 ⇒ 右侧被切掉。
         * 这里按视口宽度收缩并夹在视口内（左右各留 8px）。
         */
        const viewport = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 380;
        const maxWidth = Math.min(380, Math.max(160, viewport - 16));
        const left = Math.min(Math.max(8, rect.left), Math.max(8, viewport - maxWidth - 8));
        setTooltipPos({ top: rect.bottom + 6, left, maxWidth });
        setHovered(true);
      };
      return import_react.default.createElement("span", {
        className: "dsh-peak-indicator-header",
        style: {display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "nowrap", minWidth: 0}
      }, import_react.default.createElement("span", {
        style: { position: "relative", display: "inline-flex", minWidth: 0 },
        onMouseEnter: showTooltip,
        onMouseLeave: () => setHovered(false)
      },
        import_react.default.createElement("span", {
          className: "dsh-peak-indicator-badge",
          "aria-label": tip,
          tabIndex: 0,
          onFocus: showTooltip,
          onBlur: () => setHovered(false),
          style: {
            whiteSpace: "nowrap",
            fontSize: 12,
            fontWeight: 600,
            lineHeight: "18px",
            padding: "1px 8px",
            borderRadius: 999,
            color: palette.color,
            background: palette.background,
            border: "1px solid " + palette.border,
            cursor: "help",
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%"
          }
        },
          import_react.default.createElement("span", {className: "dsh-peak-indicator-period"}, periodLabel),
          countdownLabel.length > 0
            ? import_react.default.createElement("span", {className: "dsh-peak-indicator-countdown"}, countdownLabel)
            : null,
          costSuffix.length > 0
            ? import_react.default.createElement("span", {className: "dsh-peak-indicator-session-cost"}, costSuffix)
            : null
        ),
        hovered && tooltipPos !== null
          ? import_react.default.createElement("div", {
              role: "tooltip",
              style: {
                position: "fixed",
                top: tooltipPos.top,
                left: tooltipPos.left,
                zIndex: 9999,
                background: "rgba(17, 24, 39, 0.96)",
                color: "#f3f4f6",
                fontSize: 12,
                lineHeight: "18px",
                padding: "8px 10px",
                borderRadius: 8,
                maxWidth: tooltipPos.maxWidth ?? 380,
                boxSizing: "border-box",
                whiteSpace: "pre-line",
                boxShadow: "0 4px 16px rgba(0, 0, 0, 0.28)",
                pointerEvents: "none"
              }
            }, tip)
          : null
      ), import_react.default.createElement(BalanceBadge, {t, balance, relay: relay ?? unavailableRelay}));
    }

    /**
     * Per-turn cost chip rendered at the end of each assistant turn (the
     * turn-tail actions row): the actual token cost of the WHOLE turn —
     * every step of the turn is aggregated (a turn often spans several
     * tool-call steps, each with its own usage), so that the turn chip plus
     * the previous session total equals the new session total. Styled as a
     * period-colored pill like the header badge (green off-peak / red peak).
     */
    function TurnCost({ messageId, useProjection, t }) {
      const [period, setPeriod] = import_react.default.useState(() => currentPeriod(new Date()));
      const dark = useDarkScheme();
      import_react.default.useEffect(() => {
        const id = setInterval(() => setPeriod(currentPeriod(new Date())), 30000);
        return () => clearInterval(id);
      }, []);
      const projection = useProjection("peakCost");
      if (typeof projection !== "object" || projection === null) return null;
      if (projection.currency !== "CNY" && projection.currency !== "USD") return null;
      const entry = projection.messageCosts?.[messageId];
      if (typeof entry !== "object" || entry === null) return null;
      const isDS = isDeepseekModel(entry.provider, entry.model);
      /*
       * 这条 usage 计价时走的通道（official / relay）。中转全天平价、没有峰谷，
       * 所以既不用「高峰/闲时」配色，也不套官方价语义。
       */
      const chipRelay = entry.channel === "relay";
      // Historical turns keep the color of the period in which they happened;
      // fall back to the live period only when the projection has no record.
      const chipPeriod = typeof entry.period === "string" ? entry.period : period;
      let cost = entry.cost;
      if (typeof entry.turn === "number") {
        cost = 0;
        for (const row of Object.values(projection.messageCosts)) {
          if (row !== null && typeof row === "object" && row.turn === entry.turn) cost += typeof row.cost === "number" ? row.cost : 0;
        }
      }
      if (typeof cost !== "number" || cost <= 0) return null;
      const palette = pillColors(dark, !isDS || chipRelay ? "neutral" : chipPeriod === "offpeak" ? "offpeak" : "peak");
      return import_react.default.createElement("span", {
        className: "dsh-peak-indicator-turn-cost",
        title: t("turn.tip"),
        style: {
          whiteSpace: "nowrap",
          marginLeft: 8,
          fontSize: 12,
          fontWeight: 600,
          lineHeight: "18px",
          padding: "1px 8px",
          borderRadius: 999,
          color: palette.color,
          background: palette.background,
          border: "1px solid " + palette.border,
          fontVariantNumeric: "tabular-nums"
        }
      }, t("turn.cost", {symbol: CURRENCY_SYMBOLS[projection.currency], amount: formatCostAmount(cost)}));
    }

    var inject = ["slots", "locale", "modelDirectories"];
    function apply(ctx) {
      const balance = createBalanceStore();
      ctx.effect(() => () => balance.dispose(), "peak-indicator: balance store");
      const relay = createRelayStore();
      ctx.effect(() => () => relay.dispose(), "peak-indicator: relay store");
      ctx.effect(() => relay.start(), "peak-indicator: relay polling");
      ctx.inject(["remote", "remote.account"], accountCtx => {
        accountCtx.effect(() => balance.connect(accountCtx.remote, () => ({
          version: "0.2.1-rc.3", locale: ctx.locale.getSnapshot().active,
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
        })), "peak-indicator: account balance");
      });
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "peak-indicator: dictionaries");
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "peak-indicator",
        order: 20,
        locale: NS,
        inject: (sessionId) => {
          try {
            const directory = ctx.modelDirectories.directoryFor(sessionId);
            return {
              balance,
              relay,
              directory: directory.store,
              load: () => directory.load().catch(() => {})
            };
          } catch {
            return { directory: null, balance, relay };
          }
        }
      }, PeakBadge));
      ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
        name: "conversation.chat.assistant-actions",
        id: "peak-indicator",
        order: 100,
        locale: NS
      }, TurnCost));
    }
    var client_default = { apply, inject };

    /*
     * dshm-ui-fix v1（2026-10-25）：窄屏自适应。
     *
     * 问题（真机截图）：手机折叠/分屏后会话头部可用宽度很小，而徽标是
     * 「🌙 闲时 · 16 小时 40 分钟 后切换 · ¥1.03」一整串不可断的 nowrap 文本，
     * 加上右侧余额胶囊，整体超出头部宽度 ⇒ 挤压标题区、被裁切、行高错位。
     *
     * 处理：按头部容器宽度分三档，只隐藏文字、不改语义（完整信息仍在悬停提示
     * aria-label/tooltip 里，费用与余额各自保留独立元素）：
     *   · 宽（>= 460px）：全量
     *   · 中（>= 300px）：去掉会话累计费用
     *   · 窄（< 300px）：只留时段（⚡高峰 / 🌙闲时）+ 余额
     * 同时把徽标容器改为 nowrap + min-width:0，允许 ellipsis 兜底。
     *
     * 卸载/升级：删掉本段即可回到原样式；插件升级会覆盖 lib/client.js，本段需重打
     * （备份见同目录 client.js.bak-narrow-*）。
     */
    ;(() => {
      if (typeof document === "undefined") return;
      const TAG = "dsh-peak-indicator/narrow.css";
      /*
       * 三档规则同时用两种查询写：@container（宿主 .wSkVaW_titleRow 已声明
       * container-type:inline-size，量到的就是头部真实可用宽度，最准）与 @media
       * （容器查询失效时的视口兜底，阈值按 48px 头部内边距折算）。
       * max-width 先给 100%（不支持 cqw 时的回退）再给 100cqw（锁在头部宽度内）。
       */
      const CSS = [
        /* 基线：不超头部宽度；不支持 cqw 时回退到 100%（后一条声明会被丢弃） */
        ".dsh-peak-indicator-header{max-width:100%;max-width:min(100cqw, 520px);min-width:0;flex-wrap:nowrap!important}",
        ".dsh-peak-indicator-header>span{min-width:0;flex:0 1 auto}",
        ".dsh-peak-indicator-badge{max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis}",
        ".dsh-peak-indicator-header .dsh-peak-indicator-balance{flex:none}",
        /* 中档：去掉会话累计费用，并给会话标题预留 88px（标题优先，不被徽标挤没） */
        "@container (max-width: 460px){.dsh-peak-indicator-session-cost{display:none!important}"
          + ".dsh-peak-indicator-header{max-width:calc(100cqw - 88px)}}",
        "@media (max-width: 508px){.dsh-peak-indicator-session-cost{display:none!important}"
          + ".dsh-peak-indicator-header{max-width:calc(100vw - 120px)}}",
        /* 更窄：徽标字号与内边距各降一档 */
        "@container (max-width: 340px){.dsh-peak-indicator-badge{font-size:11px!important;padding:1px 6px!important}}",
        "@media (max-width: 388px){.dsh-peak-indicator-badge{font-size:11px!important;padding:1px 6px!important}}",
        /* 窄档：只留时段（⚡高峰/🌙闲时），倒计时回到悬停提示 */
        "@container (max-width: 300px){.dsh-peak-indicator-countdown{display:none!important}}",
        "@media (max-width: 348px){.dsh-peak-indicator-countdown{display:none!important}}",
        /* 极窄：连余额也收起（余额在设置页仍可看） */
        "@container (max-width: 200px){.dsh-peak-indicator-balance{display:none!important}}",
        "@media (max-width: 248px){.dsh-peak-indicator-balance{display:none!important}}"
      ].join("");
      const install = () => {
        try {
          if (document.querySelector('style[data-plugin-css="' + TAG + '"]') !== null) return;
          const tag = document.createElement("style");
          tag.dataset.plugin = "dsh-peak-indicator";
          tag.dataset.pluginCss = TAG;
          tag.textContent = CSS;
          (document.head || document.documentElement).appendChild(tag);
        } catch (error) {}
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    })();
    //#endregion

    return module.exports;
  }
});
