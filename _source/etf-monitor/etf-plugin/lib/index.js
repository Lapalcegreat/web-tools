/**
 * dsh-etf-charts — A股宽基ETF行情页（宿主半）。
 *
 * 1. 把工作区里的 etf-dashboard 静态目录挂到 /etf-charts 前缀路由，
 *    浏览器端页面用同源 iframe 打开；
 * 2. 提供 /etf-charts/api/update，按需触发一次收盘后增量抓取（供页面「刷新」按钮调用）。
 * 数据文件每次请求现读磁盘，收盘后写入新数据、页面刷新即可看到，无需重启 DSH。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

export const name = "dsh-etf-charts";
export const inject = ["webServer"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(file) {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function apply(ctx, config) {
  const root = resolve(String(config?.dir ?? ""));
  const workspace = resolve(root, "..");
  const script = resolve(workspace, "scripts", "fetch_etf.py");
  const python = String(config?.python ?? "").trim() ||
    "C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

  let running = null;
  let lastResult = null;

  async function runUpdate() {
    if (running) return running;
    running = (async () => {
      const started = Date.now();
      const result = await new Promise((done) => {
        execFile(
          python,
          [script],
          {
            cwd: workspace,
            timeout: 120000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
          },
          (error, stdout, stderr) => {
            done({
              ok: !error,
              code: error?.code ?? 0,
              message: error ? String(error.message) : "",
              stdout: String(stdout ?? "").trim().split(/\r?\n/).slice(-40),
              stderr: String(stderr ?? "").trim().split(/\r?\n/).slice(-20),
              ms: Date.now() - started,
              at: new Date().toISOString(),
            });
          }
        );
      });
      lastResult = result;
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  const handler = async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname.slice("/etf-charts".length));

    if (rel === "/api/update") {
      try {
        return json(await runUpdate());
      } catch (error) {
        return json({ ok: false, message: String(error?.message ?? error) }, 500);
      }
    }
    if (rel === "/api/status") {
      return json({ ok: true, lastResult });
    }

    if (rel === "" || rel === "/") rel = "/index.html";
    const file = resolve(root, "." + rel);
    const relCheck = relative(root, file);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType(file),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  };

  const dispose = ctx.webServer.register({ kind: "prefix", path: "/etf-charts", resource: handler });
  const cleanup = () => dispose();
  if (typeof ctx.effect === "function") ctx.effect(() => cleanup);
  else if (typeof ctx.on === "function") ctx.on("dispose", cleanup);
}
