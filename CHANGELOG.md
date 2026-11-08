# 更新日志

## 0.2.0 — 2026-11-08

### 修复
- **DSH 0.2.2-rc.1 冷启动失败**：浏览器半的插槽注册由直接 `ctx.slots.register(...)` 改为官方写法
  `ctx.slots.inject(slot, () => ctx.slots.register(...))`；`sidebar.panellist` 的 `label` 改为函数形式。
  旧写法在 0.2.2 上会因插槽未就绪而抛错，导致插件激活失败、DSH 启动页中止。
- **客户端依赖补全**：`package.json` 的 `dsh.client.inject` 增加
  `@deepseek-ai/dsh-client-ui-slots`，确保客户端模块进入加载图。
- **启动稳定性**：宿主 `apply` 外层捕获异常，插件激活失败时只记录日志、不再阻断 DSH 启动。
- **错误落盘**：激活失败与诊断信息写入 `logs/etf-plugin-error.log`，便于定位。

### 新增
- `GET /etf-charts/api/cycle`：产业周期评分接口，调用 `scripts/cycle_score.py`，
  行业输入来自 `etf-dashboard/cycle/inputs.json`。
- `POST /etf-charts/api/diag`：客户端错误上报接口，写入宿主日志。
- 激活日志：记录路由 `/etf-charts` 注册成功或失败原因。

### 变更
- 插件描述补充「国家队资金足迹」。
- 版本号 `0.1.0` → `0.2.0`。

### 升级方式
1. 重新安装插件目录（或在 profile 中执行 `dsh plugin add file:<路径>`）
2. 完全重启 DSH
3. 左侧栏出现「ETF行情」入口，点击即可打开看板

> 本次只更新插件源码；`etf/` 静态页面与行情数据没有变化。

## 0.1.0 — 2026-11-07

- 初始版本：把 `etf-dashboard` 挂到 `/etf-charts` 路由，主面板同源 iframe 展示，
  提供 `/api/update`（收盘后增量抓取）与 `/api/status`（最近一次抓取结果）。