# AI 工具站

> 在线地址：<https://lapalcegreat.github.io/web-tools/>

用 AI 写的一些网页小工具，静态托管在 GitHub Pages。

## 工具

| 工具 | 网址 | 说明 |
| --- | --- | --- |
| ETF 成交量监控 | [`etf/`](etf/) | 12 只宽基 ETF 的日 K、成交量、均线、爆量高亮；数据来自东方财富公开接口 |

## 目录约定

```
.
├─ index.html          导航页（新增工具时在这里加卡片）
├─ .nojekyll           关闭 Jekyll 处理
├─ etf/                每个工具一个子目录，入口必须是 index.html
│  ├─ index.html
│  ├─ app.js
│  ├─ style.css
│  └─ data/
├─ docs/               截图等素材
└─ _source/            原始插件/脚本归档（下划线开头，不参与站点路由）
   └─ etf-monitor/
      ├─ etf-plugin/   DSH 插件源码
      └─ scripts/      数据抓取脚本
```

## 数据更新

ETF 数据由本地计划任务每天收盘后抓取，写回 `etf/data/`。发布站点需要把新数据提交并推送：

```powershell
cd G:\AI-Tools
git add etf/data
git commit -m "data: update etf daily"
git push
```

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 说明

- 纯静态：没有后端，`etf/` 页面的「刷新」在线上只会重读已提交的数据快照。
- 数据仅供个人研究，不构成投资建议。

