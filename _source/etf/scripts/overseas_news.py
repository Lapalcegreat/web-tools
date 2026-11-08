#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取海外 AI 产业链新闻，先做可信度过滤，再按来源、时效、事件方向计算「影响因子」。

可信度（confidence 0-1）规则：
- 来源层级：一线财经/官方 0.8、垂直媒体 0.62、研究博客 0.65、厂商博客 0.4
- 传闻措辞（reportedly / sources say / may / in talks…）扣分
- 官方措辞（announces / confirms / guidance / 8-K…）加分
- 多源交叉：同一事件被 ≥2 个独立来源报道再加分
- 只有 confidence ≥ 0.55 且 |impact| ≥ 0.4 的条目才进入影响因子；其余进「待核实」列表，不参与评分。

输出 etf-dashboard/cycle/overseas.json。
"""
from __future__ import annotations

import email.utils
import gzip
import hashlib
import html as html_lib
import json
import re
import socket
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "etf-dashboard" / "cycle" / "overseas.json"
LOG = ROOT / "logs" / "news-update.log"

socket.setdefaulttimeout(12)

HEAD = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0"}

# (名称, RSS, 层级)
FEEDS = [
    ("WSJ Tech", "https://feeds.a.dj.com/rss/RSSWSJD.xml", "major"),
    ("CNBC Tech", "https://www.cnbc.com/id/19854910/device/rss/rss.html", "major"),
    ("CNBC AI", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "major"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories", "major"),
    ("SemiAnalysis", "https://semianalysis.com/feed/", "research"),
    ("The Verge", "https://www.theverge.com/rss/index.xml", "major"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/technology-lab", "major"),
    ("TechCrunch", "https://techcrunch.com/feed/", "trade"),
    ("Tom's Hardware", "https://www.tomshardware.com/feeds/all", "trade"),
    ("NVIDIA Blog", "https://blogs.nvidia.com/feed/", "vendor"),
    ("Light Reading", "https://www.lightreading.com/rss.xml", "trade"),
]

TIER_CONF = {"major": 0.8, "research": 0.65, "trade": 0.62, "vendor": 0.4, "blog": 0.45, "primary": 0.95}
TIER_WEIGHT = {"major": 1.0, "research": 0.85, "trade": 0.7, "vendor": 0.45, "blog": 0.45, "primary": 1.0}

# SEC EDGAR 一手文件：公司名、CIK、标题匹配用的别名
PRIMARY = [
    ("NVIDIA", "0001045810", ["nvidia"]),
    ("Microsoft", "0000789019", ["microsoft", "azure"]),
    ("Alphabet", "0001652044", ["alphabet", "google"]),
    ("Amazon", "0001018724", ["amazon", "aws"]),
    ("Meta", "0001326801", ["meta platforms", "meta"]),
    ("Broadcom", "0001730168", ["broadcom"]),
    ("Marvell", "0001835632", ["marvell"]),
    ("Coherent", "0000820318", ["coherent"]),
    ("Lumentum", "0001633978", ["lumentum"]),
    ("Fabrinet", "0001408710", ["fabrinet"]),
    ("Arista", "0001596532", ["arista"]),
    ("Vertiv", "0001674101", ["vertiv"]),
    ("TSMC", "0001046179", ["tsmc", "taiwan semiconductor"]),
    ("Micron", "0000723125", ["micron"]),
    ("AMD", "0000002488", ["amd", "advanced micro devices"]),
]
PRIMARY_FORMS = {"8-K", "8-K/A", "10-Q", "10-K", "6-K", "20-F"}
SEC_UA = {"User-Agent": "dsh-etf-charts/0.1 (research; contact: dsh@localhost)"}

# 8-K item → 方向分（只有明确利空/利多的 item 才给分，业绩本身方向未知记 0）
ITEM_IMPACT = {
    "1.01": 0.6, "1.02": -1.2, "1.03": -3.0,
    "2.01": 0.4, "2.02": 0.0, "2.03": 0.0,
    "2.05": -1.5, "2.06": -1.8,
    "3.01": -2.0, "3.02": -0.5, "3.03": -0.5,
    "4.01": -0.8, "4.02": -2.0,
    "5.01": 0.0, "5.02": -0.2, "5.03": 0.0,
    "7.01": 0.0, "8.01": 0.0, "9.01": 0.0,
}
ITEM_LABEL = {
    "1.01": "重大合同", "1.02": "合同终止", "1.03": "破产",
    "2.01": "完成收购", "2.02": "业绩", "2.03": "债务/担保",
    "2.05": "重组费用", "2.06": "资产减值",
    "3.01": "退市警告", "4.02": "财报重述",
    "5.02": "高管变动", "7.01": "FD披露", "8.01": "其他事项",
}

# Exhibit 99.1 业绩新闻稿里的措辞 → 方向分（短语, 中文标签, 分值）
EARN_POS = [
    ("raises guidance", "上调指引", 2.0), ("raised guidance", "上调指引", 2.0),
    ("raises outlook", "上调展望", 2.0), ("raised outlook", "上调展望", 2.0),
    ("record revenue", "营收创新高", 1.0), ("record quarterly", "季度新高", 0.8),
    ("exceeded guidance", "超指引", 1.5), ("beat expectations", "超预期", 1.5),
    ("strong demand", "需求强劲", 0.8),
]
EARN_NEG = [
    ("lowered guidance", "下调指引", -2.0), ("lowers guidance", "下调指引", -2.0),
    ("cuts outlook", "下调展望", -2.0), ("cut outlook", "下调展望", -2.0),
    ("below guidance", "低于指引", -1.5), ("missed expectations", "不及预期", -1.5),
    ("weak demand", "需求走弱", -1.0), ("decline in revenue", "营收下滑", -1.0),
]

RELEVANT = {
    "capex": 3, "capital expenditure": 3, "data center": 2.5, "datacenter": 2.5,
    "gpu": 2, "nvidia": 2, "optical": 3, "transceiver": 3, "800g": 3, "1.6t": 3,
    "hbm": 2, "cowos": 2, "tsmc": 2, "hyperscaler": 3, "microsoft": 1.2,
    "google": 1.2, "amazon": 1.2, "meta": 1.2, "oracle": 1.2, "openai": 1.5,
    "broadcom": 2, "marvell": 2, "coherent": 1.5, "lumentum": 2, "fabrinet": 2,
    "semiconductor": 1, "chip": 1, "server": 1.2, "cloud": 1, "ai": 1,
    "cooling": 1.2, "power": 0.8,
}

POS = [
    ("raise", 2), ("raised", 2), ("boost", 2), ("increase", 1.5), ("record", 2),
    ("beat", 1.5), ("sold out", 2.5), ("shortage", 2), ("ramp", 1.5), ("backlog", 1.5),
    ("multi-year", 1.5), ("expand", 1.5), ("strong demand", 2), ("order", 1),
    ("1.6t", 1.5), ("800g", 1), ("guidance raise", 2.5), ("capex raise", 3),
    ("wins", 2), ("contract", 1.5), ("deal", 1.2), ("partnership", 1.2),
    ("approval", 1), ("investment", 1), ("funding", 0.6), ("valuation", 0.3),
]
NEG = [
    ("cut", 2), ("cuts", 2), ("slowdown", 2), ("slow", 1), ("delay", 1.5),
    ("cancel", 2), ("oversupply", 2.5), ("price cut", 2), ("export control", 2.5),
    ("ban", 2), ("restrict", 1.5), ("curb", 1.8), ("crackdown", 2), ("probe", 1.5),
    ("investigation", 1.5), ("antitrust", 1.5), ("digestion", 2), ("pause", 1.5),
    ("miss", 1.5), ("weak", 1), ("layoff", 1.5), ("tariff", 1), ("capex cut", 3),
    ("order cut", 3), ("writedown", 2), ("selloff", 1.5), ("plunge", 1.5),
    ("slump", 1.5), ("drop", 1), ("constraint", 1.2), ("power shortage", 2),
    ("denies", 1.5), ("denied", 1.5), ("lawsuit", 1.2), ("fraud", 2.5),
]
RISK = [("cpo", 1.2), ("co-packaged", 1.5), ("silicon photonics", 1.2)]

CATEGORY_MULT = {"capex": 1.5, "监管": 1.4, "订单": 1.3, "价格": 1.3, "技术": 1.0}

RUMOR_STRONG = ("reportedly", "sources say", "people familiar", "said to", "rumor",
                "unconfirmed", "speculation", "in talks", "weighing", "considering",
                "plans to", "expected to", "may ", "could ", "might ")
OFFICIAL = ("announces", "announced", "confirms", "confirmed", "official", "guidance",
            "8-k", "earnings", "signed", "approves", "approved", "files")

STOP = set("the a an of to in on for and or with as at by from is are was were be this that it its "
           "new says say report reports update live".split())


def log(message: str) -> None:
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}\n")
    except Exception:  # noqa: BLE001
        pass


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=HEAD)
    return urllib.request.urlopen(req, timeout=12).read()


def fetch_bounded(url: str, timeout: float = 14) -> bytes:
    box: dict = {}

    def work() -> None:
        try:
            box["data"] = fetch(url)
        except Exception as exc:  # noqa: BLE001
            box["err"] = exc

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"feed timeout {timeout}s")
    if "err" in box:
        raise box["err"]
    return box["data"]


def parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    text = text.strip()
    try:
        dt = email.utils.parsedate_to_datetime(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def parse_feed(raw: bytes) -> list[dict]:
    root = ET.fromstring(raw)
    atom = "{http://www.w3.org/2005/Atom}"
    out = []
    for item in root.findall(".//item"):
        out.append({
            "title": (item.findtext("title") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "desc": re.sub(r"<[^>]+>", " ", item.findtext("description") or ""),
            "time": parse_time(item.findtext("pubDate") or item.findtext("date")),
        })
    for entry in root.findall(f".//{atom}entry"):
        el = entry.find(f"{atom}link")
        out.append({
            "title": (entry.findtext(f"{atom}title") or "").strip(),
            "link": (el.get("href") if el is not None else "") or "",
            "desc": re.sub(r"<[^>]+>", " ", entry.findtext(f"{atom}summary") or entry.findtext(f"{atom}content") or ""),
            "time": parse_time(entry.findtext(f"{atom}published") or entry.findtext(f"{atom}updated")),
        })
    return out


def relevance(text: str) -> float:
    return sum(w for k, w in RELEVANT.items() if k in text)


def impact_of(title: str, desc: str) -> tuple[float, list[str]]:
    text = (title + " " + desc).lower()

    def raw(src: str) -> float:
        pos = sum(w for k, w in POS if k in src)
        neg = sum(w for k, w in NEG if k in src)
        risk = sum(w for k, w in RISK if k in src)
        return pos - neg - risk * 0.4

    score = raw(title.lower()) + raw(desc.lower()) * 0.15
    tags = []
    if any(k in text for k in ("capex", "capital expenditure", "spending", "guidance")):
        tags.append("capex")
    if any(k in text for k in ("order", "backlog", "demand", "shipment")):
        tags.append("订单")
    if any(k in text for k in ("price", "pricing", "cost")):
        tags.append("价格")
    if any(k in text for k in ("cpo", "co-packaged", "silicon photonics", "1.6t", "800g")):
        tags.append("技术")
    if any(k in text for k in ("export control", "ban", "tariff", "restrict", "curb", "sanction")):
        tags.append("监管")
    mult = max([CATEGORY_MULT[t] for t in tags], default=1.0)
    if any(k in text for k in ("funding", "valuation", "raises", "ipo")):
        mult *= 0.7
    return score * mult, tags


def confidence_of(title: str, desc: str, tier: str) -> float:
    text = (title + " " + desc).lower()
    conf = TIER_CONF.get(tier, 0.5)
    conf -= 0.22 * sum(1 for k in RUMOR_STRONG if k in text)
    conf += 0.12 * sum(1 for k in OFFICIAL if k in text)
    return max(0.1, min(0.95, conf))


def tokens(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 2 and w not in STOP}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def cluster_items(items: list[dict]) -> list[dict]:
    clusters: list[dict] = []
    for item in sorted(items, key=lambda x: x["confidence"], reverse=True):
        toks = tokens(item["title"])
        hit = None
        for c in clusters:
            if jaccard(toks, c["tokens"]) >= 0.45:
                hit = c
                break
        if hit is None:
            clusters.append({"rep": item, "tokens": toks, "sources": {item["source"]}, "items": [item]})
        else:
            hit["sources"].add(item["source"])
            hit["items"].append(item)
    out = []
    for c in clusters:
        rep = dict(c["rep"])
        rep["sources"] = sorted(c["sources"])
        rep["multiSource"] = len(c["sources"]) >= 2
        if rep["multiSource"]:
            rep["confidence"] = round(min(0.95, rep["confidence"] + (0.1 if len(c["sources"]) == 2 else 0.15)), 2)
        out.append(rep)
    return out


def parse_8k_items(url: str) -> tuple[list[str], float]:
    """从 8-K 正文里提取 Item x.xx，并映射成方向分。"""
    try:
        req = urllib.request.Request(url, headers=SEC_UA)
        raw = urllib.request.urlopen(req, timeout=10).read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        text = html_lib.unescape(raw.decode("utf-8", "ignore"))
        items = sorted(set(re.findall(r"Item\s+(\d\.\d{2})", text, re.I)))
        score = sum(ITEM_IMPACT.get(i, 0.0) for i in items)
        return items, max(-3.0, min(3.0, score))
    except Exception:  # noqa: BLE001
        return [], 0.0


def fetch_sec(url: str) -> bytes:
    req = urllib.request.Request(url, headers=SEC_UA)
    raw = urllib.request.urlopen(req, timeout=12).read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw


def parse_exhibit(cik: str, acc: str) -> tuple[str, float]:
    """读 8-K 的 Exhibit 99.1 业绩新闻稿，判断超预期/下调指引等措辞。"""
    try:
        base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}"
        idx = json.loads(fetch_sec(base + "/index.json"))
        files = (idx.get("directory") or {}).get("item") or []
        cand = None
        for f in files:
            name = (f.get("name") or "").lower()
            typ = (f.get("type") or "").lower()
            if ("99" in name or "99" in typ) and name.endswith((".htm", ".html", ".txt")):
                cand = f.get("name")
                break
        if not cand:
            return "", 0.0
        raw = fetch_sec(f"{base}/{cand}")
        text = html_lib.unescape(re.sub(r"<[^>]+>", " ", raw.decode("utf-8", "ignore"))).lower()
        head = text[:8000]  # 只看标题/摘要段，避免财务附表里的"impairment"等误命中
        hits = [(label, weight) for phrase, label, weight in EARN_POS if phrase in head]
        hits += [(label, weight) for phrase, label, weight in EARN_NEG if phrase in head]
        if not hits:
            return "", 0.0
        label, weight = max(hits, key=lambda x: abs(x[1]))
        score = sum(w for _, w in hits)
        return label, max(-2.5, min(2.5, score))
    except Exception:  # noqa: BLE001
        return "", 0.0


def fetch_primary_filings() -> list[dict]:
    """拉取 SEC EDGAR 最近 14 天的 8-K/10-Q/10-K/6-K/20-F，作为最高等级的一手信源。"""
    out = []
    parsed_8k = 0
    for name, cik, _aliases in PRIMARY:
        try:
            req = urllib.request.Request(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=SEC_UA)
            raw = urllib.request.urlopen(req, timeout=15).read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            rec = json.loads(raw)["filings"]["recent"]
            for form, date, acc, doc, desc in zip(
                rec["form"], rec["filingDate"], rec["accessionNumber"],
                rec["primaryDocument"], rec["primaryDocDescription"]
            ):
                if form not in PRIMARY_FORMS:
                    continue
                age = (datetime.now(timezone.utc).date() - datetime.strptime(date, "%Y-%m-%d").date()).days
                if age > 14:
                    break
                url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
                       f"{acc.replace('-', '')}/{doc or (acc + '-index.htm')}")
                items: list[str] = []
                impact = 0.0
                signal = ""
                if form.startswith("8-K") and parsed_8k < 8:
                    items, impact = parse_8k_items(url)
                    if "2.02" in items:
                        signal, earn_impact = parse_exhibit(cik, acc)
                        impact = max(-3.0, min(3.0, impact + earn_impact))
                    parsed_8k += 1
                out.append({
                    "company": name, "form": form, "date": date, "url": url,
                    "title": (desc or form).strip() or form, "age": age,
                    "items": items,
                    "labels": [ITEM_LABEL.get(i, i) for i in items],
                    "signal": signal,
                    "impact": round(impact, 2),
                })
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] SEC {name}: {exc}", file=sys.stderr)
        time.sleep(0.15)
    out.sort(key=lambda x: (x["date"], x["company"]), reverse=True)
    return out[:12]


def main() -> int:
    now = datetime.now(timezone.utc)
    seen = set()
    raw_items = []
    deadline = time.time() + 100
    log("start")

    for source, url, tier in FEEDS:
        if time.time() > deadline:
            log("deadline reached, skip remaining feeds")
            break
        try:
            rows = parse_feed(fetch_bounded(url))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {source}: {exc}", file=sys.stderr)
            continue
        for row in rows:
            title = row["title"]
            if not title or row["time"] is None:
                continue
            age_h = (now - row["time"].astimezone(timezone.utc)).total_seconds() / 3600
            if age_h < -6 or age_h > 24 * 10:
                continue
            if relevance(title.lower()) < 2.5:
                continue
            key = hashlib.sha1(re.sub(r"\W+", "", title.lower()).encode()).hexdigest()[:16]
            if key in seen:
                continue
            seen.add(key)
            imp, tags = impact_of(title, row["desc"])
            recency = 1.0 if age_h <= 24 else 0.8 if age_h <= 72 else 0.55 if age_h <= 168 else 0.35
            impact = max(-6.0, min(6.0, imp * TIER_WEIGHT[tier] * recency))
            conf = confidence_of(title, row["desc"], tier)
            raw_items.append({
                "title": title,
                "source": source,
                "tier": tier,
                "url": row["link"],
                "time": row["time"].astimezone().strftime("%Y-%m-%d %H:%M"),
                "ageH": round(age_h, 1),
                "impact": round(impact, 2),
                "confidence": round(conf, 2),
                "tags": tags,
            })

    items = cluster_items(raw_items)
    primary = fetch_primary_filings()

    # 反向校验：新闻标题提到某公司，且该公司 7 天内有官方文件 → 可信度加分
    for it in items:
        title = it["title"].lower()
        for name, _cik, aliases in PRIMARY:
            if not any(a in title for a in aliases):
                continue
            if any(p["company"] == name and p["age"] <= 7 for p in primary):
                it["confidence"] = round(min(0.95, it["confidence"] + 0.08), 2)
                it["official"] = True
                if "官方" not in it["tags"]:
                    it["tags"].append("官方")

    for it in items:
        it["direction"] = "pos" if it["impact"] > 0.4 else "neg" if it["impact"] < -0.4 else "neu"
        if it["confidence"] >= 0.7:
            it["status"] = "high"
        elif it["confidence"] >= 0.55:
            it["status"] = "ok"
        else:
            it["status"] = "low"

    high = [x for x in items if x["confidence"] >= 0.55 and abs(x["impact"]) >= 0.4]
    low = [x for x in items if x not in high]
    high.sort(key=lambda x: abs(x["impact"]), reverse=True)
    low.sort(key=lambda x: abs(x["impact"]), reverse=True)

    # 官方文件里方向明确的条目也参与打分（多数 8-K 只有业绩/其他事项，方向为 0）
    official_items = []
    for p in primary:
        if abs(p.get("impact", 0)) >= 0.5:
            official_items.append({
                "title": f"{p['company']} {p['form']}",
                "source": "SEC EDGAR",
                "url": p["url"],
                "date": p["date"],
                "impact": p["impact"],
                "confidence": 0.95,
                "direction": "pos" if p["impact"] > 0 else "neg",
            })

    scored = high + official_items
    scored.sort(key=lambda x: abs(x["impact"]), reverse=True)
    total = sum(x["impact"] for x in scored[:8])
    score = round(50 + max(-30, min(30, total * 3.5)), 1)

    doc = {
        "updatedAt": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M"),
        "score": score,
        "stats": {
            "count": len(items),
            "high": len(high),
            "low": len(low),
            "pos": sum(1 for x in high if x["direction"] == "pos"),
            "neg": sum(1 for x in high if x["direction"] == "neg"),
            "sources": len({s for x in items for s in x["sources"]}),
            "official": len(primary),
            "officialImpact": len(official_items),
        },
        "items": [{k: v for k, v in x.items() if k not in ("tokens",)} for x in high[:20]],
        "pending": [{"title": x["title"], "source": x["source"], "url": x["url"],
                     "time": x["time"], "impact": x["impact"], "confidence": x["confidence"],
                     "tags": x["tags"]} for x in low[:10]],
        "primary": primary,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"overseas news: {len(items)} clustered, {len(high)} high-confidence, score {score}")
    log(f"done: {len(items)} clustered, {len(high)} high, score {score}")
    for x in high[:5]:
        print(f"  [{x['impact']:+.1f}|{x['confidence']:.2f}] {x['source']}: {x['title'][:80]}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR {exc!r}")
        raise
