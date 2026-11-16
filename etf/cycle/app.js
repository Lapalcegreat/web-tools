/* 产业周期温度计 —— 读取 cycle/data.json，渲染评分、阶段、维度与资讯。 */
(function () {
  "use strict";

  const STAGES = [
    { n: 1, label: "导入", labelEn: "Intro", desc: "主题炒作期：只有故事和试点，没有利润。只研究，不重仓。", descEn: "Narrative phase: stories and pilots, no profits. Research only, no heavy positions." },
    { n: 2, label: "加速", labelEn: "Accelerate", desc: "渗透率快速提升，订单、收入、毛利率共振向上——最佳击球区。", descEn: "Adoption rising fast; orders, revenue and margins improve together — the sweet spot." },
    { n: 3, label: "泡沫", labelEn: "Bubble", desc: "估值透支未来，人人扩产，卖方一致看多，边际买家消失。", descEn: "Valuation prices in the future; everyone expands; consensus is bullish; marginal buyers vanish." },
    { n: 4, label: "杀估值", labelEn: "De-rating", desc: "增速拐点出现，估值先杀、业绩还在增长；股价跌得比财报快。", descEn: "Growth inflection appears; valuation de-rates while earnings still grow; price falls faster than fundamentals." },
    { n: 5, label: "杀业绩", labelEn: "Earnings", desc: "资本开支下修、价格战，盈利开始负增长；估值反而“变贵”。", descEn: "Capex cuts and price wars; earnings turn negative; valuation looks expensive again." },
    { n: 6, label: "出清", labelEn: "Clearing", desc: "二线退出、格局重塑，幸存者修复；历史高点多数难回。", descEn: "Tier-2 players exit, the landscape resets, survivors recover; old highs are rarely reclaimed." },
  ];

  const DIMS = [
    { key: "growth", name: "景气", nameEn: "Growth", hint: "营收/净利同比、环比与增速二阶导", hintEn: "Revenue/profit YoY, QoQ and acceleration" },
    { key: "quality", name: "盈利质量", nameEn: "Quality", hint: "毛利率及变化、净利率、经营现金流/净利润", hintEn: "Gross margin and change, net margin, OCF/net profit" },
    { key: "supply", name: "供给/运营", nameEn: "Supply", hint: "存货与应收周转天数变化、杠杆、毛利率趋势", hintEn: "Inventory/receivable days, leverage, margin trend" },
    { key: "industry", name: "行业输入", nameEn: "Industry", hint: "capex 增速/趋势、产品价格、订单、产能（手工）", hintEn: "Capex growth/trend, pricing, orders, utilization (manual)" },
    { key: "valuation", name: "估值", nameEn: "Valuation", hint: "PE/PB 五年分位、PEG", hintEn: "PE/PB 5-year percentile, PEG" },
    { key: "crowd", name: "筹码", nameEn: "Crowding", hint: "换手率、成交活跃度、距 2 年高点回撤", hintEn: "Turnover, amount activity, drawdown from 2-year high" },
    { key: "news", name: "新闻叙事", nameEn: "News", hint: "国内资讯 60% + 海外影响因子 40%", hintEn: "Domestic news 60% + overseas factor 40%" },
  ];

  const SHORT_EN = {
    ai: "AI Hardware", newenergy: "New Energy", humanoid: "Robotics",
    aiglasses: "AI Glasses", space: "Space", hbm: "NVHBM",
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? "--" : Number(v).toFixed(d));
  const cls = (v) => (v == null ? "s-low" : v >= 70 ? "s-hi" : v >= 50 ? "s-mid" : "s-low");
  const color = (v) => (v == null ? "#2c3a4d" : v >= 70 ? "#21a67a" : v >= 50 ? "#f5a524" : "#f05252");

  const state = { data: null, themeId: null, overseas: null };

  function stageIndex(stage) {
    const m = /阶段(\d)/.exec(stage || "");
    return m ? Number(m[1]) : 0;
  }

  function renderTabs() {
    const box = $("#tabs");
    box.innerHTML = "";
    state.data.themes.forEach((t) => {
      const b = document.createElement("button");
      b.innerHTML = `${t.name}<span class="tab-en">${SHORT_EN[t.id] || t.nameEn || ""}</span>`;
      b.title = `${t.name} / ${t.nameEn || ""}`;
      b.className = t.id === state.themeId ? "active" : "";
      b.onclick = () => { state.themeId = t.id; renderTabs(); renderTheme(); };
      box.appendChild(b);
    });
  }

  function drawRing(score) {
    const canvas = $("#ring");
    const dpr = window.devicePixelRatio || 1;
    const size = 168;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, r = 68;
    g.lineWidth = 11;
    g.lineCap = "round";
    g.strokeStyle = "#1d2836";
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    const pct = Math.max(0, Math.min(100, score || 0)) / 100;
    g.strokeStyle = color(score);
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
    g.stroke();
  }

  function renderTheme() {
    const t = state.data.themes.find((x) => x.id === state.themeId) || state.data.themes[0];
    const b = t.basket || {};
    const stageN = stageIndex(t.stage);

    $("#theme-name").innerHTML = `${t.name}<span class="theme-en">${t.nameEn || ""}</span>`;
    $("#score-num").textContent = fmt(b.total, 1);
    $("#score-num").style.color = color(b.total);
    drawRing(b.total);

    const pill = $("#stage-pill");
    pill.textContent = `${t.stage} / ${(t.stageEn || "").split(" ").slice(0, 2).join(" ")}`;
    pill.style.background = stageN === 2 ? "rgba(33,166,122,.16)" : stageN === 5 ? "rgba(76,141,255,.16)" : "rgba(245,165,36,.14)";
    pill.style.color = stageN === 2 ? "#3ecf9a" : stageN === 5 ? "#7aa7ff" : "#f5b942";

    const steps = $("#stage-track");
    steps.innerHTML = "";
    STAGES.forEach((s) => {
      const d = document.createElement("div");
      d.className = "stage-step" + (s.n < stageN ? " done" : s.n === stageN ? " active" : "");
      d.textContent = `${s.n} ${s.label} / ${s.labelEn}`;
      steps.appendChild(d);
    });

    const cur = STAGES.find((s) => s.n === stageN);
    const reason = (t.reasons || []).join("；");
    const reasonEn = (t.reasonsEn || []).join("; ");
    $("#stage-desc").innerHTML =
      `<b>${t.stage} / ${t.stageEn || ""}</b>：${cur ? cur.desc : "指标处于中间地带。"}` +
      (cur ? `<br><span class="en">${cur.descEn}</span>` : "") +
      `<br>中位数 / Median：距 2 年高点 / from 2y high <b>${fmt(b.drawdown, 0)}%</b>，增速二阶导 / acceleration <b>${fmt(b.accel, 0)}pct</b>，` +
      `PE 五年分位 / PE 5y pct <b>${fmt(medianStock(t, "pePct"), 0)}%</b>，行业输入 / industry <b>${b.industry == null ? "未填 / n/a" : fmt(b.industry, 0)}</b>。` +
      (reason ? `<br><span class="reason">触发 / Triggers：${reason}${reasonEn ? `<br><span class="en">${reasonEn}</span>` : ""}</span>` : "");

    const grid = $("#dims");
    grid.innerHTML = "";
    DIMS.forEach((d) => {
      const v = b[d.key];
      const box = document.createElement("div");
      box.className = "dim";
      box.innerHTML =
        `<div class="row1"><span>${d.name} <em>${d.nameEn}</em></span><b>${v == null ? "未填 / n/a" : fmt(v, 0)}</b></div>` +
        `<div class="bar"><i style="width:${v == null ? 2 : Math.max(2, Math.min(100, v))}%;background:${color(v)}"></i></div>` +
        `<div class="hint">${d.hint}<br><span class="en">${d.hintEn}</span></div>`;
      grid.appendChild(box);
    });

    renderTable(t);
    renderNews(t);
    fillInputs(t);

    $("#news-stat").textContent =
      `近 30 条资讯 / last 30 items：正面词 / positive ${t.newsStats.pos} · 负面词 / negative ${t.newsStats.neg} · 热度评分 / heat ${fmt(t.newsStats.score, 0)}`;
  }

  function medianStock(t, key) {
    const vals = t.stocks.map((s) => s[key]).filter((v) => v != null).sort((a, b) => a - b);
    if (!vals.length) return null;
    return vals[Math.floor(vals.length / 2)];
  }

  function renderTable(t) {
    const rows = t.stocks
      .slice()
      .sort((a, b) => (b.scores.total || 0) - (a.scores.total || 0))
      .map((s) => {
        const chgCls = s.chg > 0 ? "up" : s.chg < 0 ? "down" : "";
        return `<tr>
          <td>${s.name}<span class="code">${s.code}</span></td>
          <td>${fmt(s.price, 2)}</td>
          <td class="${chgCls}">${s.chg > 0 ? "+" : ""}${fmt(s.chg, 1)}%</td>
          <td>${fmt(s.drawdown, 0)}%</td>
          <td>${s.pe > 0 ? fmt(s.pe, 1) : "亏损 / Loss"}</td>
          <td><span class="chip ${cls(s.scores.growth)}">${fmt(s.scores.growth, 0)}</span></td>
          <td><span class="chip ${cls(s.scores.quality)}">${fmt(s.scores.quality, 0)}</span></td>
          <td><span class="chip ${cls(s.scores.supply)}">${fmt(s.scores.supply, 0)}</span></td>
          <td><span class="chip ${cls(s.scores.valuation)}">${fmt(s.scores.valuation, 0)}</span></td>
          <td><span class="chip ${cls(s.scores.crowd)}">${fmt(s.scores.crowd, 0)}</span></td>
          <td><span class="chip ${cls(s.scores.total)}">${fmt(s.scores.total, 0)}</span></td>
        </tr>`;
      })
      .join("");
    $("#stock-rows").innerHTML = rows;
  }

  function renderNews(t) {    const box = $("#news");
    box.innerHTML = "";
    (t.news || []).slice(0, 10).forEach((n) => {
      const row = document.createElement("div");
      row.className = "news-item";
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = (n.date || "").slice(5, 16);
      const a = document.createElement("a");
      a.href = n.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = n.title;
      a.title = n.title;
      const m = document.createElement("span");
      m.className = "m";
      m.textContent = n.media || "";
      row.append(d, a, m);
      box.appendChild(row);
    });
    if (!(t.news || []).length) box.innerHTML = '<div style="color:#5b6779;padding:8px">暂无资讯 / No news</div>';
  }

  function fillInputs(t) {
    const i = t.inputs || {};
    $("#in-capex").value = i.capexGrowth ?? "";
    $("#in-trend").value = i.capexTrend || "";
    $("#in-price").value = i.priceChange ?? "";
    $("#in-order").value = i.orderCoverage ?? "";
    $("#in-util").value = i.capacityUtil ?? "";
  }

  $("#save-inputs").onclick = async () => {
    const status = $("#input-status");
    const t = state.data.themes.find((x) => x.id === state.themeId);
    if (!t) return;
    const num = (id) => {
      const v = $(id).value.trim();
      return v === "" ? null : Number(v);
    };
    const payload = {};
    const capex = num("#in-capex");
    if (capex !== null && isFinite(capex)) payload.capexGrowth = capex;
    const trend = $("#in-trend").value;
    if (trend) payload.capexTrend = trend;
    const price = num("#in-price");
    if (price !== null && isFinite(price)) payload.priceChange = price;
    const order = num("#in-order");
    if (order !== null && isFinite(order)) payload.orderCoverage = order;
    const util = num("#in-util");
    if (util !== null && isFinite(util)) payload.capacityUtil = util;

    const all = {};
    state.data.themes.forEach((x) => {
      if (x.id === t.id) return;
      if (x.inputs && Object.keys(x.inputs).length) all[x.id] = x.inputs;
    });
    if (Object.keys(payload).length) all[t.id] = payload;

    status.textContent = "评分中… / Scoring…（约 30–60 秒 / sec）";
    $("#save-inputs").disabled = true;
    try {
      const res = await fetch("../api/cycle?inputs=" + encodeURIComponent(JSON.stringify(all)), { cache: "no-store" });
      const r = await res.json().catch(() => ({ ok: false, message: "静态托管模式：无法重新评分，请本地运行 scripts/cycle_score.py / Static hosting: run scripts/cycle_score.py locally" }));
      if (!r.ok) throw new Error(r.message || "评分失败 / Scoring failed");
      status.textContent = `已重新评分 / Rescored（${(r.ms / 1000).toFixed(0)}s）`;
      await load(false);
    } catch (e) {
      status.textContent = "保存失败 / Failed：" + e.message;
    } finally {
      $("#save-inputs").disabled = false;
    }
  };

  function overseasRow(it) {
    const row = document.createElement("div");
    row.className = "overseas-row";

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = (it.time || "").slice(5);

    const src = document.createElement("span");
    src.className = "src";
    src.textContent = it.source;

    const mid = document.createElement("div");
    mid.style.minWidth = "0";
    mid.style.overflow = "hidden";
    mid.style.whiteSpace = "nowrap";
    const a = document.createElement("a");
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = it.title;
    a.title = it.title;
    mid.appendChild(a);
    (it.tags || []).forEach((tg) => {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = tg;
      mid.appendChild(tag);
    });

    const imp = document.createElement("span");
    imp.className = "imp " + (it.direction || "neu");
    imp.textContent = (it.impact > 0 ? "+" : "") + Number(it.impact).toFixed(1);

    const conf = document.createElement("span");
    conf.className = "conf " + ((it.confidence || 0) >= 0.7 ? "high" : "low");
    conf.textContent = Math.round((it.confidence || 0) * 100) + "%";
    conf.title = "可信度 / Confidence：来源层级 + 传闻措辞 + 官方措辞 + 多源交叉 / source tier + rumor wording + official wording + cross-source";

    row.append(time, src, mid, imp, conf);
    return row;
  }

  function renderOverseas() {
    const card = $("#overseas-card");
    const o = state.overseas;
    if (!o || !Array.isArray(o.items) || !o.items.length) {
      card.style.display = "none";
      return;
    }
    card.style.display = "";
    const s = o.score;
    const badge = $("#overseas-score");
    badge.textContent = fmt(s, 0);
    badge.style.background = color(s) + "22";
    badge.style.color = color(s);
    const bar = $("#overseas-bar");
    bar.style.width = Math.max(2, Math.min(100, s)) + "%";
    bar.style.background = color(s);
    $("#overseas-stat").textContent =
      `${o.stats.count} 条聚类 / clustered · 高置信 / high ${o.stats.high} · 待核实 / low ${o.stats.low}` +
      ` · 利多 / pos ${o.stats.pos} · 利空 / neg ${o.stats.neg} · ${o.stats.sources} 个来源 / sources` +
      ` · 官方文件 / filings ${o.stats.official || 0} · 更新 / updated ${o.updatedAt}`;

    const box = $("#overseas-news");
    box.innerHTML = "";
    o.items.slice(0, 10).forEach((it) => box.appendChild(overseasRow(it)));

    const pend = $("#overseas-pending");
    const plabel = $("#overseas-pending-label");
    pend.innerHTML = "";
    const list = o.pending || [];
    plabel.style.display = list.length ? "" : "none";
    list.slice(0, 6).forEach((it) => pend.appendChild(overseasRow(it)));

    const pbox = $("#overseas-primary");
    const plabel2 = $("#overseas-primary-label");
    pbox.innerHTML = "";
    const primary = o.primary || [];
    plabel2.style.display = primary.length ? "" : "none";
    primary.slice(0, 6).forEach((p) => {
      const row = document.createElement("div");
      row.className = "overseas-row";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = (p.date || "").slice(5);
      const src = document.createElement("span");
      src.className = "src";
      src.textContent = p.company;
      const mid = document.createElement("div");
      mid.style.minWidth = "0";
      mid.style.overflow = "hidden";
      mid.style.whiteSpace = "nowrap";
      const a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      const label = [
        (p.labels && p.labels.length) ? p.labels.join(" / ") : "",
        p.signal || "",
      ].filter(Boolean).join(" · ");
      a.textContent = p.form + (label ? " · " + label : "");
      a.title = `${p.company} ${p.form} ${p.date}${label ? " " + label : ""}`;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "官方 / Official";
      mid.append(a, tag);
      const imp = document.createElement("span");
      imp.className = "imp " + (p.impact > 0 ? "pos" : p.impact < 0 ? "neg" : "neu");
      imp.textContent = p.impact ? (p.impact > 0 ? "+" : "") + Number(p.impact).toFixed(1) : "";
      const conf = document.createElement("span");
      conf.className = "conf high";
      conf.textContent = "95%";
      row.append(time, src, mid, imp, conf);
      pbox.appendChild(row);
    });
  }

  async function load(manual) {
    try {
      const [res, ovRes] = await Promise.all([
        fetch("data.json?t=" + Date.now(), { cache: "no-store" }),
        fetch("overseas.json?t=" + Date.now(), { cache: "no-store" }).catch(() => null),
      ]);
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
      state.overseas = ovRes && ovRes.ok ? await ovRes.json() : null;
      const wanted = new URLSearchParams(location.search).get("theme");
      if (wanted && state.data.themes.some((t) => t.id === wanted)) state.themeId = wanted;
      if (!state.themeId) state.themeId = state.data.themes[0].id;
      $("#updated").textContent = `数据更新 / Updated：${state.data.updatedAt} · 财务口径 / financials 2026 三季报 Q3 · 行情截至最近收盘 / latest close`;
      renderTabs();
      renderTheme();
      renderOverseas();
    } catch (e) {
      $("#stage-desc").textContent = "数据加载失败 / Load failed：" + e.message + "（先运行 / run scripts/cycle_score.py）";
    }
  }

  $("#refresh").onclick = () => load(true);

  load(false);
})();
