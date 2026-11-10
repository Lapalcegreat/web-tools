#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""产业周期量化评分：对一组主题股票，从景气、盈利质量、供给/运营、估值、拥挤度、新闻叙事
六个维度打分（0-100，越高越健康、越靠近"阶段2 加速期"），并给出阶段判定。

数据：东方财富公开接口（财务主要指标、估值历史、日K、行情快照、资讯搜索）。
输出：etf-dashboard/cycle/data.json
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "etf-dashboard" / "cycle" / "data.json"
INPUTS_PATH = ROOT / "etf-dashboard" / "cycle" / "inputs.json"
OVERSEAS_PATH = ROOT / "etf-dashboard" / "cycle" / "overseas.json"

HEAD = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0",
    "Referer": "https://emweb.securities.eastmoney.com/",
}

THEMES = [
    {
        "id": "ai",
        "name": "AI硬件",
        "keyword": "光模块",
        "match": ["光模块", "光通信", "CPO", "光芯片", "AI算力", "PCB", "铜缆", "1.6T"],
        "stocks": [
            ("300308", "中际旭创"), ("300502", "新易盛"), ("002384", "东山精密"),
            ("300394", "天孚通信"), ("300476", "胜宏科技"),
        ],
    },
    {
        "id": "newenergy",
        "name": "新能源",
        "keyword": "新能源",
        "match": ["新能源", "锂", "光伏", "储能", "电池", "硅料", "组件"],
        "stocks": [
            ("300750", "宁德时代"), ("601012", "隆基绿能"), ("300274", "阳光电源"),
            ("002460", "赣锋锂业"), ("600438", "通威股份"),
        ],
    },
    {
        "id": "humanoid",
        "name": "人形机器人",
        "keyword": "人形机器人",
        "match": ["人形机器人", "具身智能", "减速器", "灵巧手", "丝杠", "机器人", "执行器"],
        "stocks": [
            ("688836", "宇树科技"), ("688585", "上纬新材"), ("688017", "绿的谐波"),
            ("002472", "双环传动"), ("002050", "三花智控"), ("601689", "拓普集团"),
            ("003021", "兆威机电"), ("688322", "奥比中光"),
        ],
    },
    {
        "id": "aiglasses",
        "name": "AI眼镜",
        "keyword": "AI眼镜",
        "match": ["AI眼镜", "智能眼镜", "AR眼镜", "光波导", "MicroLED", "眼镜"],
        "stocks": [
            ("002273", "水晶光电"), ("002241", "歌尔股份"), ("688608", "恒玄科技"),
            ("300622", "博士眼镜"), ("001314", "亿道信息"), ("688127", "蓝特光学"),
        ],
    },
]

POS = ["增长", "超预期", "涨价", "供不应求", "扩产", "订单", "突破", "新高", "利好", "加速", "放量", "中标", "翻倍"]
NEG = ["下滑", "不及预期", "降价", "过剩", "砍单", "减持", "亏损", "暴跌", "风险", "放缓", "库存", "亏损", "跌停"]


def get(url: str, referer: str | None = None, tries: int = 3) -> str:
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={**HEAD, **({"Referer": referer} if referer else {})})
            raw = urllib.request.urlopen(req, timeout=25).read()
            if raw[:2] == b"\x1f\x8b":          # 东财部分节点无论是否声明都回 gzip
                raw = gzip.decompress(raw)
            text = raw.decode("utf-8", "ignore")
            if not text.strip():
                raise ValueError("empty response")
            return text
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0)
    raise RuntimeError(str(last))


def secid(code: str) -> str:
    return ("1." if code.startswith(("6", "5")) else "0.") + code


def ramp(x: float | None, lo: float, hi: float, invert: bool = False) -> float | None:
    if x is None or not math.isfinite(x):
        return None
    if hi == lo:
        return 50.0
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return (1 - t) * 100 if invert else t * 100


def median(values):
    vals = [v for v in values if v is not None]
    return statistics.median(vals) if vals else None


def fetch_kline(code: str, beg: str = "20230101") -> list[dict]:
    q = urllib.parse.urlencode({
        "secid": secid(code), "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "klt": "101", "fqt": "1",
        "beg": beg, "end": "20500101", "lmt": "3000",
    })
    d = json.loads(get("https://push2his.eastmoney.com/api/qt/stock/kline/get?" + q))["data"]
    rows = []
    for line in d["klines"]:
        p = line.split(",")
        rows.append({"d": p[0], "o": float(p[1]), "c": float(p[2]), "h": float(p[3]),
                     "l": float(p[4]), "v": float(p[5]), "a": float(p[6])})
    return rows


def fetch_quote(code: str) -> dict:
    q = urllib.parse.urlencode({"secid": secid(code), "fields": "f43,f57,f58,f116,f162,f167,f168,f170,f174,f175"})
    d = json.loads(get("https://push2.eastmoney.com/api/qt/stock/get?" + q))["data"]
    return {
        "price": d.get("f43", 0) / 100, "name": d.get("f58"), "mcap": d.get("f116"),
        "pe": (d.get("f162") or 0) / 100, "pb": (d.get("f167") or 0) / 100,
        "turnover": (d.get("f168") or 0) / 100, "chg": (d.get("f170") or 0) / 100,
        "high52": (d.get("f174") or 0) / 100, "low52": (d.get("f175") or 0) / 100,
    }


def fetch_main(code: str) -> list[dict]:
    mkt = "SZ" if not code.startswith("6") else "SH"
    u = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code={mkt}{code}"
    return json.loads(get(u))["data"]


def fetch_value_history(code: str) -> list[dict]:
    u = ("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET"
         "&columns=SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ,PEG_CAR,PS_TTM"
         f"&filter=(SECURITY_CODE%3D%22{code}%22)&pageNumber=1&pageSize=1600"
         "&sortColumns=TRADE_DATE&sortTypes=-1")
    j = json.loads(get(u))
    return (j.get("result") or {}).get("data") or []


def pct_rank(values: list[float], current: float) -> float | None:
    vals = [v for v in values if v is not None and v > 0 and math.isfinite(v)]
    if not vals or current is None or current <= 0:
        return None
    below = sum(1 for v in vals if v <= current)
    return below / len(vals) * 100


def fetch_news(keyword: str, size: int = 30) -> list[dict]:
    param = {
        "uid": "", "keyword": keyword, "type": ["cmsArticleWebOld"], "client": "web",
        "clientType": "web", "clientVersion": "curr",
        "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "time",
                                       "pageIndex": 1, "pageSize": size}},
    }
    u = "https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=" + urllib.parse.quote(
        json.dumps(param, ensure_ascii=False))
    raw = get(u, referer="https://so.eastmoney.com/")
    m = re.search(r"cb\((.*)\)\s*$", raw, re.S)
    if not m:
        return []
    data = json.loads(m.group(1))
    rows = ((data.get("result") or {}).get("cmsArticleWebOld")) or []
    out = []
    for r in rows:
        title = re.sub(r"<[^>]+>", "", r.get("title", ""))
        content = re.sub(r"<[^>]+>", "", r.get("content", ""))
        out.append({"date": r.get("date", ""), "title": title, "url": r.get("url", ""),
                    "media": r.get("mediaName", ""), "text": title + " " + content})
    return out


def analyze_stock(code: str, name: str) -> dict:
    quote = fetch_quote(code)
    kline = fetch_kline(code)
    main = fetch_main(code)
    vals = fetch_value_history(code)

    closes = [r["c"] for r in kline]
    last = closes[-1]
    peak2y = max(closes[-500:])
    drawdown = (last / peak2y - 1) * 100
    amounts = [r["a"] for r in kline]
    amt_ratio = (statistics.mean(amounts[-20:]) / statistics.mean(amounts[-250:])
                 if len(amounts) >= 250 else None)

    latest = main[0]
    prev = main[1] if len(main) > 1 else None
    # 同期（去年同季）
    same = None
    for row in main[1:]:
        if row.get("REPORT_DATE", "")[:4] == str(int(latest["REPORT_DATE"][:4]) - 1) and \
           row.get("REPORT_DATE", "")[5:7] == latest["REPORT_DATE"][5:7]:
            same = row
            break

    rev_yoy = latest.get("TOTALOPERATEREVETZ")
    pro_yoy = latest.get("PARENTNETPROFITTZ")
    pro_qoq = latest.get("NETPROFITRPHBZC")
    rev_qoq = latest.get("YYZSRGDHBZC")
    accel = (pro_yoy - prev.get("PARENTNETPROFITTZ")) if (prev and pro_yoy is not None and prev.get("PARENTNETPROFITTZ") is not None) else None

    gm = latest.get("XSMLL")
    gm_prev_year = same.get("XSMLL") if same else None
    gm_chg = (gm - gm_prev_year) if (gm is not None and gm_prev_year is not None) else None
    nm = latest.get("XSJLL")
    eps = latest.get("EPSJB")
    ocf_ps = latest.get("MGJYXJJE")
    ocf_ni = (ocf_ps / eps) if (eps and ocf_ps is not None and eps > 0) else None

    inv_days = latest.get("CHZZTS")
    inv_chg = (inv_days - same.get("CHZZTS")) if (same and inv_days is not None and same.get("CHZZTS") is not None) else None
    ar_days = latest.get("YSZKZZTS")
    ar_chg = (ar_days - same.get("YSZKZZTS")) if (same and ar_days is not None and same.get("YSZKZZTS") is not None) else None
    debt = latest.get("ZCFZL")
    debt_chg = (debt - same.get("ZCFZL")) if (same and debt is not None and same.get("ZCFZL") is not None) else None

    pe_hist = [v.get("PE_TTM") for v in vals]
    pb_hist = [v.get("PB_MRQ") for v in vals]
    ps_hist = [v.get("PS_TTM") for v in vals]
    pe = quote["pe"] or None
    pb = quote["pb"] or None
    pe_pct = pct_rank(pe_hist[:1250], pe) if pe else None
    pb_pct = pct_rank(pb_hist[:1250], pb) if pb else None
    ps = float(vals[0].get("PS_TTM")) if (vals and vals[0].get("PS_TTM")) else None
    ps_pct = pct_rank(ps_hist[:1250], ps) if ps else None
    peg = (pe / pro_yoy) if (pe and pro_yoy and pro_yoy > 0) else None

    growth = _wavg([
        (ramp(rev_yoy, -10, 80), 0.30),
        (ramp(pro_yoy, -20, 120), 0.35),
        (ramp(pro_qoq, -15, 25), 0.15),
        (ramp(accel, -40, 40), 0.20),
    ])
    quality = _wavg([
        (ramp(gm, 12, 55), 0.30),
        (ramp(gm_chg, -6, 6), 0.25),
        (ramp(nm, 2, 30), 0.20),
        (ramp(ocf_ni, 0.2, 1.2), 0.25),
    ])
    supply = _wavg([
        (ramp(inv_chg, 25, -25), 0.30),
        (ramp(ar_chg, 25, -25), 0.30),
        (ramp(debt_chg, 10, -10), 0.20),
        (ramp(gm_chg, -6, 6), 0.20),
    ])
    if pe and pe > 0:
        valuation = _wavg([
            ((100 - pe_pct) if pe_pct is not None else None, 0.50),
            ((100 - pb_pct) if pb_pct is not None else None, 0.25),
            (ramp(peg, 3.0, 0.6), 0.25),
        ])
    else:
        # 亏损公司 PE 失效，用 PS + PB 分位
        valuation = _wavg([
            ((100 - ps_pct) if ps_pct is not None else None, 0.60),
            ((100 - pb_pct) if pb_pct is not None else None, 0.40),
        ])
    crowd = _wavg([
        (ramp(quote["turnover"], 8, 1), 0.40),
        (ramp(amt_ratio, 2.0, 0.6), 0.30),
        (ramp(drawdown, -10, -60), 0.30),
    ])
    total = _wavg([
        (growth, 0.25), (quality, 0.20), (supply, 0.15),
        (valuation, 0.20), (crowd, 0.10),
    ])

    return {
        "code": code, "name": name, "price": round(last, 2), "chg": quote["chg"],
        "mcap": quote["mcap"], "pe": pe, "pb": pb, "pePct": pe_pct, "pbPct": pb_pct,
        "ps": ps, "psPct": ps_pct,
        "peg": peg, "drawdown": round(drawdown, 1), "turnover": quote["turnover"],
        "amtRatio": round(amt_ratio, 2) if amt_ratio else None,
        "revYoy": rev_yoy, "proYoy": pro_yoy, "proQoq": pro_qoq, "revQoq": rev_qoq,
        "accel": accel, "gm": gm, "gmChg": gm_chg, "nm": nm, "ocfNi": ocf_ni,
        "invDays": inv_days, "invChg": inv_chg, "arDays": ar_days, "arChg": ar_chg,
        "debt": debt, "debtChg": debt_chg, "report": latest.get("REPORT_DATE_NAME"),
        "scores": {
            "growth": _r(growth), "quality": _r(quality), "supply": _r(supply),
            "valuation": _r(valuation), "crowd": _r(crowd), "total": _r(total),
        },
    }


def _wavg(pairs):
    num = 0.0
    den = 0.0
    for val, w in pairs:
        if val is None:
            continue
        num += val * w
        den += w
    return num / den if den else None


def _r(v):
    return round(v, 1) if v is not None else None


def overseas_factor() -> tuple[float, str]:
    """读取海外新闻影响因子；超过 48 小时视为过期，回到中性 50。"""
    try:
        doc = json.loads(OVERSEAS_PATH.read_text(encoding="utf-8"))
        updated = doc.get("updatedAt", "")
        ts = dt.datetime.strptime(updated, "%Y-%m-%d %H:%M")
        if (dt.datetime.now() - ts).total_seconds() > 48 * 3600:
            return 50.0, updated + "（已过期）"
        return float(doc.get("score", 50)), updated
    except Exception:  # noqa: BLE001
        return 50.0, ""


def industry_score(inp: dict) -> float | None:
    """行业级手工输入：capex 增速、capex 趋势、产品价格、订单能见度、产能利用率。"""
    if not inp:
        return None
    capex = inp.get("capexGrowth")
    trend = inp.get("capexTrend")
    price = inp.get("priceChange")
    order = inp.get("orderCoverage")
    util = inp.get("capacityUtil")
    parts = [
        (ramp(capex, 0, 60), 0.30),
        ({"up": 100.0, "flat": 55.0, "down": 15.0}.get(trend), 0.20),
        (ramp(price, -20, 5), 0.20),
        (ramp(order, 1, 4), 0.15),
        (ramp(util, 60, 90), 0.15),
    ]
    return _wavg(parts)


def classify(basket: dict) -> tuple[str, list[str]]:
    g, q, v = basket.get("growth"), basket.get("quality"), basket.get("valuation")
    dd, acc, ind = basket.get("drawdown"), basket.get("accel"), basket.get("industry")
    reasons = []
    if g is None:
        return "数据不足", reasons
    if g < 35 and (q or 0) < 45:
        reasons.append(f"景气 {g:.0f}、盈利 {q:.0f}：增长与盈利同步走弱")
        return "阶段5 出清/衰退", reasons
    if g < 45 and (q or 0) >= 45 and (v or 100) < 40 and (dd is None or dd > -50):
        reasons.append(f"景气 {g:.0f} 尚未兑现、估值 {v:.0f} 偏贵：估值先行")
        return "阶段1 导入期", reasons
    if g >= 55 and (acc is None or acc > -10) and (dd is None or dd > -25) and (ind is None or ind >= 50):
        reasons.append(f"景气 {g:.0f}、增速仍在加速、股价距 2 年高点 {dd:.0f}%")
        return "阶段2 加速期", reasons
    if g >= 60 and (v or 100) < 30 and (dd is None or dd > -20):
        reasons.append(f"景气 {g:.0f} 但估值已贵、股价仍在高位")
        return "阶段3 泡沫/拥挤顶", reasons
    if g >= 35 and ((acc is not None and acc < 0) or (dd is not None and dd < -40)
                    or (ind is not None and ind < 45)):
        if acc is not None:
            reasons.append(f"增速二阶导 {acc:+.0f}pct")
        if dd is not None:
            reasons.append(f"股价距 2 年高点 {dd:.0f}%")
        if ind is not None and ind < 45:
            reasons.append(f"行业输入 {ind:.0f}：capex/价格转弱")
        return "阶段4 杀估值", reasons
    reasons.append("增长、估值与筹码均处于中间地带")
    return "过渡期", reasons


def run() -> dict:
    now = dt.datetime.now()
    try:
        inputs = json.loads(INPUTS_PATH.read_text(encoding="utf-8"))
        if not isinstance(inputs, dict):
            inputs = {}
    except Exception:  # noqa: BLE001
        inputs = {}
    out = {"updatedAt": now.strftime("%Y-%m-%d %H:%M"), "themes": []}
    for theme in THEMES:
        stocks = []
        for code, name in theme["stocks"]:
            try:
                stocks.append(analyze_stock(code, name))
                print(f"[ok] {theme['id']} {code} {name}", file=sys.stderr)
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {code} {name}: {exc}", file=sys.stderr)
            time.sleep(0.15)

        if not stocks:
            continue
        basket = {k: median([s["scores"].get(k) for s in stocks])
                  for k in ("growth", "quality", "supply", "valuation", "crowd", "total")}
        basket["drawdown"] = median([s["drawdown"] for s in stocks])
        basket["accel"] = median([s["accel"] for s in stocks])
        news = []
        try:
            news = fetch_news(theme["keyword"], 30)
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] news {theme['keyword']}: {exc}", file=sys.stderr)
        # 只保留与主题相关的资讯，避免关键词搜到的泛财经新闻干扰
        matched = [n for n in news if any(k.lower() in n["text"].lower() for k in theme.get("match", []))]
        if len(matched) >= 5:
            news = matched
        pos = sum(1 for n in news for w in POS if w in n["text"])
        neg = sum(1 for n in news for w in NEG if w in n["text"])
        senti = (pos - neg) / (pos + neg) * 100 if (pos + neg) else 0
        hot = min(100, len(news) / 30 * 100)
        # 新闻只做温和修正：情绪权重低、热度反向，避免"利好刷屏"被当成高分
        news_score = 50 + senti * 0.2 - (hot - 50) * 0.15
        news_score = max(15, min(85, news_score))
        overseas, overseas_at = overseas_factor()
        combined_news = news_score * 0.6 + overseas * 0.4
        basket["news"] = round(combined_news, 1)
        basket["newsDomestic"] = round(news_score, 1)
        basket["overseas"] = round(overseas, 1)
        inp = inputs.get(theme["id"]) or {}
        ind = industry_score(inp)
        basket["industry"] = round(ind, 1) if ind is not None else None
        auto_total = _wavg([
            (basket["growth"], 0.25), (basket["quality"], 0.20), (basket["supply"], 0.15),
            (basket["valuation"], 0.20), (basket["crowd"], 0.10), (basket["news"], 0.10),
        ])
        # 行业手工输入占 15%，其余自动指标按原比例缩放到 85%
        total = (auto_total * 0.85 + ind * 0.15) if (ind is not None and auto_total is not None) else auto_total
        basket["total"] = round(total, 1)
        for key, value in list(basket.items()):
            if isinstance(value, float):
                basket[key] = round(value, 1)
        stage, reasons = classify(basket)
        out["themes"].append({
            "id": theme["id"], "name": theme["name"], "keyword": theme["keyword"],
            "stocks": stocks, "basket": basket, "stage": stage, "reasons": reasons,
            "inputs": inp, "industry": basket["industry"],
            "overseasAt": overseas_at,
            "news": [{"date": n["date"][:16], "title": n["title"], "url": n["url"], "media": n["media"]}
                     for n in news[:14]],
            "newsStats": {"count": len(news), "pos": pos, "neg": neg, "score": round(news_score, 1)},
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written {OUT}", file=sys.stderr)
    return out


if __name__ == "__main__":
    data = run()
    for t in data["themes"]:
        b = t["basket"]
        print(f"{t['name']}: 总分 {b['total']} | 景气 {b['growth']} 盈利 {b['quality']} "
              f"供给 {b['supply']} 估值 {b['valuation']} 拥挤 {b['crowd']} 新闻 {b['news']} -> {t['stage']}")
