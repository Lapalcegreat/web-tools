#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取 A 股宽基 ETF 的日 K 线（东方财富公开行情接口），增量写入本地数据文件。

用法:
    python scripts/fetch_etf.py            # 增量更新（默认）
    python scripts/fetch_etf.py --full     # 从 START_DATE 全量重抓
    python scripts/fetch_etf.py --start 2026-06-01

数据写入:
    etf-dashboard/data/etf-daily.json     # 结构化数据（插件/仪表盘读取）
    etf-dashboard/data/etf-data.js        # window.ETF_DATA，供 file:// 直接打开
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

START_DATE = "2026-06-01"
TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai，无夏令时
KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline"

# 各板块代表性宽基 ETF（同一指数取规模/流动性最好的一只）
ETFS = [
    {"code": "510050", "secid": "1.510050", "name": "上证50ETF", "sector": "上证50", "index": "000016.SH"},
    {"code": "510300", "secid": "1.510300", "name": "沪深300ETF", "sector": "沪深300", "index": "000300.SH"},
    {"code": "510500", "secid": "1.510500", "name": "中证500ETF", "sector": "中证500", "index": "000905.SH"},
    {"code": "512100", "secid": "1.512100", "name": "中证1000ETF", "sector": "中证1000", "index": "000852.SH"},
    {"code": "563300", "secid": "1.563300", "name": "中证2000ETF", "sector": "中证2000", "index": "932000.CSI"},
    {"code": "563360", "secid": "1.563360", "name": "A500ETF", "sector": "中证A500", "index": "000510.SH"},
    {"code": "159915", "secid": "0.159915", "name": "创业板ETF", "sector": "创业板指", "index": "399006.SZ"},
    {"code": "588000", "secid": "1.588000", "name": "科创50ETF", "sector": "科创50", "index": "000688.SH"},
    {"code": "588120", "secid": "1.588120", "name": "科创100ETF", "sector": "科创100", "index": "000698.SH"},
    {"code": "159901", "secid": "0.159901", "name": "深证100ETF", "sector": "深证100", "index": "399330.SZ"},
    {"code": "159781", "secid": "0.159781", "name": "科创创业ETF", "sector": "双创50", "index": "931643.CSI"},
    {"code": "560050", "secid": "1.560050", "name": "中国A50ETF", "sector": "MSCI中国A50", "index": "930050.CSI"},
]

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "etf-dashboard" / "data"
JSON_PATH = DATA_DIR / "etf-daily.json"
JS_PATH = DATA_DIR / "etf-data.js"
SHARES_PATH = DATA_DIR / "etf-shares.json"
FLOWS_PATH = DATA_DIR / "etf-flows.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
}


def now_shanghai() -> dt.datetime:
    return dt.datetime.now(TZ)


def fetch_klines_tencent(secid: str, beg: str) -> list[list]:
    """东财限流时的日 K 兜底：腾讯日线，成交额按 量(手)×100×收盘 估算。"""
    code = secid.split(".")[-1]
    prefix = "sh" if code.startswith(("6", "5")) else "sz"
    beg_date = f"{beg[:4]}-{beg[4:6]}-{beg[6:]}" if len(beg) == 8 else beg
    query = urllib.parse.urlencode({"param": f"{prefix}{code},day,,,640"})
    req = urllib.request.Request(
        f"{TENCENT_KLINE_URL}?{query}",
        headers={**HEADERS, "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    block = payload["data"][f"{prefix}{code}"]
    rows = block.get("day") or block.get("qfqday") or []
    out = []
    prev_close = None
    for row in rows:
        date = row[0]
        if date < beg_date:
            continue
        open_, close, high, low, volume = (float(row[1]), float(row[2]), float(row[3]),
                                           float(row[4]), float(row[5]))
        amplitude = ((high - low) / prev_close * 100) if prev_close else 0.0
        out.append([date, open_, close, high, low, volume, volume * 100 * close, amplitude])
        prev_close = close
    return out


def fetch_klines(secid: str, beg: str, end: str = "20500101") -> list[list]:
    """返回 [[date, open, close, high, low, volume(手), amount(元), amplitude], ...]。"""
    query = urllib.parse.urlencode({
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "klt": "101",      # 日线
        "fqt": "1",        # 前复权
        "beg": beg,
        "end": end,
        "lmt": "10000",
    })
    url = f"{KLINE_URL}?{query}"
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            data = payload.get("data")
            if not data or not data.get("klines"):
                raise ValueError(f"接口无数据: {payload.get('rc')}")
            rows = []
            for line in data["klines"]:
                p = line.split(",")
                rows.append([p[0], float(p[1]), float(p[2]), float(p[3]),
                             float(p[4]), float(p[5]), float(p[6]),
                             float(p[7]) if len(p) > 7 else 0.0])
            return rows
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(1.2 * (attempt + 1))
    try:
        return fetch_klines_tencent(secid, beg)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"抓取 {secid} 失败: {last_err} / 腾讯: {exc}")


def load_existing() -> dict:
    if not JSON_PATH.exists():
        return {}
    try:
        return json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def merge_bars(old: list[list], new: list[list]) -> list[list]:
    by_date = {row[0]: row for row in old}
    for row in new:
        by_date[row[0]] = row
    return [by_date[d] for d in sorted(by_date)]


def write_outputs(doc: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    tmp = JSON_PATH.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, JSON_PATH)
    js_tmp = JS_PATH.with_suffix(".js.tmp")
    js_tmp.write_text("window.ETF_DATA=" + text + ";\n", encoding="utf-8")
    os.replace(js_tmp, JS_PATH)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="忽略本地缓存，从起始日全量抓取")
    parser.add_argument("--start", default=START_DATE)
    args = parser.parse_args()

    now = now_shanghai()
    today = now.strftime("%Y-%m-%d")
    # 09:15–15:00 视为盘中（含集合竞价），此时当日 K 线尚未定格
    market_open = now.weekday() < 5 and dt.time(9, 15) <= now.time() < dt.time(15, 0)
    trading_closed = not market_open

    existing = {} if args.full else load_existing()
    old_etfs = {e["code"]: e for e in existing.get("etfs", [])}

    out_etfs = []
    failures = []
    for item in ETFS:
        code = item["code"]
        old_bars = old_etfs.get(code, {}).get("bars", [])
        # 增量：从最后一条日期前推 7 个自然日重新对齐，顺带修正除权/数据订正
        if old_bars:
            last = dt.date.fromisoformat(old_bars[-1][0])
            beg_date = max(dt.date.fromisoformat(args.start), last - dt.timedelta(days=7))
        else:
            beg_date = dt.date.fromisoformat(args.start)
        try:
            fresh = fetch_klines(item["secid"], beg_date.strftime("%Y%m%d"))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {code} {item['name']}: {exc}", file=sys.stderr)
            failures.append(code)
            if old_bars:
                out_etfs.append({**item, "bars": old_bars})
            continue

        fresh = [r for r in fresh if r[0] >= args.start]
        if market_open:
            fresh = [r for r in fresh if r[0] != today]
        bars = merge_bars(old_bars, fresh)
        if not bars:
            failures.append(code)
            continue
        out_etfs.append({**item, "bars": bars})
        print(f"[ok]   {code} {item['name']:<12} {len(bars):>4} 根  {bars[-1][0]}  "
              f"收 {bars[-1][2]:.3f}")

    if not out_etfs:
        print("没有抓到任何数据，保留原文件。", file=sys.stderr)
        return 1

    latest = max(e["bars"][-1][0] for e in out_etfs)
    old_latest = existing.get("latestTradeDate")
    old_counts = {c: len(e.get("bars", [])) for c, e in old_etfs.items()}
    changed = args.full or old_latest != latest or any(
        len(e["bars"]) != old_counts.get(e["code"], 0) for e in out_etfs
    )
    if not changed:
        print(f"无新交易日数据（最新 {latest}），跳过写入。")
        if existing.get("etfs"):
            try:
                update_flows(existing)
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] 资金流更新失败: {exc}", file=sys.stderr)
        return 0

    doc = {
        "schema": 1,
        "source": "eastmoney",
        "start": args.start,
        "updatedAt": now.strftime("%Y-%m-%d %H:%M:%S"),
        "updatedAtISO": now.isoformat(timespec="seconds"),
        "latestTradeDate": latest,
        "tradingClosed": trading_closed,
        "volumeUnit": "手",
        "amountUnit": "元",
        "fields": ["date", "open", "close", "high", "low", "volume", "amount", "amplitude"],
        "etfs": out_etfs,
    }
    write_outputs(doc)
    try:
        update_flows(doc)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] 资金流更新失败: {exc}", file=sys.stderr)

    total = sum(len(e["bars"]) for e in out_etfs)
    print(f"\n写入 {JSON_PATH}  ({len(out_etfs)} 只 ETF / {total} 根日 K, "
          f"最新交易日 {latest})")
    if failures:
        print(f"失败代码: {', '.join(failures)}", file=sys.stderr)
        return 2
    return 0


def fetch_share_snapshot() -> dict:
    """收盘后抓一次 ETF 总份额（f84，单位份 → 亿份）。"""
    out = {}
    for item in ETFS:
        q = urllib.parse.urlencode({"secid": item["secid"], "fields": "f84"})
        try:
            req = urllib.request.Request(
                "https://push2.eastmoney.com/api/qt/stock/get?" + q, headers=HEADERS)
            data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))["data"]
            if data and data.get("f84"):
                out[item["code"]] = round(float(data["f84"]) / 1e8, 4)
        except Exception:  # noqa: BLE001
            continue
    return out


def fetch_tail_ratio(secid: str) -> float | None:
    """尾盘 14:30-15:00 成交额占全天比例（用 1 分钟行情）。"""
    query = urllib.parse.urlencode({
        "secid": secid, "fields1": "f1,f2,f3,f4,f5,f6,f7,f8",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "iscr": "0", "ndays": "1",
    })
    try:
        req = urllib.request.Request(
            "https://push2his.eastmoney.com/api/qt/stock/trends2/get?" + query, headers=HEADERS)
        data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))["data"]
        rows = data.get("trends") or []
        total = tail = 0.0
        for line in rows:
            parts = line.split(",")
            if len(parts) < 7:
                continue
            amount = float(parts[6])
            total += amount
            if parts[0][-5:] >= "14:30":
                tail += amount
        return round(tail / total, 4) if total else None
    except Exception:  # noqa: BLE001
        return None


def fetch_nav(code: str) -> tuple[str, float] | tuple[None, None]:
    """最新基金单位净值（用于算溢价率）。"""
    try:
        req = urllib.request.Request(
            f"https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=1",
            headers={**HEADERS, "Referer": "http://fundf10.eastmoney.com/"})
        data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
        row = data["Data"]["LSJZList"][0]
        return row["FSRQ"], float(row["DWJZ"])
    except Exception:  # noqa: BLE001
        return None, None


def fetch_index_change() -> float | None:
    try:
        req = urllib.request.Request(
            "https://push2.eastmoney.com/api/qt/stock/get?secid=1.000300&fields=f170",
            headers=HEADERS)
        data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))["data"]
        return round(float(data["f170"]) / 100, 2)
    except Exception:  # noqa: BLE001
        return None


def fetch_nav_history(code: str, pages: int = 3) -> dict:
    """最近约 60 个交易日的单位净值（接口每页 20 条，翻页补齐）。"""
    out = {}
    for page in range(1, pages + 1):
        try:
            req = urllib.request.Request(
                f"https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex={page}&pageSize=20",
                headers={**HEADERS, "Referer": "http://fundf10.eastmoney.com/"})
            data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
            rows = data["Data"]["LSJZList"]
            for r in rows:
                if r.get("DWJZ"):
                    out[r["FSRQ"]] = float(r["DWJZ"])
            if len(rows) < 20:
                break
        except Exception:  # noqa: BLE001
            break
        time.sleep(0.15)
    return out


def update_flows(doc: dict) -> None:
    """记录份额快照；净申购自首次记录起，溢价率/量比可回补到 9 月。"""
    today = doc["latestTradeDate"]
    history = {}
    if SHARES_PATH.exists():
        try:
            history = json.loads(SHARES_PATH.read_text(encoding="utf-8")).get("history", {})
        except Exception:  # noqa: BLE001
            history = {}

    snap = fetch_share_snapshot()
    if snap:
        history[today] = snap
    for old in sorted(history)[:-400]:
        history.pop(old, None)
    SHARES_PATH.write_text(
        json.dumps({"updatedAt": doc["updatedAt"], "history": history}, ensure_ascii=False),
        encoding="utf-8")

    bars_list = {e["code"]: e["bars"] for e in doc["etfs"]}
    closes = {code: {b[0]: b[2] for b in bars} for code, bars in bars_list.items()}
    navs = {code: fetch_nav_history(code) for code in bars_list}

    # 每个交易日的量比 = 成交额 / 前 20 日均额
    ratios = {}
    for code, bars in bars_list.items():
        table = {}
        for i in range(20, len(bars)):
            avg = sum(b[6] for b in bars[i - 20:i]) / 20
            if avg:
                table[bars[i][0]] = round(bars[i][6] / avg, 2)
        ratios[code] = table

    # 有份额快照的日期才能算净申购
    share_totals = {}
    last_known = {}
    for date in sorted(history):
        total = 0.0
        has_value = False
        for code in bars_list:
            cur = history[date].get(code)
            prev = last_known.get(code)
            if cur is not None and prev is not None and date in closes[code]:
                total += (cur - prev) * closes[code][date]
                has_value = True
            if cur is not None:
                last_known[code] = cur
        share_totals[date] = round(total, 2) if has_value else None

    # 图表横轴：最近 45 个交易日（约覆盖 9 月中至今）
    all_dates = sorted({b[0] for bars in bars_list.values() for b in bars[-45:]})
    rows = []
    for date in all_dates:
        prem_vals = []
        amt_vals = []
        for code in bars_list:
            nav = navs[code].get(date)
            close = closes[code].get(date)
            if nav and close:
                prem_vals.append((close / nav - 1) * 100)
            if date in ratios[code]:
                amt_vals.append(ratios[code][date])
        rows.append({
            "date": date,
            "total": share_totals.get(date),
            "premium": round(sorted(prem_vals)[len(prem_vals) // 2], 3) if prem_vals else None,
            "amtRatio": round(sorted(amt_vals)[len(amt_vals) // 2], 2) if amt_vals else None,
        })
    for i, row in enumerate(rows):
        vals = [x["total"] for x in rows[max(0, i - 4):i + 1] if x["total"] is not None]
        row["cum5"] = round(sum(vals), 2) if vals else None

    etfs = []
    for etf in doc["etfs"]:
        code = etf["code"]
        shares = history[today].get(code) if today in history else None
        prev = None
        for date in reversed([d for d in sorted(history) if d < today]):
            if code in history[date]:
                prev = history[date][code]
                break
        net = None
        if shares is not None and prev is not None and today in closes[code]:
            net = round((shares - prev) * closes[code][today], 2)
        tail = fetch_tail_ratio(etf["secid"])
        nav = navs[code].get(today)
        premium = round((closes[code][today] / nav - 1) * 100, 3) if (nav and today in closes[code]) else None
        etfs.append({
            "code": code, "name": etf["name"], "shares": shares, "net": net,
            "amount": etf["bars"][-1][6],
            "amtRatio": ratios[code].get(today),
            "tail": tail, "premium": premium, "navDate": today if nav else None,
        })

    index_chg = fetch_index_change()
    last = rows[-1] if rows else {}
    net5 = last.get("cum5")
    tail_med = sorted([e["tail"] for e in etfs if e["tail"] is not None])
    tail_med = tail_med[len(tail_med) // 2] if tail_med else None
    prem_med = last.get("premium")
    amt_med = last.get("amtRatio")

    s1 = math.tanh((net5 or 0) / 120) if net5 is not None else 0.0
    s2 = math.tanh(((tail_med or 0.18) - 0.18) / 0.12) if tail_med is not None else 0.0
    s3 = math.tanh((prem_med or 0) / 0.4) if prem_med is not None else 0.0
    s4 = math.tanh(((amt_med or 1) - 1) / 1.2) if amt_med is not None else 0.0
    s5 = math.tanh(-(index_chg or 0) / 1.5)
    score = 50 + 50 * (0.30 * s1 + 0.20 * s2 + 0.20 * s3 + 0.15 * s4 + 0.15 * s5)
    score = round(max(2, min(98, score)), 1)

    FLOWS_PATH.write_text(json.dumps({
        "updatedAt": doc["updatedAt"],
        "note": "柱=每日净申购（亿元，自首次份额快照起）；线=溢价率中位数（%）；量比=成交额/20日均额",
        "history": rows,
        "etfs": etfs,
        "indexChg": index_chg,
        "score": score,
        "scoreParts": {
            "net5": net5, "tail": tail_med, "premium": prem_med,
            "amtRatio": amt_med, "indexChg": index_chg,
        },
    }, ensure_ascii=False), encoding="utf-8")
    latest = last.get("total")
    print(f"资金流: {len(rows)} 个交易日，最新净申购 {latest if latest is not None else '基准日'} 亿元")


if __name__ == "__main__":
    sys.exit(main())
