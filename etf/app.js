/* A股宽基ETF K线仪表盘 —— 无依赖，Canvas 绘制。
 * 数据格式：window.ETF_DATA 或 data/etf-daily.json
 * bars: [date, open, close, high, low, volume(手), amount(元), amplitude]
 */
(function (global) {
  "use strict";

  const WEEK_VIEW_MIN_BARS = 150;
  // 爆量判定：成交量 ≥ 前 N 根均量 × 系数（日线 20 日均量 2 倍，周线 12 周均量 1.8 倍）
  const SPIKE = {
    day: { window: 20, factor: 2.0 },
    week: { window: 12, factor: 1.8 },
  };

  const fmt = (v, d) => (v == null || !isFinite(v) ? "--" : v.toFixed(d));
  const pct = (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "%";

  function volumeText(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
    if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
    return Math.round(v) + "手";
  }
  function amountText(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
    if (v >= 1e4) return (v / 1e4).toFixed(1) + "万";
    return Math.round(v) + "";
  }

  /* 自然周聚合：周一到周五为一根，b[0] 为当周首个交易日，b[8] 为当周最后一个交易日 */
  function mondayOf(date) {
    const d = new Date(date + "T00:00:00Z");
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }

  function aggregateWeekly(bars) {
    const out = [];
    let cur = null;
    for (const b of bars) {
      const key = mondayOf(b[0]);
      if (!cur || cur.key !== key) {
        if (cur) out.push(cur.bar);
        cur = { key, bar: [b[0], b[1], b[2], b[3], b[4], b[5], b[6], 0, b[0]] };
      } else {
        cur.bar[2] = b[2];                                   // close
        cur.bar[3] = Math.max(cur.bar[3], b[3]);             // high
        cur.bar[4] = Math.min(cur.bar[4], b[4]);             // low
        cur.bar[5] += b[5];                                  // volume
        cur.bar[6] += b[6];                                  // amount
        cur.bar[8] = b[0];                                   // 周末日期
      }
    }
    if (cur) out.push(cur.bar);
    for (let i = 0; i < out.length; i++) {
      const prev = i > 0 ? out[i - 1][2] : out[i][1];
      out[i][7] = prev ? ((out[i][2] - prev) / prev) * 100 : 0;
    }
    return out;
  }

  /* 爆量：相对前 N 根均量的倍数；null 表示普通量 */
  function volumeSpikes(bars, mode) {
    const { window: win, factor } = SPIKE[mode];
    const out = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      const from = Math.max(0, i - win);
      if (i - from < 5) continue;
      let sum = 0;
      for (let j = from; j < i; j++) sum += bars[j][5];
      const avg = sum / (i - from);
      if (avg > 0 && bars[i][5] >= avg * factor) out[i] = bars[i][5] / avg;
    }
    return out;
  }

  function movingAverage(bars, n) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i][2];
      if (i >= n) sum -= bars[i - n][2];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mount(rootSel) {
    const root = typeof rootSel === "string" ? document.querySelector(rootSel) : rootSel;
    if (!root) throw new Error("mount: 找不到容器");

    const state = {
      data: null,
      code: null,
      view: "auto",
      range: "all",
      hover: -1,
      mode: "day",
      bars: [],
      ma5: [], ma10: [], ma20: [],
      spikes: [],
      flows: null,
      price: { min: 0, max: 1 },
      status: "loading",
    };

    /* ---------------- DOM ---------------- */
    root.innerHTML = "";
    const top = el("div", "topbar");
    const brand = el("div", "brand");
    const dot = el("span", "dot");
    const h1 = el("h1", null, "A股宽基ETF");
    const sub = el("span", "sub", "加载中…");
    brand.append(dot, h1, sub);
    top.appendChild(brand);

    const mstat = el("div", "market-stat");
    top.appendChild(mstat);
    top.appendChild(el("div", "spacer"));

    const ctr = el("div", "controls");
    const viewSeg = el("div", "seg");
    [["auto", "自动"], ["day", "日K"], ["week", "周K"]].forEach(([k, label]) => {
      const b = el("button", null, label);
      b.dataset.view = k;
      b.onclick = () => { state.view = k; syncSeg(); render(); };
      viewSeg.appendChild(b);
    });
    const rangeSeg = el("div", "seg");
    [["1m", "近1月"], ["3m", "近3月"], ["6m", "近6月"], ["all", "全部"]].forEach(([k, label]) => {
      const b = el("button", null, label);
      b.dataset.range = k;
      b.onclick = () => { state.range = k; syncSeg(); render(); };
      rangeSeg.appendChild(b);
    });
    const refreshBtn = el("button", "icon-btn", "刷新");
    refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg><span>刷新</span>';
    refreshBtn.onclick = () => refreshNow();
    const cycleLink = el("a", "icon-btn", "产业温度计");
    cycleLink.href = "cycle/";
    cycleLink.style.textDecoration = "none";
    ctr.append(viewSeg, rangeSeg, cycleLink, refreshBtn);
    top.appendChild(ctr);

    const main = el("div", "main");
    const side = el("div", "side");
    const sideHead = el("div", "side-head");
    sideHead.innerHTML = "<span>宽基 ETF · 12</span><span>涨跌</span>";
    const list = el("div", "list");
    side.append(sideHead, list);

    const cwrap = el("div", "chart-wrap");
    const chead = el("div", "chart-head");
    const ctitle = el("div", "chart-title");
    const h2 = el("h2", null, "--");
    const codeEl = el("span", "code");
    const sectorEl = el("span", "sector");
    ctitle.append(h2, codeEl, sectorEl);
    const ohlc = el("div", "ohlc");
    chead.append(ctitle, ohlc);
    const host = el("div", "canvas-host");
    const canvas = el("canvas");
    canvas.id = "chart";
    const legend = el("div", "legend");
    const tooltip = el("div", "tooltip");
    host.append(canvas, legend, tooltip);
    const foot = el("div", "chart-foot");
    const flowPanel = el("div", "flow-panel");
    flowPanel.style.display = "none";
    flowPanel.innerHTML =
      '<div class="flow-head"><b>国家队足迹</b>' +
      '<div class="flow-stat"><b id="flow-net">--</b><span>今日净申购</span></div>' +
      '<div class="flow-stat"><b id="flow-cum">--</b><span>5日累计</span></div>' +
      '<div class="flow-stat score"><b id="flow-score">--</b><span>足迹分</span></div>' +
      '<span class="flow-note">份额 T+1 · 净申购 = 份额变化 × 收盘价 · 足迹分 ≥65 偏多 / &lt;45 偏空</span></div>' +
      '<div class="flow-body"><canvas id="flow-canvas"></canvas><div class="flow-table" id="flow-table"></div></div>';
    const flowNet = flowPanel.querySelector("#flow-net");
    const flowCum = flowPanel.querySelector("#flow-cum");
    const flowScore = flowPanel.querySelector("#flow-score");
    const flowCanvas = flowPanel.querySelector("#flow-canvas");
    const flowTable = flowPanel.querySelector("#flow-table");
    cwrap.append(chead, host, foot, flowPanel);
    main.append(side, cwrap);
    root.append(top, main);

    /* ---------------- 数据 ---------------- */
    const q = new URLSearchParams(location.search);
    if (q.get("view") === "month") state.view = "week"; // 兼容旧链接
    if (["auto", "day", "week"].includes(q.get("view"))) state.view = q.get("view");
    if (["1m", "3m", "6m", "all"].includes(q.get("range"))) state.range = q.get("range");
    if (q.get("code")) state.code = q.get("code");

    function localData() {
      const d = global.ETF_DATA;
      return d && Array.isArray(d.etfs) && d.etfs.length ? d : null;
    }

    async function fetchData() {
      const url = "data/etf-daily.json?t=" + Date.now();
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }

    function loadLocalScript() {
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "data/etf-data.js?t=" + Date.now();
        s.onload = () => { s.remove(); resolve(global.ETF_DATA || null); };
        s.onerror = () => { s.remove(); reject(new Error("data/etf-data.js 加载失败")); };
        document.head.appendChild(s);
      });
    }

    async function load(manual) {
      const btn = refreshBtn;
      btn.classList.add("spin");
      state.status = "loading";
      try {
        let doc = null;
        if (location.protocol === "file:") {
          try { doc = await loadLocalScript(); } catch (e) { /* 用已内嵌的数据 */ }
        } else {
          try { doc = await fetchData(); } catch (e) { /* 退回到内嵌数据 */ }
        }
        if (!doc) doc = localData();
        if (!doc) throw new Error("没有可用的数据文件");
        state.data = doc;
        if (!state.code || !doc.etfs.some((e) => e.code === state.code)) {
          state.code = doc.etfs[0].code;
        }
        state.status = "ok";
        priceCache.clear();
        try {
          const fr = await fetch("data/etf-flows.json?t=" + Date.now(), { cache: "no-store" });
          state.flows = fr.ok ? await fr.json() : null;
        } catch (e) {
          state.flows = null;
        }
        renderAll();
        renderFlows();
      } catch (err) {
        state.status = "error";
        sub.textContent = "数据加载失败：" + err.message;
        dot.className = "dot closed";
        if (!state.data) {
          root.querySelector(".main").innerHTML = '<div class="empty">暂时没有数据</div>';
        }
        if (manual) console.error(err);
      } finally {
        btn.classList.remove("spin");
      }
    }

    /* 手动刷新：先让宿主补抓一次当日数据，再重新读文件 */
    let busy = false;
    async function refreshNow() {
      if (busy) return;
      busy = true;
      const label = refreshBtn.querySelector("span");
      label.textContent = "更新中…";
      try {
        if (location.protocol !== "file:") {
          try {
            const res = await fetch("api/update", { cache: "no-store" });
            if (res.ok) {
              const r = await res.json();
              if (r && r.ok === false) console.warn("增量更新失败：", r);
            }
          } catch (e) { /* 独立打开时没有该接口 */ }
        }
        await load(true);
      } finally {
        label.textContent = "刷新";
        busy = false;
      }
    }

    /* ---------------- 左列表 ---------------- */
    const priceCache = new Map();

    function lastPct(etf) {
      const b = etf.bars;
      if (!b.length) return { price: 0, chg: 0 };
      const last = b[b.length - 1];
      const prev = b.length > 1 ? b[b.length - 2][2] : last[1];
      return { price: last[2], chg: prev ? ((last[2] - prev) / prev) * 100 : 0 };
    }

    function sparkline(etf) {
      const c = document.createElement("canvas");
      c.className = "spark";
      const dpr = window.devicePixelRatio || 1;
      const w = 64, h = 26;
      c.width = w * dpr; c.height = h * dpr;
      c.style.width = w + "px"; c.style.height = h + "px";
      const g = c.getContext("2d");
      g.scale(dpr, dpr);
      const bars = etf.bars.slice(-30);
      if (bars.length < 2) return c;
      let min = Infinity, max = -Infinity;
      for (const b of bars) { min = Math.min(min, b[4]); max = Math.max(max, b[3]); }
      if (max === min) { max += 0.001; min -= 0.001; }
      const x = (i) => 1 + (i / (bars.length - 1)) * (w - 2);
      const y = (v) => h - 2 - ((v - min) / (max - min)) * (h - 4);
      const rising = bars[bars.length - 1][2] >= bars[0][1];
      g.beginPath();
      bars.forEach((b, i) => { i ? g.lineTo(x(i), y(b[2])) : g.moveTo(x(i), y(b[2])); });
      g.strokeStyle = rising ? "#f05252" : "#21a67a";
      g.lineWidth = 1.2;
      g.stroke();
      g.lineTo(x(bars.length - 1), h); g.lineTo(x(0), h); g.closePath();
      const grad = g.createLinearGradient(0, 2, 0, h);
      grad.addColorStop(0, rising ? "rgba(240,82,82,.30)" : "rgba(33,166,122,.30)");
      grad.addColorStop(1, "rgba(13,17,23,0)");
      g.fillStyle = grad;
      g.fill();
      return c;
    }

    function renderList() {
      list.innerHTML = "";
      const doc = state.data;
      let ups = 0, downs = 0;
      doc.etfs.forEach((etf) => {
        const { price, chg } = lastPct(etf);
        if (chg > 0) ups++; else if (chg < 0) downs++;
        const row = el("div", "row" + (etf.code === state.code ? " active" : ""));
        const n = el("div", "n");
        const name = el("div", "name", etf.name);
        const meta = el("div", "meta");
        meta.append(el("span", "tag", etf.sector), el("span", null, etf.code));
        n.append(name, meta);
        const sp = el("div", "spark-wrap");
        sp.appendChild(sparkline(etf));
        const px = el("div", "px");
        const cls = chg > 0 ? "up" : chg < 0 ? "down" : "flat";
        px.append(el("div", "p " + cls, fmt(price, 3)), el("div", "c " + cls, pct(chg)));
        row.append(n, sp, px);
        row.onclick = () => { state.code = etf.code; state.hover = -1; renderAll(); };
        list.appendChild(row);
      });
      mstat.innerHTML = `<span>上涨 <b class="up">${ups}</b></span><span>下跌 <b class="down">${downs}</b></span><span>平盘 <b>${doc.etfs.length - ups - downs}</b></span>`;
    }

    /* ---------------- 图表 ---------------- */
    function currentEtf() {
      return state.data.etfs.find((e) => e.code === state.code) || state.data.etfs[0];
    }

    function cutoffISO(lastDate, months) {
      if (!months) return null;
      const d = new Date(lastDate + "T00:00:00Z");
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - months);
      d.setUTCDate(Math.min(day, 28));
      return d.toISOString().slice(0, 10);
    }

    function buildSeries() {
      const etf = currentEtf();
      const all = etf.bars;
      const weekly = state.view === "auto" ? all.length > WEEK_VIEW_MIN_BARS : state.view === "week";
      state.mode = weekly ? "week" : "day";
      const base = weekly ? aggregateWeekly(all) : all.slice();

      const ma5all = movingAverage(base, 5);
      const ma10all = movingAverage(base, 10);
      const ma20all = movingAverage(base, 20);

      let from = 0;
      const months = state.range === "1m" ? 1 : state.range === "3m" ? 3 : state.range === "6m" ? 6 : 0;
      const cut = cutoffISO(base[base.length - 1][0], months);
      if (cut) {
        while (from < base.length - 1 && base[from][0] < cut) from++;
      }
      state.bars = base.slice(from);
      state.ma5 = ma5all.slice(from);
      state.ma10 = ma10all.slice(from);
      state.ma20 = ma20all.slice(from);
      state.etf = etf;
      state.aggregated = weekly;
      state.spikes = volumeSpikes(state.bars, state.mode);
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const W = Math.max(320, Math.floor(rect.width));
      const H = Math.max(240, Math.floor(rect.height));
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);

      const bars = state.bars;
      if (!bars.length) return;

      const padR = 64, padL = 10, padT = 16, padB = 22;
      const plotW = W - padL - padR;
      const priceH = Math.floor((H - padT - padB) * 0.72);
      const volTop = padT + priceH + 20;
      const volH = H - padB - volTop;
      const step = plotW / bars.length;
      const x = (i) => padL + step * (i + 0.5);

      let min = Infinity, max = -Infinity;
      for (let i = 0; i < bars.length; i++) {
        min = Math.min(min, bars[i][4]);
        max = Math.max(max, bars[i][3]);
        for (const ma of [state.ma5, state.ma10, state.ma20]) {
          if (ma[i] != null) { min = Math.min(min, ma[i]); max = Math.max(max, ma[i]); }
        }
      }
      const span = max - min || max * 0.02 || 1;
      min -= span * 0.06; max += span * 0.06;
      state.price = { min, max };
      const y = (v) => padT + (1 - (v - min) / (max - min)) * priceH;

      let vmax = 0;
      for (const b of bars) vmax = Math.max(vmax, b[5]);
      const vy = (v) => volTop + volH - (vmax ? (v / vmax) * (volH - 4) : 0);

      /* 网格与坐标 */
      g.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      g.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const py = padT + (priceH / 4) * i;
        g.strokeStyle = "#1b2532"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(padL, py + 0.5); g.lineTo(padL + plotW, py + 0.5); g.stroke();
        const val = max - ((max - min) / 4) * i;
        g.fillStyle = "#6b7789"; g.textAlign = "left";
        g.fillText(val.toFixed(val < 10 ? 3 : 2), padL + plotW + 8, py);
      }
      g.strokeStyle = "#1b2532";
      g.beginPath(); g.moveTo(padL, volTop - 10.5); g.lineTo(padL + plotW, volTop - 10.5); g.stroke();

      const tickCount = Math.min(
        Math.max(2, Math.floor(plotW / 90)),
        Math.max(2, bars.length - 1)
      );
      for (let i = 0; i <= tickCount; i++) {
        const idx = Math.min(bars.length - 1, Math.round((i / tickCount) * (bars.length - 1)));
        const px = x(idx);
        g.strokeStyle = "#141c27";
        g.beginPath(); g.moveTo(px + 0.5, padT); g.lineTo(px + 0.5, volTop + volH); g.stroke();
        g.fillStyle = "#6b7789"; g.textAlign = i === 0 ? "left" : i === tickCount ? "right" : "center";
        const label = bars[idx][0].slice(5);
        g.fillText(label, px, H - 10);
      }

      /* 爆量竖带（贯穿价格与成交量） */
      const bw = Math.max(1, Math.min(34, step * 0.62));
      for (let i = 0; i < bars.length; i++) {
        if (!state.spikes[i]) continue;
        g.fillStyle = "rgba(255,159,26,.055)";
        g.fillRect(x(i) - bw / 2 - 2, padT, bw + 4, volTop + volH - padT);
      }

      /* 成交量 */
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const up = b[2] >= b[1];
        g.fillStyle = state.spikes[i]
          ? "#ff9f1a"
          : up ? "rgba(240,82,82,.72)" : "rgba(33,166,122,.72)";
        const top = vy(b[5]);
        g.fillRect(x(i) - bw / 2, top, bw, volTop + volH - top);
      }

      /* K线 */
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const up = b[2] >= b[1];
        const color = up ? "#f05252" : "#21a67a";
        const cx = x(i);
        g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, y(b[3])); g.lineTo(cx, y(b[4]));
        g.stroke();
        const yo = y(b[1]), yc = y(b[2]);
        const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        g.fillRect(cx - bw / 2, top, bw, hgt);
        if (step > 3 && hgt > 2) {
          g.strokeStyle = up ? "#f05252" : "#21a67a";
          g.strokeRect(cx - bw / 2 + 0.5, top + 0.5, Math.max(0.5, bw - 1), Math.max(0.5, hgt - 1));
        }
        if (state.spikes[i]) {
          g.strokeStyle = "#ff9f1a";
          g.lineWidth = 1;
          g.strokeRect(cx - bw / 2 - 1, top - 1, bw + 2, hgt + 2);
          const hy = Math.max(padT + 10, y(b[3]) - 3);
          g.fillStyle = "#ff9f1a";
          g.beginPath();
          g.moveTo(cx - 4, hy - 6);
          g.lineTo(cx + 4, hy - 6);
          g.lineTo(cx, hy);
          g.closePath();
          g.fill();
        }
      }

      /* 均线 */
      const drawMA = (arr, color) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
        let started = false;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == null) { started = false; continue; }
          const px = x(i), py = y(arr[i]);
          if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
        }
        g.stroke();
      };
      drawMA(state.ma5, "#f5a524");
      drawMA(state.ma10, "#4c8dff");
      drawMA(state.ma20, "#b06cf5");

      /* 昨收参考线 */
      if (bars.length > 1) {
        const prevClose = bars[bars.length - 2][2];
        if (prevClose >= min && prevClose <= max) {
          const py = y(prevClose);
          g.save();
          g.setLineDash([3, 3]);
          g.strokeStyle = "rgba(139,152,169,.55)";
          g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke();
          g.restore();
          g.fillStyle = "#8b98a9"; g.textAlign = "left";
          let labelY = py - 7;
          const gridYs = [0, 1, 2, 3, 4].map((k) => padT + (priceH / 4) * k);
          if (gridYs.some((gy) => Math.abs(gy - labelY) < 9)) labelY = py + 12;
          labelY = Math.max(padT + 6, Math.min(padT + priceH - 4, labelY));
          g.fillText(state.aggregated ? "上期收盘" : "昨收", padL + plotW + 8, labelY);
        }
      }

      /* 十字光标 */
      if (state.hover >= 0 && state.hover < bars.length) {
        const i = state.hover;
        const cx = x(i);
        g.setLineDash([4, 3]);
        g.strokeStyle = "#5b6b81";
        g.beginPath(); g.moveTo(cx, padT); g.lineTo(cx, volTop + volH); g.stroke();
        const cy = Math.min(padT + priceH, Math.max(padT, mouse.y));
        g.beginPath(); g.moveTo(padL, cy); g.lineTo(padL + plotW, cy); g.stroke();
        g.setLineDash([]);

        const priceAt = max - ((cy - padT) / priceH) * (max - min);
        g.fillStyle = "#1d2a3d";
        g.fillRect(padL + plotW + 3, cy - 9, padR - 6, 18);
        g.fillStyle = "#cfe0ff"; g.textAlign = "left";
        g.fillText(priceAt.toFixed(priceAt < 10 ? 3 : 2), padL + plotW + 8, cy);

        const dt = bars[i][0];
        const tw = g.measureText(dt).width + 12;
        g.fillStyle = "#1d2a3d";
        g.fillRect(Math.min(Math.max(cx - tw / 2, 0), W - tw), H - 22, tw, 18);
        g.fillStyle = "#cfe0ff"; g.textAlign = "center";
        g.fillText(dt, Math.min(Math.max(cx, tw / 2), W - tw / 2), H - 13);
      }
      state.x = x; state.step = step;
    }

    function updateHead() {
      const etf = state.etf;
      if (!etf) return;
      h2.textContent = etf.name;
      codeEl.textContent = etf.code + (etf.index ? " · " + etf.index : "");
      sectorEl.textContent = etf.sector;

      const bars = state.bars;
      const i = state.hover >= 0 && state.hover < bars.length ? state.hover : bars.length - 1;
      const b = bars[i];
      const prev = i > 0 ? bars[i - 1][2] : b[1];
      const chg = prev ? ((b[2] - prev) / prev) * 100 : 0;
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      ohlc.innerHTML =
        `<span>开<b>${fmt(b[1], 3)}</b></span>` +
        `<span>高<b>${fmt(b[3], 3)}</b></span>` +
        `<span>低<b>${fmt(b[4], 3)}</b></span>` +
        `<span class="${cls}">收<b>${fmt(b[2], 3)}</b></span>` +
        `<span class="${cls}">涨跌<b>${pct(chg)}</b></span>` +
        `<span>成交量<b>${volumeText(b[5])}</b></span>` +
        `<span>成交额<b>${amountText(b[6])}元</b></span>`;

      const modeText = state.aggregated ? "周K（自动压缩）" : "日K";
      const spikeCount = state.spikes.filter(Boolean).length;
      foot.innerHTML =
        `<span>${modeText} · ${bars.length} 根 · 爆量 ${spikeCount} 根 · ${bars[0][0]} ~ ${bars[bars.length - 1][0]}</span>` +
        `<span>数据：东方财富 · 前复权 · 成交量单位：手</span>`;
      legend.innerHTML =
        `<span><i style="background:#f5a524"></i>MA5</span>` +
        `<span><i style="background:#4c8dff"></i>MA10</span>` +
        `<span><i style="background:#b06cf5"></i>MA20</span>` +
        `<span style="color:#ff9f1a">● 爆量</span>`;
    }

    function renderTooltip() {
      if (state.hover < 0 || state.hover >= state.bars.length) {
        tooltip.style.display = "none";
        return;
      }
      const i = state.hover;
      const b = state.bars[i];
      const prev = i > 0 ? state.bars[i - 1][2] : b[1];
      const chg = prev ? ((b[2] - prev) / prev) * 100 : 0;
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      const range = b[8] && b[8] !== b[0] ? `${b[0]} ~ ${b[8]}` : b[0];
      tooltip.innerHTML =
        `<div class="t">${range}</div>` +
        `<div><span class="k">开</span><b>${fmt(b[1], 3)}</b></div>` +
        `<div><span class="k">高</span><b>${fmt(b[3], 3)}</b></div>` +
        `<div><span class="k">低</span><b>${fmt(b[4], 3)}</b></div>` +
        `<div class="${cls}"><span class="k">收</span><b>${fmt(b[2], 3)}</b></div>` +
        `<div class="${cls}"><span class="k">涨跌</span><b>${pct(chg)}</b></div>` +
        `<div><span class="k">量</span><b>${volumeText(b[5])}</b></div>` +
        `<div><span class="k">额</span><b>${amountText(b[6])}元</b></div>` +
        (state.spikes[i]
          ? `<div style="color:#ff9f1a"><span class="k">量能</span><b>${state.spikes[i].toFixed(1)}×均量</b> 爆量</div>`
          : "") +
        (state.ma5[i] != null ? `<div><span class="k">MA5</span><b>${state.ma5[i].toFixed(3)}</b></div>` : "") +
        (state.ma10[i] != null ? `<div><span class="k">MA10</span><b>${state.ma10[i].toFixed(3)}</b></div>` : "") +
        (state.ma20[i] != null ? `<div><span class="k">MA20</span><b>${state.ma20[i].toFixed(3)}</b></div>` : "");
      const px = state.x ? state.x(i) : 0;
      const hostW = host.clientWidth, hostH = host.clientHeight;
      const tw = 180, th = tooltip.offsetHeight || 180;
      let left = px + 16;
      if (left + tw > hostW - 10) left = px - tw - 16;
      let top = Math.max(8, Math.min(mouse.y - th / 2, hostH - th - 8));
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
      tooltip.style.display = "block";
    }

    const mouse = { x: 0, y: 0 };
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      const bars = state.bars;
      if (!bars.length || !state.step) return;
      const idx = Math.floor((mouse.x - 10) / state.step);
      state.hover = idx >= 0 && idx < bars.length ? idx : -1;
      draw();
      updateHead();
      renderTooltip();
    });
    canvas.addEventListener("mouseleave", () => {
      state.hover = -1;
      tooltip.style.display = "none";
      draw();
      updateHead();
    });

    function renderFlows() {
      const f = state.flows;
      if (!f || !Array.isArray(f.history) || !f.history.length) {
        flowPanel.style.display = "none";
        return;
      }
      flowPanel.style.display = "";
      const hist = f.history.slice(-45);
      const last = hist[hist.length - 1];
      const fmt1 = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1));
      const score = f.score == null ? null : Number(f.score);
      const scoreColor = score == null ? "#2c3a4d" : score >= 65 ? "#21a67a" : score >= 45 ? "#f5a524" : "#f05252";
      flowNet.textContent = last.total == null ? "待补" : fmt1(last.total) + " 亿";
      flowNet.className = last.total > 0 ? "up" : last.total < 0 ? "down" : "";
      flowCum.textContent = last.cum5 == null ? "—" : fmt1(last.cum5) + " 亿";
      flowCum.className = last.cum5 > 0 ? "up" : last.cum5 < 0 ? "down" : "";
      flowScore.textContent = score == null ? "--" : score.toFixed(0);
      flowScore.style.color = scoreColor;
      const note = flowPanel.querySelector(".flow-note");
      if (note) {
        if (last.total == null) {
          note.textContent = "今日份额接口限流：净申购/尾盘待补，K线与溢价率已更新";
          note.style.color = "#f5a524";
        } else {
          note.textContent = "份额 T+1 · 净申购 = 份额变化 × 收盘价 · 足迹分 ≥65 偏多 / <45 偏空";
          note.style.color = "";
        }
      }

      const hostRect = flowCanvas.parentElement.getBoundingClientRect();
      const tableW = flowTable.getBoundingClientRect().width || 480;
      const W = Math.max(240, Math.floor(hostRect.width - tableW - 24));
      const H = 160;
      const dpr = window.devicePixelRatio || 1;
      flowCanvas.width = W * dpr;
      flowCanvas.height = H * dpr;
      flowCanvas.style.width = W + "px";
      flowCanvas.style.height = H + "px";
      const g = flowCanvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);

      const padL = 8, padR = 8, padT = 20, padB = 16;
      const plotW = W - padL - padR;
      const n = hist.length;
      const step = plotW / n;
      const x = (i) => padL + (i + 0.5) * step;
      const zeroY = padT + (H - padT - padB) / 2;
      const half = (H - padT - padB) / 2 - 4;
      const totals = hist.map((d) => d.total);
      const maxAbs = Math.max(1, ...totals.filter((v) => v != null).map((v) => Math.abs(v)));

      g.strokeStyle = "#24303f";
      g.beginPath();
      g.moveTo(padL, zeroY + 0.5);
      g.lineTo(W - padR, zeroY + 0.5);
      g.stroke();

      g.fillStyle = "#4a5568";
      g.font = "9px 'Segoe UI', sans-serif";
      g.textAlign = "left";
      g.fillText(`+${maxAbs.toFixed(0)}亿`, padL, padT + 2);
      g.fillText(`-${maxAbs.toFixed(0)}亿`, padL, H - padB - 2);

      const bw = Math.max(2, Math.min(16, step * 0.55));
      hist.forEach((d, i) => {
        if (d.total == null) return;
        const v = d.total;
        const h = Math.max(1, (Math.abs(v) / maxAbs) * half);
        const cx = x(i);
        g.fillStyle = v >= 0 ? "#f05252" : "#21a67a";
        g.fillRect(cx - bw / 2, v >= 0 ? zeroY - h : zeroY, bw, h);
      });

      const prems = hist.map((d) => d.premium).filter((v) => v != null);
      if (prems.length > 1) {
        const pmin = Math.min(...prems);
        const pmax = Math.max(...prems);
        const span = pmax - pmin || 0.1;
        const py = (v) => padT + 6 + ((pmax - v) / span) * (H - padT - padB - 10);
        g.strokeStyle = "#f5a524";
        g.lineWidth = 1.4;
        g.beginPath();
        let started = false;
        hist.forEach((d, i) => {
          if (d.premium == null) { started = false; return; }
          const px = x(i);
          const yy = py(d.premium);
          if (!started) { g.moveTo(px, yy); started = true; } else g.lineTo(px, yy);
        });
        g.stroke();
        g.fillStyle = "#8b98a9";
        g.font = "9px 'Segoe UI', sans-serif";
        g.textAlign = "right";
        g.fillText(`溢价 ${pmin.toFixed(2)}% ~ ${pmax.toFixed(2)}%`, W - padR, 10);
      }

      const firstBar = hist.findIndex((d) => d.total != null);
      if (firstBar > 0) {
        const px = x(firstBar) - step / 2;
        g.save();
        g.setLineDash([3, 3]);
        g.strokeStyle = "#3a4a5f";
        g.beginPath();
        g.moveTo(px, padT);
        g.lineTo(px, H - padB);
        g.stroke();
        g.restore();
      }

      g.font = "10px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      g.textAlign = "left";
      g.fillStyle = "#f05252";
      g.fillRect(padL, 3, 8, 8);
      g.fillStyle = "#8b98a9";
      g.fillText("净申购(11-06起)", padL + 12, 10);
      g.strokeStyle = "#f5a524";
      g.beginPath(); g.moveTo(padL + 116, 7); g.lineTo(padL + 132, 7); g.stroke();
      g.fillStyle = "#8b98a9";
      g.fillText("溢价率(%)", padL + 136, 10);

      g.fillStyle = "#5b6779";
      g.font = "9px 'Segoe UI', sans-serif";
      g.textAlign = "left";
      g.fillText(hist[0].date.slice(5), padL, H - 2);
      g.textAlign = "center";
      g.fillText(hist[Math.floor(n / 2)].date.slice(5), W / 2, H - 2);
      g.textAlign = "right";
      g.fillText(last.date.slice(5), W - padR, H - 2);


      const rows = (f.etfs || []).slice().sort((a, b) => (b.shares || 0) - (a.shares || 0));
      const head = '<div class="flow-row head"><span>标的</span><span>份额</span><span>净申购</span><span>尾盘</span><span>溢价</span><span class="r">量比</span></div>';
      flowTable.innerHTML = head + rows.map((e) => {
        const net = e.net == null ? "—" : (e.net > 0 ? "+" : "") + e.net.toFixed(1);
        const cls = e.net > 0 ? "up" : e.net < 0 ? "down" : "";
        const tail = e.tail == null ? "—" : (e.tail * 100).toFixed(0) + "%";
        const prem = e.premium == null ? "—" : (e.premium > 0 ? "+" : "") + e.premium.toFixed(2) + "%";
        const pcls = e.premium > 0 ? "up" : e.premium < 0 ? "down" : "";
        return `<div class="flow-row"><span class="n">${e.name}</span>` +
          `<span>${e.shares ? e.shares.toFixed(0) : "—"}</span>` +
          `<span class="${cls}">${net}</span>` +
          `<span>${tail}</span>` +
          `<span class="${pcls}">${prem}</span>` +
          `<span class="r">${e.amtRatio ? e.amtRatio.toFixed(1) : "—"}×</span></div>`;
      }).join("");
    }

    function renderAll() {
      if (!state.data) return;
      state.hover = -1;
      buildSeries();
      renderList();
      updateHead();
      draw();
      renderStatus();
      tooltip.style.display = "none";
      syncSeg();
    }

    function render() {
      buildSeries();
      updateHead();
      draw();
      syncSeg();
    }

    function renderStatus() {
      const d = state.data;
      const closed = !!d.tradingClosed;
      dot.className = "dot" + (closed ? " closed" : "");
      const cntErr = state.status === "error" ? " · 数据加载失败" : "";
      sub.textContent = `最新交易日 ${d.latestTradeDate} · 更新于 ${d.updatedAt.slice(5, 16)} · ${closed ? "已收盘" : "盘中"}${cntErr}`;
    }

    function syncSeg() {
      viewSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
      rangeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.range === state.range));
    }

    new ResizeObserver(() => {
      if (state.data) draw();
      if (state.flows) renderFlows();
    }).observe(host);

    /* 自动刷新：每 60 秒拉一次，收盘后一般无变化 */
    let timer = null;
    function startTimer() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (document.hidden) return;
        load(false);
      }, 60000);
    }

    load(true).then(startTimer);

    return {
      refresh: () => load(true),
      state,
    };
  }

  global.EtfDashboard = { mount };
})(window);
