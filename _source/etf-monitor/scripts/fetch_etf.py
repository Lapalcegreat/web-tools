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
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

START_DATE = "2026-06-01"
TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai，无夏令时
KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

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

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
}


def now_shanghai() -> dt.datetime:
    return dt.datetime.now(TZ)


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
    raise RuntimeError(f"抓取 {secid} 失败: {last_err}")


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

    total = sum(len(e["bars"]) for e in out_etfs)
    print(f"\n写入 {JSON_PATH}  ({len(out_etfs)} 只 ETF / {total} 根日 K, "
          f"最新交易日 {latest})")
    if failures:
        print(f"失败代码: {', '.join(failures)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
