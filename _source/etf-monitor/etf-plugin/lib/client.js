/**
 * dsh-etf-charts — 浏览器半。
 *
 * 在左侧导航注册一个「ETF行情」入口，主面板用同源 iframe 加载宿主路由
 * /etf-charts/ 下的行情页（含 K 线、成交量、日/月压缩）。
 */
window.__ModuleLoader__.load({
  id: "dsh-etf-charts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    function report(text) {
      try {
        fetch("/etf-charts/api/diag", { method: "POST", body: String(text) });
      } catch (error) {}
    }
    report("client module loaded");

    const PANEL_ID = "etf-charts";

    function EtfPage() {
      return h(
        "div",
        {
          style: {
            position: "relative",
            width: "100%",
            height: "100%",
            minHeight: "520px",
            background: "#0d1117",
          },
        },
        h("iframe", {
          src: "/etf-charts/",
          title: "A股宽基ETF行情",
          style: {
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
            border: 0,
          },
        })
      );
    }

    function EtfIcon() {
      return h(
        "svg",
        {
          width: 18,
          height: 18,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
        },
        h("path", { d: "M5 20V11" }),
        h("path", { d: "M10 20V5" }),
        h("path", { d: "M15 20v-6" }),
        h("path", { d: "M20 20V9" })
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      try {
        if (!ctx.slots || typeof ctx.slots.inject !== "function") {
          report("client apply FAILED: ctx.slots.inject unavailable");
          return;
        }
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: PANEL_ID }, EtfPage)
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => "ETF行情" },
            EtfIcon
          )
        );
        report("client apply ok");
      } catch (error) {
        report("client apply FAILED: " + String(error && (error.stack || error.message || error)));
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
