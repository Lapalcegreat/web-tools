/**
 * dsh-etf-charts — A股宽基ETF行情页（宿主半）。
 *
 * 1. 把工作区里的 etf-dashboard 静态目录挂到 /etf-charts 前缀路由，
 *    浏览器端页面用同源 iframe 打开；
 * 2. 提供 /etf-charts/api/update，按需触发一次收盘后增量抓取（供页面「刷新」按钮调用）。
 * 数据文件每次请求现读磁盘，收盘后写入新数据、页面刷新即可看到，无需重启 DSH。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

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

function applyInner(ctx, config) {
  const root = resolve(String(config?.dir ?? ""));
  const workspace = resolve(root, "..");
  const script = resolve(workspace, "scripts", "fetch_etf.py");
  const cycleScript = resolve(workspace, "scripts", "cycle_score.py");
  const inputsPath = resolve(root, "cycle", "inputs.json");
  const python = String(config?.python ?? "").trim() ||
    "C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

  let running = null;
  let lastResult = null;
  let cycleRunning = null;

  async function runCycle() {
    if (cycleRunning) return cycleRunning;
    cycleRunning = (async () => {
      const started = Date.now();
      const result = await new Promise((done) => {
        execFile(
          python,
          [cycleScript],
          {
            cwd: workspace,
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
          },
          (error, stdout, stderr) => {
            done({
              ok: !error,
              code: error?.code ?? 0,
              message: error ? String(error.message) : "",
              stdout: String(stdout ?? "").trim().split(/\r?\n/).slice(-20),
              stderr: String(stderr ?? "").trim().split(/\r?\n/).slice(-10),
              ms: Date.now() - started,
            });
          }
        );
      });
      return result;
    })().finally(() => { cycleRunning = null; });
    return cycleRunning;
  }

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
    if (rel === "/api/diag") {
      try {
        const text = await request.text();
        pluginLog(config, "client diag: " + String(text).slice(0, 8000));
      } catch (error) {
        pluginLog(config, "client diag read failed: " + String(error && (error.stack || error)));
      }
      return json({ ok: true });
    }
    if (rel === "/api/status") {
      return json({ ok: true, lastResult });
    }
    if (rel === "/api/cycle") {
      try {
        const raw = url.searchParams.get("inputs");
        if (raw != null) {
          if (raw.length > 8192) return json({ ok: false, message: "行业输入过大" }, 400);
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") throw new Error("inputs 必须是对象");
          await mkdir(dirname(inputsPath), { recursive: true });
          await writeFile(inputsPath, JSON.stringify(parsed, null, 1), "utf8");
        }
        return json(await runCycle());
      } catch (error) {
        return json({ ok: false, message: String(error?.message ?? error) }, 500);
      }
    }

    if (rel === "" || rel === "/") rel = "/index.html";
    else if (rel.endsWith("/")) rel += "index.html";
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


function pluginLogPath(config) {
  try {
    const base = config && config.dir ? resolve(String(config.dir), "..") : tmpdir();
    return resolve(base, "logs", "etf-plugin-error.log");
  } catch {
    return resolve(tmpdir(), "etf-plugin-error.log");
  }
}

function pluginLog(config, message) {
  try {
    const file = pluginLogPath(config);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, "[" + new Date().toISOString() + "] " + message + "\n", "utf8");
  } catch {}
}

export function apply(ctx, config) {
  try {
    applyInner(ctx, config);
    pluginLog(config, "activated: route /etf-charts registered, dir=" + String(config && config.dir));
  } catch (error) {
    pluginLog(config, "activation FAILED: " + String(error && (error.stack || error.message || error)));
    pluginLog(config, "diagnostics: webServer=" + (ctx && typeof ctx.get === "function" ? String(!!ctx.get("webServer")) : "n/a") + ", dir=" + String(config && config.dir));
  }
}
