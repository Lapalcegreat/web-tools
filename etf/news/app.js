(() => {
  const $ = (sel) => document.querySelector(sel);
  const CAT_LABEL = {
    capex: "资本开支", chip: "算力芯片", memory: "HBM/存储",
    network: "光互连", power: "电力/散热", policy: "政策/监管",
    model: "模型/应用", other: "其他",
  };
  const TIER_LABEL = {
    major: "一线媒体", research: "研究", trade: "垂直媒体",
    vendor: "厂商", official: "官方",
  };
  const WEEK = "日一二三四五六";
  let data = null;
  let activeDate = null;

  const fmtImpact = (v) => (v > 0 ? "+" : "") + Number(v || 0).toFixed(1);
  const weekday = (date) => {
    const d = new Date(date + "T00:00:00");
    return "周" + WEEK[d.getDay()];
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderDays() {
    const host = $("#days");
    host.innerHTML = "";
    if (!data || !data.days || !data.days.length) {
      host.appendChild(el("div", "empty", "暂无数据"));
      return;
    }
    data.days.forEach((day) => {
      const btn = el("button", "day" + (day.date === activeDate ? " active" : ""));
      btn.type = "button";
      btn.appendChild(el("span", "d", day.date.slice(5)));
      btn.appendChild(el("span", "w", weekday(day.date)));
      btn.appendChild(el("span", "n", `${day.stats.count} 条`));
      btn.onclick = () => select(day.date);
      host.appendChild(btn);
    });
  }

  function renderStats(day) {
    const host = $("#stats");
    host.innerHTML = "";
    const items = [
      ["条数", `${day.stats.count}`],
      ["净影响", fmtImpact(day.stats.netImpact)],
      ["平均可信度", `${Math.round(day.stats.avgConf * 100)}%`],
      ["偏多", `${day.stats.pos}`],
      ["偏空", `${day.stats.neg}`],
    ];
    items.forEach(([k, v]) => {
      const node = el("span", "stat");
      node.append(k + " ");
      node.appendChild(el("b", null, v));
      host.appendChild(node);
    });
  }

  function renderCats(day) {
    const host = $("#cats");
    host.innerHTML = "";
    const entries = Object.entries(day.categories || {})
      .sort((a, b) => Math.abs(b[1].impact) - Math.abs(a[1].impact));
    entries.forEach(([key, v]) => {
      const node = el("span", "cat", CAT_LABEL[key] || key);
      node.appendChild(el("b", null, `${v.count} 条`));
      const imp = el("span", v.impact >= 0 ? "up" : "down", ` ${fmtImpact(v.impact)}`);
      node.appendChild(imp);
      host.appendChild(node);
    });
  }

  function renderItems(day) {
    const host = $("#items");
    host.innerHTML = "";
    if (!day.items || !day.items.length) {
      host.appendChild(el("div", "empty", "当日无高可信度条目"));
      return;
    }
    day.items.forEach((it) => {
      const card = el("div", "item");
      const link = el("a", "title", it.title);
      link.href = it.url || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.appendChild(link);

      const meta = el("div", "meta");
      meta.appendChild(el("span", null, `${it.source} · ${it.time.slice(5)}`));
      const imp = el("span", "badge impact " + (it.impact >= 0 ? "up" : "down"), fmtImpact(it.impact));
      meta.appendChild(imp);
      meta.appendChild(el("span", "badge conf", `可信 ${Math.round(it.confidence * 100)}%`));
      if (it.tier) meta.appendChild(el("span", "badge tier", TIER_LABEL[it.tier] || it.tier));
      (it.tags || []).forEach((tag) => meta.appendChild(el("span", "badge tag", tag)));
      card.appendChild(meta);
      host.appendChild(card);
    });
  }

  function select(date) {
    activeDate = date;
    const day = data.days.find((d) => d.date === date) || data.days[0];
    if (!day) return;
    renderDays();
    $("#date").textContent = `${day.date} ${weekday(day.date)} · 更新 ${data.updatedAt}`;
    $("#conclusion").textContent = day.conclusion || "无高置信度方向性事件。";
    renderStats(day);
    renderCats(day);
    renderItems(day);
  }

  function load() {
    fetch("daily.json?t=" + Date.now(), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        data = d;
        if (!d.days || !d.days.length) {
          $("#conclusion").textContent = "还没有生成每日情报，请先运行 scripts/overseas_news.py。";
          return;
        }
        const first = d.days.find((day) => day.stats.count >= 3) || d.days[0];
        select(first.date);
      })
      .catch((err) => {
        $("#conclusion").textContent = "读取 daily.json 失败：" + err.message;
      });
  }

  $("#reload").onclick = load;
  load();
})();
