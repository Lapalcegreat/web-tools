# A股宽基ETF行情插件

在 DeepSeek Harness 左侧导航新增 **「ETF行情」** 页：收盘后查看 12 只代表性宽基 ETF 的日 K 线、成交量与均线，数据从 2026-06-01 开始，每个交易日收盘后自动增量更新。

![ETF 行情页](docs/daily-spike.png)

## 打开方式

- **插件页**：DSH 左侧导航 →「ETF行情」。
- **独立网页**：<http://127.0.0.1:59398/etf-charts/>（登录态无关，任何本机浏览器都能直接打开）。
- **离线文件**：双击 `etf-dashboard/index.html`（数据内嵌在 `data/etf-data.js`，无需服务器）。

## 功能

- **标的**：上证50、沪深300、中证500、中证1000、中证2000、中证A500、创业板指、科创50、科创100、深证100、双创50、MSCI中国A50，共 12 只代表性 ETF。
- **K 线**：日 K 为单位；超过 150 个交易日时「自动」模式压缩为周 K（也可手动切「日K / 周K」）。周 K 按自然周（周一至周五）聚合：开高低收取当周、收盘取周末、成交量与成交额求和；悬停显示「周一 ~ 周五」日期区间。
- **均线**：MA5 / MA10 / MA20，按当前显示周期计算。
- **爆量高亮**：某根 K 线成交量 ≥ 前 20 根均量的 2 倍（周 K 为前 12 周均量的 1.8 倍）时判定为爆量——K 线加橙色描边与高点橙点、成交量柱变橙、背后加竖向高亮带；悬停显示「量能 N×均量」，页脚统计当前视图内爆量根数。系数与窗口在 `app.js` 顶部 `SPIKE` 中可调。
- **成交量**：K 线下方独立副图，红涨绿跌（爆量为橙）；成交额单位元。
- **交互**：悬停十字光标显示当日开高低收、涨跌幅、量额、均线与爆量倍数；区间切换（近1月/近3月/近6月/全部）；点击左侧列表切换标的；行情统计显示当日上涨/下跌家数。
- **刷新**：「刷新」按钮先调用宿主接口补抓一次最新收盘数据，再重载页面数据；页面每 60 秒自动重读数据文件。

## 数据

| 项目 | 说明 |
| --- | --- |
| 来源 | 东方财富公开行情接口 `push2his.eastmoney.com` |
| 复权 | 前复权（`fqt=1`） |
| 范围 | 2026-06-01 起，至最近一个已收盘交易日（当前 2026-11-06，108 个交易日） |
| 成交量 | 手（1 手 = 100 份） |
| 文件 | `etf-dashboard/data/etf-daily.json`（结构化）+ `etf-data.js`（供 file:// 内嵌） |

字段：`[date, open, close, high, low, volume, amount, amplitude]`。

## 自动更新

已注册两个 Windows 计划任务：

| 任务 | 触发 | 作用 |
| --- | --- | --- |
| `DSH-ETF-Daily-Update` | 周一至周五 15:10 | 收盘后增量抓取当日 K 线 |
| `DSH-ETF-Update-OnLogon` | 用户登录时 | 补抓关机/休眠期间错过的交易日 |

- 脚本会先判断当日是否为交易日：没有新 K 线时直接跳过写入，不会改动数据文件。
- 运行日志：`logs/etf-update.log`（UTF-8）。
- 手动执行：`python scripts/fetch_etf.py`（`--full` 从头重抓）。

查询/删除任务：

```powershell
schtasks /Query /TN "DSH-ETF-Daily-Update"
schtasks /Delete /TN "DSH-ETF-Daily-Update" /F
```

## 目录

```
etf-dashboard/            行情页（静态，无构建）
  index.html
  app.js                  Canvas K线 + 成交量渲染、日/周聚合、爆量识别
  style.css
  data/etf-daily.json     结构化日线数据
  data/etf-data.js        window.ETF_DATA 内嵌副本
etf-plugin/               DSH 插件包 dsh-etf-charts
  lib/index.js            宿主半：/etf-charts 静态路由 + /api/update
  lib/client.js           浏览器半：主面板 iframe + 左侧导航入口
  cordis.patch.yml        插入 etf-charts 行
scripts/
  fetch_etf.py            增量抓取脚本
  update_etf.cmd          计划任务入口
  update_etf_hidden.vbs   隐藏窗口启动
logs/etf-update.log       更新日志
docs/etf-dashboard.png    页面截图
```

## 增删标的

编辑 `scripts/fetch_etf.py` 顶部的 `ETFS` 列表（`code` / `secid` / `name` / `sector` / `index`），然后执行：

```powershell
python scripts/fetch_etf.py --full
```

`secid` 规则：沪市 `1.代码`，深市 `0.代码`。

## 插件实现说明

`dsh-etf-charts` 按 DSH bundle 规范安装（`dsh.bundle.patch` 插入 `etf-charts` 行），宿主半用 `ctx.webServer.register` 挂 `/etf-charts` 前缀路由，直接读工作区文件，因此**收盘后写入数据无需重启 DSH**；浏览器半在 `main` 与 `sidebar.panellist` 两个槽位注册页面与入口，页面内容为同源 iframe。

重新安装（代码改动后）：

```powershell
dsh plugin --profile desktop add "file:C:/Users/Administrator/Documents/deepseek-harness/default-workspace/etf-plugin"
```

> 桌面版配置由 Electron 应用托管，插件安装请通过应用内「插件」页或 `plugin_manager` 完成；直接修改 `~/.dsh/profiles/desktop/cordis.patch.yml` 只对该 profile 生效。
