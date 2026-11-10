/* 产业周期温度计 —— 读取 cycle/data.json，渲染评分、阶段、维度与资讯。 */
(function () {
  "use strict";

  const STAGES = [
    { n: 1, label: "导入", desc: "主题炒作期：只有故事和试点，没有利润。只研究，不重仓。" },
    { n: 2, label: "加速", desc: "渗透率快速提升，订单、收入、毛利率共振向上——最佳击球区。" },
    { n: 3, label: "泡沫", desc: "估值透支未来，人人扩产，卖方一致看多，边际买家消失。" },
    { n: 4, label: "杀估值", desc: "增速拐点出现，估值先杀、业绩还在增长；股价跌得比财报快。" },
    { n: 5, label: "杀业绩", desc: "资本开支下修、价格战，盈利开始负增长；估值反而“变贵”。" },
    { n: 6, label: "出清", desc: "二线退出、格局重塑，幸存者修复；历史高点多数难回。" },
  ];

  const DIMS = [
    { key: "growth", name: "景气", hint: "营收/净利同比、环比与增速二阶导" },
    { key: "quality", name: "盈利质量", hint: "毛利率及变化、净利率、经营现金流/净利润" },
    { key: "supply", name: "供给/运营", hint: "存货与应收周转天数变化、杠杆、毛利率趋势" },
    { key: "industry", name: "行业输入", hint: "capex 增速/趋势、产品价格、订单、产能（手工）" },
    { key: "valuation", name: "估值", hint: "PE/PB 五年分位、PEG" },
    { key: "crowd", name: "筹码", hint: "换手率、成交活跃度、距 2 年高点回撤" },
    { key: "news", name: "新闻叙事", hint: "国内资讯 60% + 海外影响因子 40%" },
  ];

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
      b.textContent = t.name;
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

    $("#theme-name").textContent = t.name;
    $("#score-num").textContent = fmt(b.total, 1);
    $("#score-num").style.color = color(b.total);
    drawRing(b.total);

    const pill = $("#stage-pill");
    pill.textContent = t.stage;
    pill.style.background = stageN === 2 ? "rgba(33,166,122,.16)" : stageN === 5 ? "rgba(76,141,255,.16)" : "rgba(245,165,36,.14)";
    pill.style.color = stageN === 2 ? "#3ecf9a" : stageN === 5 ? "#7aa7ff" : "#f5b942";

    const steps = $("#stage-track");
    steps.innerHTML = "";
    STAGES.forEach((s) => {
      const d = document.createElement("div");
      d.className = "stage-step" + (s.n < stageN ? " done" : s.n === stageN ? " active" : "");
      d.textContent = `${s.n} ${s.label}`;
      steps.appendChild(d);
    });

    const cur = STAGES.find((s) => s.n === stageN);
    const reason = (t.reasons || []).join("；");
    $("#stage-desc").innerHTML =
      `<b>${t.stage}</b>：${cur ? cur.desc : "指标处于中间地带。"}` +
      `<br>中位数：距 2 年高点 <b>${fmt(b.drawdown, 0)}%</b>，增速二阶导 <b>${fmt(b.accel, 0)}pct</b>，` +
      `PE 五年分位 <b>${fmt(medianStock(t, "pePct"), 0)}%</b>，行业输入 <b>${b.industry == null ? "未填" : fmt(b.industry, 0)}</b>。` +
      (reason ? `<br><span style="color:#8b98a9">触发：${reason}</span>` : "");

    const grid = $("#dims");
    grid.innerHTML = "";
    DIMS.forEach((d) => {
      const v = b[d.key];
      const box = document.createElement("div");
      box.className = "dim";
      box.innerHTML =
        `<div class="row1"><span>${d.name}</span><b>${v == null ? "未填" : fmt(v, 0)}</b></div>` +
        `<div class="bar"><i style="width:${v == null ? 2 : Math.max(2, Math.min(100, v))}%;background:${color(v)}"></i></div>` +
        `<div class="hint">${d.hint}</div>`;
      grid.appendChild(box);
    });

    renderTable(t);
    renderNews(t);
    fillInputs(t);

    $("#news-stat").textContent =
      `近 30 条资讯：正面词 ${t.newsStats.pos} / 负面词 ${t.newsStats.neg}，热度评分 ${fmt(t.newsStats.score, 0)}`;
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
          <td>${s.pe > 0 ? fmt(s.pe, 1) : "亏损"}</td>
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
    if (!(t.news || []).length) box.innerHTML = '<div style="color:#5b6779;padding:8px">暂无资讯</div>';
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

    status.textContent = "评分中…（约 30–60 秒）";
    $("#save-inputs").disabled = true;
    try {
      const res = await fetch("../api/cycle?inputs=" + encodeURIComponent(JSON.stringify(all)), { cache: "no-store" });
      const r = await res.json().catch(() => ({ ok: false, message: "静态托管模式：无法重新评分，请本地运行 scripts/cycle_score.py" }));
      if (!r.ok) throw new Error(r.message || "评分失败");
      status.textContent = `已重新评分（${(r.ms / 1000).toFixed(0)}s）`;
      await load(false);
    } catch (e) {
      status.textContent = "保存失败：" + e.message;
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
    conf.title = "可信度：来源层级 + 传闻措辞 + 官方措辞 + 多源交叉";

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
      `${o.stats.count} 条聚类 · 高置信 ${o.stats.high} · 待核实 ${o.stats.low}` +
      ` · 利多 ${o.stats.pos} / 利空 ${o.stats.neg} · ${o.stats.sources} 个来源` +
      ` · 官方文件 ${o.stats.official || 0} · 更新 ${o.updatedAt}`;

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
      tag.textContent = "官方";
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
      $("#updated").textContent = `数据更新：${state.data.updatedAt} · 财务口径 2026 三季报 · 行情截至最近收盘`;
      renderTabs();
      renderTheme();
      renderOverseas();
    } catch (e) {
      $("#stage-desc").textContent = "数据加载失败：" + e.message + "（先运行 scripts/cycle_score.py）";
    }
  }

  $("#refresh").onclick = () => load(true);

  load(false);
})();
