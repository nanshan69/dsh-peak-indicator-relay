# dsh-peak-indicator

DeepSeek Harness (DSH) Web / Desktop 的峰谷计价与账户余额插件。

- 会话头部显示高峰 / 闲时、距离下一次切换的倒计时，以及会话 Token 费用估算。
- 每轮消息末尾显示本轮 Token 费用，按日志中的实际用量和事件发生时间重算。
- 默认人民币计价，缓存命中输入使用独立缓存价；可显式选择美元或配置自定义模型价格。
- DSH 登录账户显示可用人民币余额（充值 + 赠金），每分钟刷新，也可点击刷新。
- 悬停说明精简为模型名、当前单价、估算范围三行。
- **（本分支新增）中转站识别**：按路由 `baseURL` 自动判定当前走官方账户还是第三方中转站，余额标签显示对应的账本；走中转时显示中转站余额 / 总额度 / 已用，点击即实时重查。
- **（本分支新增）中转站计价**：走中转站的路由用中转价估算费用（全天平价，无峰谷折扣），官方路由仍用官方峰谷价。

> 本仓库是 [future007s/dsh-peak-indicator](https://github.com/future007s/dsh-peak-indicator) 的**中转站适配分支**。
> 改动集中在「识别中转站 + 用中转价」。若只直连 DeepSeek 官方，请用上游版本。

## 中转站支持（本分支新增）

### 解决什么问题

上游版本把余额固定理解为「DSH 登录的 DeepSeek 官方账户余额」，费用固定按 DeepSeek 官方峰谷价估算。
当请求实际打到第三方中转站（New API 部署）时，会同时出现两个错误：

1. **余额看错账本**：中转站扣的是中转站额度，官方账户余额不动，于是余额标签一直不变、看着像「没花钱」。
2. **费用高估数倍**：中转站通常按官方价的一个固定折扣计价（本例 0.24 倍）且全天平价，用官方峰谷价估算会高估约 4 倍。

### 判定方式

不看用户设置、不靠探测（官方 key 打中转端点会失败），而是读每条路由的 `baseURL`：

- `baseURL` 命中 `relayHosts`（默认 `["queqiaoapi.com"]`，含子域）⇒ 视为中转站路由；
- 否则视为官方账户路由；
- `deepseek-account`（账号登录态，只能打官方源）永远按官方处理。

`baseURL` 依次从 `configEditor.configuration()`、`settings.describe()`、`llm.listProviders()` 三层读取，
前一层拿不到才退到下一层。**注意 `llm.listProviders()` 不返回 baseURL**，只返回 id 与展示名。

### 余额读取

中转站（New API）提供两个额度端点。字段名有欺骗性，实测结论如下：

```
GET {base}/v1/dashboard/billing/subscription → { hard_limit_usd }
     hard_limit_usd 是「总额度」，不是余额！只随充值 / 调额变化，与消费无关。
GET {base}/v1/dashboard/billing/usage?start_date&end_date → { total_usage }
     total_usage 是「累计已用」，单位是分（1 元 = 100）。
     该站不按 start/end 过滤，任何区间都返回同一累计值。
```

因此 **余额 = `hard_limit_usd` − `total_usage / 100`**。
实测校验：101.99 − 454.00/100 = 97.45，与站点后台显示的 97.68 一致。

浏览器不接触中转 key：Host 侧注册 `/peak-indicator/relay` 路由，先经 `connection.requestRejection`
做 Host/Origin 与登录态围栏（与官方 open-in-app 路由同一套），再返回 `{kind, remaining, total, used, ...}`。
该路由 20 秒缓存；点击余额标签会带 `fresh=1` 绕过缓存取实时值。自动刷新间隔 60 秒。

### 中转站计价

New API 的通用计价公式：

```
输入单价 = model_ratio × 2 × group_ratio        元 / 1M tokens
输出单价 = 输入单价 × completion_ratio
缓存单价 = 输入单价 × cache_ratio
```

`lib/index.js` 里的 `RELAY_PRICES` 表是 2026-10-25 从 `https://queqiaoapi.com/api/pricing` 实测抓取的，
按**路由**分组——同名模型在 `max` 与 `kiro` 分组价差 2.89 倍，只按模型名查表会错近 3 倍。

准确度校验：`deepseek-flash` 由公式得 0.48 / 1.92；实测扣费反解为 0.474 / 1.9202（误差 1.27% / 0.01%）。

**不收录**带 `billing_expr` 自定义阶梯计费的模型（本例：6 个 GPT 全部 + `claude-haiku-5-5`）。
它们的系数不是 `model_ratio`，实测标定未收敛（同一份 usage 反解出相差 3.2 倍的两种结论）。
这类模型**不估算费用**——会话里用到它们时，费用数字只统计可估的部分，不显示可能偏几百个百分点的错数。

### 配置

```yaml
- insert:
    - id: peak-indicator
      name: dsh-peak-indicator
      config:
        # 视为「中转站」的域名（含子域）。命中则该路由的余额与费用走中转口径。
        relayHosts: ["queqiaoapi.com"]
```

价格表是内置常量。换中转站或站点调价时，按上面的公式重算 `RELAY_PRICES`；
官方模型价格仍可用 `pricesCny` 覆盖（中转价目前只能改源码里的表）。

## 0.1.33：徽章跟随浅色 / 深色主题

峰谷、账户余额与每轮费用徽章跟随 DSH 当前主题即时切换，无需刷新页面。
历史消息保留原有高峰 / 闲时归属和费用，只随主题调整配色；第三方模型使用中性灰色。
账户余额的加载、未登录与读取失败等状态也适配两种主题。感谢 @gbcdby 的 PR #10。

## 0.1.32：右侧独立显示账户余额

峰谷徽标右侧固定显示一个独立的“账户余额”标签，不再根据当前模型路由隐藏。
有余额时显示绿色金额标签；加载、未登录、读取失败和接口不可用均保留明确状态。
这里始终是 **DSH 登录账户的余额**，切换至 API Key 或第三方模型后仍保持这一含义。

## 0.1.31：修复悬停一直显示“模型加载中”

优先订阅会话的 `modelSelection` 投影取得当前模型，再使用模型目录中的默认选择。
模型目录读取失败或重连时，已知会话模型的名称、单价和账户余额仍能显示；切换模型后优先使用新的会话选择。
目录失败或重试耗尽且确实没有模型信息时，显示“当前模型暂不可用”，不再永久显示加载中，也不会猜测模型名。

## 0.1.30：专注费用与余额

移除旧版对官方压缩策略的修改：不再改触发比例、保留 Token 数或自动压缩开关，不再注册压缩设置面板。
删除基于上下文 Token 下降推断压缩事件、按未命中输入价推算“每步省钱”的统计与日志。
插件介绍聚焦峰谷计价与余额，不再把调节官方压缩阈值列作本插件的压缩能力。

DSH `0.2.1-rc.2` 的基础 bundle 自带 `compaction-basic` 自动压缩、`/compact` 手动压缩与工具结果剪裁。
官方自动压缩默认开启，默认 `thresholdRatio: 0.8`、`retainRatio: 0.16`；实际触发还受路由模型窗口、输出预留、
headroom 与用户策略影响。本插件完全交由 DSH 管理这些设置，也不再猜测触发点。

旧 patch 中的 `autoCompact` 字段可继续加载，但从 0.1.30 起不再生效。升级后重启对应 DSH profile，
旧版运行时覆写会随旧插件退出撤销；用户直接配置在官方压缩插件上的策略继续由 DSH 管理。

减少上下文 Token 不等于同比例减少费用。缓存命中、摘要输入 / 输出费用和后续请求都会影响净成本，
所以本插件不再估算“压缩回本步数”或“未来每步节省金额”。

官方实现参考：[基础 bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/base/cordis.patch.yml)、
[压缩策略解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/compaction/compaction-basic/src/config.ts)。

## 峰谷时段与价格

北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余时段为闲时。
周末和中国法定节假日全天闲时；周末补班仍按闲时。内置 2026 年公告放假日期，后续年份需更新日历。
徽标倒计时每 30 秒更新。

当前人民币价格（元 / 百万 tokens，核对日期 **2026-10-20**）：

| 模型 | 高峰 输入 / 输出 / 缓存命中 | 闲时 输入 / 输出 / 缓存命中 |
| --- | --- | --- |
| deepseek-flash（DeepSeek-V4.1-Flash-1017） | 2 / 8 / 0.04 | 1 / 4 / 0.02 |
| deepseek-v4-pro（DeepSeek-V4-Pro-0813） | 9 / 27 / 0.30 | 4.5 / 13.5 / 0.15 |

旧 Flash API ID 按官方别名处理。其它模型显示中性标记，需要显式提供自定义单价才计入费用。

悬停示例（闲时）：

```text
DeepSeek-V4.1-Flash-1017
输入 ¥1 · 输出 ¥4 · 缓存 ¥0.02 / 百万 tokens
按已知 Token 估算，不含搜索/抓取费
```

## 费用估算的范围

宿主 `peakCost` 投影重放真实日志，分别累计未命中缓存输入、缓存命中输入与输出，并按每个事件的历史价格和峰谷时段计价。
流式用量与同一步最终消息不重复计数；每轮费用汇总该轮全部步骤。

这是已知 Token 用量的费用估算，最终扣款以 DeepSeek 账单为准。它不预测未来节省，也不从余额变化反推单轮费用。
Search / Fetch 等独立按次费用未计入：自北京时间 2026-11-01 00:00 起，官方 DSH 服务端调用每次成功且有结果的请求
收取 ¥0.005（美元价 $0.00075）；插件不猜测请求成功次数。

人民币不是将旧美元金额换符号或按汇率转换。两种币种使用独立价格与投影缓存校验。
历史人民币估算从 2026-08-17 的官方 V4 价格起算；Flash 从 2026-09-10 12:00 起使用新价。
更早的促销记录不完整，不猜算该时期的人民币费用，可用 `pricesCny` 显式补充。

价格按插件版本固定，宿主与浏览器由同一 `lib/pricing.js` 构建。

来源：[中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、
[V4 历史人民币价格图](https://api-docs.deepseek.com/zh-cn/img/v4_260813_price_cn.png)、
[英文价格页](https://api-docs.deepseek.com/quick_start/pricing/)、
[官方更新日志](https://api-docs.deepseek.com/zh-cn/updates/)。

## 账户余额

会话头部的峰谷徽标右侧，始终显示独立的 **账户余额 ¥xx.xx** 标签。
金额为充值钱包与赠送钱包之和，悬停用一行分别列出两项。每分钟自动刷新，点击可立即刷新。
通过 DSH 自带 Host 账户接口读取，不复制密钥到前端。

未登录、读取失败、没有人民币钱包分别显示对应状态，真实零余额才显示 `¥0.00`。
这个标签始终表示 DSH 登录的 DeepSeek 账户余额，与当前模型选择无关；它不代表自填 API Key 或第三方平台的钱包。美元钱包不折算成人民币。

## 安装与升级

专门适配 DSH **`0.2.1-rc.2`**，支持使用 Web 前端的 `web` / `desktop` profile。
Node.js 要求 `^22.19.0 || >=24.0.0`。未验证的新宿主版本不自动声明兼容。

```sh
dsh plugin --profile web add dsh-peak-indicator@0.1.33
```

桌面版将 `web` 换为实际 profile 名（通常是 `desktop`），也可使用插件管理器升级。
安装后重启对应 DSH profile 并刷新页面。不要复制文件到应用程序安装目录，不需要忽略兼容检查。

## 可选价格配置

默认无需配置。`pricesCny` 的单位为 **人民币 / 百万 tokens**；原有 `prices` 始终表示美元。
如需美元计价，显式设置 `currency: USD`，默认 `CNY`。

```yaml
- insert:
    - id: peak-indicator
      name: dsh-peak-indicator
      config:
        currency: CNY
        pricesCny:
          my-model:
            input: 1
            output: 3
            cacheHitInput: 0.1
```

自定义未知模型不套用 DeepSeek 峰谷折扣。宿主的 `peakWindows`、`holidayDates` 等可选配置只影响费用投影；
浏览器徽标仍使用内置官方时段与价格。

## 开发验证

```sh
npm run build
npm test
npm pack
```

`build` 同步浏览器中的价格与余额模块，测试拒绝未同步副本。
49 项测试覆盖官方兼容门禁、真实会话投影、历史 / 当前人民币价格、币种隔离、余额精度与账户切换，
以及真实官方压缩引擎在安装、旧配置、重载和卸载过程中保持策略不变。
前端测试覆盖独立余额标签、所有模型路由与失败状态、实际账户 RPC 接入，以及会话模型读取；确认只注册费用展示槽位，不再注册压缩设置。

隔离验收可指定新的 `DSH_HOME`，通过官方 CLI 安装打包文件并启动 Web profile；不需要发起收费模型请求。
