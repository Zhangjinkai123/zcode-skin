#!/usr/bin/env node
/**
 * zcode-skin — 给 ZCode 桌面端设置自定义背景壁纸的命令行工具。
 *
 * 原理：ZCode 生产构建不带调试端口，本工具以 --remote-debugging-port 启动
 * ZCode（或要求用户重启），随后通过 Chrome DevTools Protocol 向渲染进程注入
 * 一段幂等的 bootstrap 脚本：把窗口背景透明化、铺一层壁纸、按配置叠加模糊
 * 与压暗。`watch` 子命令常驻并维持 CDP 会话，使主题在页面刷新/新窗口后自动
 * 恢复。全程不修改 ZCode 安装文件，卸载即 reset。
 *
 * 零 npm 依赖，需要 Node >= 22（内置 WebSocket）。
 *
 * 用法：
 *   node zcode-skin.mjs apply <图片路径> [--blur N] [--dim N] [--brighten N] [--light-dim N] [--fit cover|contain] [--port N]
 *   node zcode-skin.mjs adjust [--blur N] [--dim N] [--brighten N] [--light-dim N] [--fit ...]
 *   node zcode-skin.mjs reset
 *   node zcode-skin.mjs launch
 *   node zcode-skin.mjs relaunch --yes        # 会先结束当前 ZCode 进程
 *   node zcode-skin.mjs watch [--stop]
 *   node zcode-skin.mjs autostart [--off]     # Windows: 写入/移除开机自启
 *   node zcode-skin.mjs status
 *   node zcode-skin.mjs print-css             # 调试：输出将注入的 CSS
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

export function dataDir() {
  if (process.env.ZCODE_SKIN_DATA_DIR) return process.env.ZCODE_SKIN_DATA_DIR;
  return path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "zcode-skin");
}

function configFile() {
  return path.join(dataDir(), "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return next;
}

const DEFAULTS = { port: 9222, blur: 0, dim: 25, brighten: 0, lightDim: 0, fit: "cover" };

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class CdpError extends Error {}

async function listTargets(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new CdpError(`CDP 端点不可达 (127.0.0.1:${port})——ZCode 需以 --remote-debugging-port=${port} 启动`);
  }
  if (!res.ok) throw new CdpError(`CDP /json/list 返回 HTTP ${res.status}`);
  return res.json();
}

/** 主窗口渲染进程；排除 devtools 等辅助页。 */
function pickRendererTargets(targets) {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const main = pages.filter(
    (t) => t.url.includes("out/renderer/index.html") || t.title === "ZCode" || /zcode/i.test(t.url)
  );
  return main.length > 0 ? main : pages.filter((t) => !t.url.startsWith("devtools://"));
}

class CdpConnection {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new CdpError("CDP 连接已关闭"));
      this.pending.clear();
      this.closed = true;
    });
  }

  static connect(wsUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const conn = new CdpConnection(wsUrl);
      const timer = setTimeout(() => reject(new CdpError("CDP WebSocket 连接超时")), timeoutMs);
      conn.ws.addEventListener("open", () => { clearTimeout(timer); resolve(conn); });
      conn.ws.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError(`CDP WebSocket 连接失败: ${wsUrl}`)); });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 注入内容生成
// ---------------------------------------------------------------------------

export const MARKER = "zcode-skin";

/**
 * 生成注入 CSS：壁纸层 + 透明化 ZCode 的 Tailwind v4 `--color-*` 语义变量。
 * 亮/暗色分别覆盖，保证应用自身切换深色模式时仍然透出壁纸。
 * ZCode 的主题类是 html 上的 `theme-zai-light` / `theme-zai-dark`（无 Tailwind `.dark`），
 * 两者都兼容；`brighten` 只在浅色主题下生效，把压暗换成白色提亮层。
 */
export function buildCss({ blur = 0, dim = 25, brighten = 0, lightDim = 0, fit = "cover" } = {}) {
  const dimAlpha = clamp(dim, 0, 100) / 100;
  const brightenAlpha = clamp(brighten, 0, 100) / 100;
  const lightDimAlpha = clamp(lightDim, 0, 100) / 100;
  const parts = [];

  parts.push(`
html, body { background: transparent !important; }
#${MARKER}-wallpaper {
  position: fixed; inset: 0; z-index: -2147483646;
  background-repeat: no-repeat; pointer-events: none;
  filter: blur(${blur}px);
  transform: scale(${blur > 0 ? 1.04 : 1});
}
#${MARKER}-backdrop {
  position: fixed; inset: 0; z-index: -2147483647;
  background-size: cover; background-position: center; background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(28px) saturate(1.15) brightness(0.85);
  transform: scale(1.12); display: none;
}
#${MARKER}-backdrop[data-on="1"] { display: block; }`);

  if (dimAlpha > 0) {
    // 压暗只对暗色主题生效：浅色 UI 本就发白，再叠黑层会灰蒙蒙看不清壁纸
    parts.push(`html.dark #${MARKER}-wallpaper::after,
html.theme-zai-dark #${MARKER}-wallpaper::after {
  content: ''; position: absolute; inset: 0;
  background: rgb(0 0 0 / ${dimAlpha});
}`);
  }

  if (brightenAlpha > 0) {
    // 浅色主题：用白色提亮层替代压暗（选择器特异性更高，天然覆盖上面的暗层）
    parts.push(`html:not(.dark):not(.theme-zai-dark) #${MARKER}-wallpaper::after {
  content: ''; position: absolute; inset: 0;
  background: rgb(255 255 255 / ${brightenAlpha});
}`);
  }

  if (lightDimAlpha > 0) {
    // 浅色主题压暗：与 --brighten 互斥，同时设置时排在其后、天然覆盖
    parts.push(`html:not(.dark):not(.theme-zai-dark) #${MARKER}-wallpaper::after {
  content: ''; position: absolute; inset: 0;
  background: rgb(0 0 0 / ${lightDimAlpha});
}`);
  }

  // 面板/卡片保持半透明底色以保住可读性，仅背景层完全透明。
  parts.push(transparencyCss(dimAlpha));

  // 隐藏欢迎页的大 Z Logo 水印：壁纸模式下它浮在壁纸上显得很脏。
  // 容器是 aria-hidden 的绝对定位 div（类名含 text-foreground-subtlest 与 aspect-[5/4]），
  // 内含亮色 <svg> 与暗色 <img data-v4-draft-logo="dark"> 两个变体，隐藏容器一并覆盖。
  parts.push(`div[aria-hidden="true"][class*="text-foreground-subtlest"][class*="aspect-[5/4]"] { display: none !important; }
img[data-v4-draft-logo] { display: none !important; }`);

  return parts.join("\n");
}

function transparencyCss(dimAlpha) {
  const panel = "rgba(255,255,255,0.62)", panelDark = "rgba(18,18,22,0.62)";
  const surface = "rgba(255,255,255,0.72)", surfaceDark = "rgba(18,18,22,0.72)";
  const input = "rgba(255,255,255,0.5)", inputDark = "rgba(18,18,22,0.5)";
  const popover = "rgba(255,255,255,0.92)", popoverDark = "rgba(18,18,22,0.92)";
  return `:root,:host{
  --color-background:transparent;
  --color-background-alt:${panel};
  --color-background-win-alt:${panel};
  --color-panel:${panel};
  --color-sidebar:${panel};
  --color-surface:${surface};
  --color-surface-hover:${surface};
  --color-card:${surface};
  --color-popover:${popover};
  --color-input:${input};
  --color-input-focused:rgba(255,255,255,0.7);
  ${dimAlpha > 0 ? `--${MARKER}-dim:${dimAlpha};` : ""}
}
.dark,.theme-zai-dark{
  --color-background:transparent;
  --color-background-alt:${panelDark};
  --color-background-win-alt:${panelDark};
  --color-panel:${panelDark};
  --color-sidebar:${panelDark};
  --color-surface:${surfaceDark};
  --color-surface-hover:${surfaceDark};
  --color-card:${surfaceDark};
  --color-popover:${popoverDark};
  --color-input:${inputDark};
  --color-input-focused:rgba(18,18,22,0.7);
}`;
}

/** 幂等 bootstrap：同内容重复注入直接跳过；先挂 style 与壁纸层再存标记。 */
export function buildBootstrap({ css, wallpaperDataUri, fit }) {
  return `(function(){
  var M = ${JSON.stringify(MARKER)};
  window.__zcodeSkin = window.__zcodeSkin || {};
  var payload = ${JSON.stringify({ css, wallpaperDataUri: wallpaperDataUri ?? "", fit: fit ?? "cover" })};
  if (window.__zcodeSkin.payload === JSON.stringify(payload)) return;
  window.__zcodeSkin.payload = JSON.stringify(payload);

  var style = document.getElementById(M + '-style');
  if (!style) {
    style = document.createElement('style');
    style.id = M + '-style';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = payload.css;

  var wp = document.getElementById(M + '-wallpaper');
  if (!wp) {
    wp = document.createElement('div');
    wp.id = M + '-wallpaper';
    document.documentElement.appendChild(wp);
  }
  wp.style.backgroundImage = payload.wallpaperDataUri ? 'url(' + payload.wallpaperDataUri + ')' : '';
  wp.style.backgroundSize = payload.fit === 'contain' ? 'contain' : 'cover';
  wp.style.backgroundPosition = payload.fit === 'contain' ? 'center' : 'center';

  var bp = document.getElementById(M + '-backdrop');
  if (!bp) {
    bp = document.createElement('div');
    bp.id = M + '-backdrop';
    document.documentElement.appendChild(bp);
  }
  bp.style.backgroundImage = payload.wallpaperDataUri && payload.fit === 'contain'
    ? 'url(' + payload.wallpaperDataUri + ')' : '';
  bp.dataset.on = payload.wallpaperDataUri && payload.fit === 'contain' ? '1' : '0';
})();`;
}

export function buildResetScript() {
  return `(function(){
  ['${MARKER}-style', '${MARKER}-wallpaper', '${MARKER}-backdrop'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.remove();
  });
  if (window.__zcodeSkin) window.__zcodeSkin.payload = null;
})();`;
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// 壁纸资产
// ---------------------------------------------------------------------------

function toDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif" }[ext];
  if (!mime) throw new Error(`不支持的图片格式: ${ext}（支持 png/jpg/webp/gif/bmp/avif）`);
  const size = fs.statSync(file).size;
  if (size > 20 * 1024 * 1024) throw new Error(`图片过大 (${(size / 1048576).toFixed(1)}MB)，请压缩到 20MB 以内`);
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// 启动器
// ---------------------------------------------------------------------------

function zcodeExeCandidates() {
  if (process.platform === "win32") {
    return [
      process.env.ZCODE_SKIN_EXE,
      "D:\\self\\install\\ZCode\\ZCode.exe",
      "C:\\Program Files\\ZCode\\ZCode.exe",
      path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode", "ZCode.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") return ["/Applications/ZCode.app/Contents/MacOS/ZCode"];
  return ["/usr/bin/zcode", "/opt/ZCode/zcode"];
}

function findZcodeExe() {
  return zcodeExeCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

async function isZcodeRunning() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/NH", "/FI", "IMAGENAME eq ZCode.exe"], { windowsHide: true });
      return stdout.toLowerCase().includes("zcode.exe");
    }
    const { stdout } = await execFileAsync("pgrep", ["-x", process.platform === "darwin" ? "ZCode" : "zcode"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function cdpUp(port) {
  try { await listTargets(port); return true; } catch { return false; }
}

/**
 * 启动带调试端口的 ZCode。若 CDP 已在线直接返回；若 ZCode 在跑但无端口，
 * 受 Electron 单实例锁限制，需用户先完全退出 ZCode（用 relaunch --yes）。
 */
async function launchZcode(port) {
  if (await cdpUp(port)) return { ok: true, reason: "already-running-with-cdp" };
  const exe = findZcodeExe();
  if (!exe) throw new Error("找不到 ZCode.exe；可用环境变量 ZCODE_SKIN_EXE 指定路径");
  if (await isZcodeRunning()) {
    return { ok: false, reason: "running-without-cdp" };
  }
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await cdpUp(port)) {
      // 等待窗口真正出现，注入才有目标
      let renderer = false;
      for (let j = 0; j < 30; j++) {
        if (pickRendererTargets(await listTargets(port)).length > 0) { renderer = true; break; }
        await sleep(500);
      }
      // 单实例锁竞态：第二个实例可能短暂绑定端口后退出，确认端口稳定在线
      await sleep(2000);
      if (!(await cdpUp(port))) {
        throw new Error("调试端口出现过但随即关闭——另一个 ZCode 实例通过单实例锁接管了。请完全退出 ZCode 后重试");
      }
      return { ok: true, reason: renderer ? "started" : "started-no-renderer-yet" };
    }
  }
  throw new Error("ZCode 已启动但调试端口未出现——可能有旧实例占用了单实例锁，请完全退出 ZCode 后重试");
}

/** 结束当前 ZCode 并以调试端口重启。必须由用户显式确认。 */
async function relaunchZcode(port) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/F", "/IM", "ZCode.exe"], { windowsHide: true }).catch(() => {});
  } else {
    await execFileAsync("pkill", ["-x", process.platform === "darwin" ? "ZCode" : "zcode"]).catch(() => {});
  }
  for (let i = 0; i < 20 && (await isZcodeRunning()); i++) await sleep(500);
  return launchZcode(port);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 应用 / 重置 / 常驻
// ---------------------------------------------------------------------------

async function injectAll(port, { css, wallpaperDataUri, fit }) {
  const targets = pickRendererTargets(await listTargets(port));
  if (targets.length === 0) throw new Error("未发现 ZCode 渲染进程目标");
  let n = 0;
  for (const t of targets) {
    try {
      const conn = await CdpConnection.connect(t.webSocketDebuggerUrl);
      await conn.send("Page.enable");
      await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: buildBootstrap({ css, wallpaperDataUri, fit }) });
      await conn.send("Runtime.evaluate", { expression: buildBootstrap({ css, wallpaperDataUri, fit }) });
      conn.close();
      n++;
    } catch (e) {
      console.warn(`  跳过 "${t.title}": ${e.message}`);
    }
  }
  return { injected: n, total: targets.length };
}

/** watch 守护：维持 CDP 会话并监视新窗口，主题随页面刷新/新窗口自动恢复。 */
async function watchDaemon(port) {
  const logFile = path.join(dataDir(), "watch.log");
  const log = (msg) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
  };
  const sessions = new Map(); // targetId -> { conn, payloadKey }

  async function sync() {
    let targets;
    try { targets = pickRendererTargets(await listTargets(port)); } catch { return; }
    const alive = new Set(targets.map((t) => t.id));
    for (const [id, s] of sessions) {
      if (!alive.has(id) || s.conn.closed) { s.conn.close(); sessions.delete(id); }
    }
    // 每轮重读配置：apply 换图/调参后无需重启 watch
    const payload = currentPayload();
    const bootstrap = buildBootstrap(payload);
    const payloadKey = JSON.stringify(payload);
    for (const t of targets) {
      const s = sessions.get(t.id);
      if (s && s.payloadKey === payloadKey && !s.conn.closed) {
        // 会话仍开着且内容没变；但页面可能整页刷新过，探测标记，丢了就重打
        try {
          const r = await s.conn.send("Runtime.evaluate", { expression: "!!window.__zcodeSkin", returnByValue: true });
          if (r?.result?.value === true) continue;
        } catch { /* fallthrough: re-inject */ }
      }
      try {
        let conn = s && !s.conn.closed ? s.conn : await CdpConnection.connect(t.webSocketDebuggerUrl);
        await conn.send("Page.enable");
        // 重复注册的脚本按注册顺序执行，后注册的后跑，天然覆盖旧的
        await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
        await conn.send("Runtime.evaluate", { expression: bootstrap });
        sessions.set(t.id, { conn, payloadKey });
        log(`injected: ${t.id} ${t.title}`);
      } catch (e) {
        log(`inject failed for ${t.id}: ${e.message}`);
      }
    }
  }

  log(`watch started (port ${port}), pid ${process.pid}`);
  await sync();
  const timer = setInterval(() => { sync().catch((e) => log(`sync error: ${e.message}`)); }, 3000);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
}

function currentPayload() {
  const cfg = { ...DEFAULTS, ...loadConfig() };
  let wallpaperDataUri;
  if (cfg.wallpaperPath && fs.existsSync(cfg.wallpaperPath)) wallpaperDataUri = toDataUri(cfg.wallpaperPath);
  return {
    css: buildCss(cfg),
    wallpaperDataUri,
    fit: cfg.fit,
  };
}

function pidFile() { return path.join(dataDir(), "watch.pid"); }

function readPid() {
  try { return Number(fs.readFileSync(pidFile(), "utf8").trim()); } catch { return null; }
}

async function stopWatch() {
  const pid = readPid();
  if (!pid) { console.log("watch 未在运行"); return; }
  try {
    process.kill(pid);
    fs.rmSync(pidFile(), { force: true });
    console.log(`已停止 watch (pid ${pid})`);
  } catch {
    fs.rmSync(pidFile(), { force: true });
    console.log(`pid ${pid} 已不存在，清理 pid 文件`);
  }
}

async function startWatchDetached(port) {
  const self = path.resolve(process.argv[1] ?? import.meta.url);
  const child = spawn(process.execPath, [self, "watch"], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, ZCODE_SKIN_DATA_DIR: dataDir() },
  });
  child.unref();
  // 由 watch 进程自己写 pid
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (readPid()) { console.log(`watch 已启动 (pid ${readPid()}, port ${port})`); return; }
  }
  console.error("watch 启动超时，请查看 " + path.join(dataDir(), "watch.log"));
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 快捷方式修复：给桌面/开始菜单/任务栏钉选的 ZCode.lnk 追加调试端口。
// ZCode 更新器会用不带参数的快捷方式覆盖开始菜单项，这是"重启后主题丢失"
// 的最常见根因，所以每次正常启动都要能带上 --remote-debugging-port。
// ---------------------------------------------------------------------------

const LNK_SCAN_DIRS =
  process.platform === "win32"
    ? [
        path.join(os.homedir(), "Desktop"),
        path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu"),
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu",
        path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
      ]
    : [];

async function repairLaunchers(port, check) {
  if (process.platform !== "win32") {
    console.error("repair-launchers 目前仅支持 Windows；其他平台请手动编辑 .desktop 启动项");
    process.exitCode = 1;
    return;
  }
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$save = ${check ? "0" : "1"}
$ws = New-Object -ComObject WScript.Shell
$dirs = @(${LNK_SCAN_DIRS.map((d) => `'${d.replace(/'/g, "''")}'`).join(",")})
$lnks = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Filter *.lnk -Recurse } }
foreach ($l in $lnks) {
  $s = $ws.CreateShortcut($l.FullName)
  if ($s.TargetPath -like '*ZCode.exe') {
    if ($s.Arguments -match 'remote-debugging-port') {
      Write-Output "SKIP\`t$($l.FullName)"
    } elseif ($save -eq 0) {
      Write-Output "WOULD\`t$($l.FullName)"
    } else {
      $s.Arguments = ($s.Arguments + ' --remote-debugging-port=${port}').Trim()
      $s.Save()
      Write-Output "PATCHED\`t$($l.FullName)"
    }
  }
}`;
  const psFile = path.join(dataDir(), "repair-launchers.ps1");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(psFile, ps);
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile],
    { windowsHide: true, timeout: 60000 }
  );
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.log("未发现指向 ZCode.exe 的快捷方式（可忽略：也能一直用 launch/relaunch 启动）");
    return;
  }
  const label = { PATCHED: "已加端口", SKIP: "已有端口", WOULD: "待加端口" };
  for (const line of lines) {
    const [state, file] = line.split("\t");
    console.log(`${label[state] ?? state}  ${file}`);
  }
  if (check) {
    console.log(`\n以上为预览（--check）。确认后运行 repair-launchers（不带 --check）实际写入。`);
  } else {
    console.log(`\n之后直接点快捷方式启动 ZCode 即自带调试端口 (port ${port})。`);
  }
}

// ---------------------------------------------------------------------------
// Windows 开机自启
// ---------------------------------------------------------------------------

function startupDir() {
  return path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

async function autostart(on) {
  if (process.platform !== "win32") {
    console.error("autostart 目前仅支持 Windows；其他平台请把 `node zcode-skin.mjs watch` 加入登录项");
    process.exitCode = 1;
    return;
  }
  const vbs = path.join(startupDir(), "zcode-skin-watch.vbs");
  if (!on) {
    fs.rmSync(vbs, { force: true });
    console.log("已移除开机自启");
    return;
  }
  const self = path.resolve(process.argv[1] ?? import.meta.url);
  // wscript 静默启动，避免控制台窗口闪烁
  const content = `Set sh = CreateObject("WScript.Shell")\nsh.Run "cmd /c node ""${self}"" watch", 0, False\n`;
  fs.writeFileSync(vbs, content);
  console.log(`已写入开机自启: ${vbs}`);
}

// ---------------------------------------------------------------------------
// 黑盒自测：起一个真实 Chromium 渲染进程（无头 Edge/Chrome，不碰正在运行的
// ZCode），跑完整的 watch→注入→刷新恢复→reset 链路并截屏，对标 codex 换肤
// 项目的"真机验证"质量门。
// ---------------------------------------------------------------------------

function findStandaloneBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["google-chrome", "microsoft-edge"];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const SELFTEST_PNG_1PX_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(everyMs);
  }
  throw lastErr ?? new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

async function evaluateOnPage(port, expression) {
  const targets = pickRendererTargets(await listTargets(port));
  const conn = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
  try {
    const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r?.exceptionDetails) {
      throw new Error(`页面内执行出错: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    }
    return r?.result?.value;
  } finally {
    conn.close();
  }
}

async function selftest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const browser = findStandaloneBrowser();
  if (!browser) {
    console.error("selftest 需要 Edge 或 Chrome 作为真实渲染进程，未找到");
    process.exitCode = 1;
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zskin-selftest-"));
  // 动态端口：避免上一次运行残留的 watch/浏览器实例抢占默认端口造成串扰
  const port = 9400 + (process.pid % 500);
  let edgeChild = null;
  let watchChild = null;
  let cfgDir = null;
  const dataDirBak = process.env.ZCODE_SKIN_DATA_DIR;
  try {
    // 准备测试页与 1x1 红色壁纸（CSS cover 拉伸铺满，便于截屏辨认）
    const html = path.join(tmp, "page.html");
    fs.writeFileSync(html, "<html><body style=\"font:32px sans-serif\"><h1>zcode-skin selftest</h1><p>content</p></body></html>");
    const wall = path.join(tmp, "wall.png");
    fs.writeFileSync(wall, Buffer.from(SELFTEST_PNG_1PX_RED, "base64"));
    cfgDir = path.join(tmp, "data");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port, blur: 4, dim: 30, fit: "cover", wallpaperPath: wall }));

    // 1. 启动无头 Chromium（与 ZCode 同为 Electron/Chromium 渲染管线）
    edgeChild = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, "profile")}`,
      `file:///${html.replace(/\\/g, "/")}`,
    ], { stdio: "ignore", windowsHide: true });
    await waitFor(async () => (await listTargets(port)).some((t) => t.type === "page"), 15000);
    check("无头 Chromium 启动且 CDP 可达", true, path.basename(browser));

    // 2. 启动 watch 守护（独立进程，同一注入路径）
    const self = path.resolve(process.argv[1]);
    watchChild = spawn(process.execPath, [self, "watch"], {
      stdio: "ignore", detached: true, windowsHide: true,
      env: { ...process.env, ZCODE_SKIN_DATA_DIR: cfgDir },
    });
    watchChild.unref();
    await waitFor(async () => (await evaluateOnPage(port, "!!window.__zcodeSkin")) === true, 15000);
    check("watch 守护完成注入（标记存在）", true);

    // 3. 注入内容黑盒断言：壁纸层/样式/透明化/幂等
    const probe = await evaluateOnPage(port, `(() => {
      const wp = document.getElementById('${MARKER}-wallpaper');
      const st = document.getElementById('${MARKER}-style');
      return {
        wallpaper: !!wp,
        bgImage: (wp?.style.backgroundImage || '').startsWith('url(') && (wp?.style.backgroundImage || '').includes('data:image/png'),
        css: (st?.textContent || '').includes('--color-background:transparent'),
        htmlTransparent: getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)',
        styleCount: document.querySelectorAll('#${MARKER}-style').length,
        wpCount: document.querySelectorAll('#${MARKER}-wallpaper').length,
      };
    })()`);
    check("壁纸层存在且背景为 data URI", probe.wallpaper && probe.bgImage);
    check("透明化 CSS 已生效 (--color-background)", probe.css);
    check("html 背景计算值透明", probe.htmlTransparent);
    check("幂等：style/壁纸层各只有一份", probe.styleCount === 1 && probe.wpCount === 1, `style=${probe.styleCount}, wp=${probe.wpCount}`);

    // 4. 重试注入（同 payload）→ 数量不变
    const payload = currentPayloadIn(cfgDir);
    const bootstrap = buildBootstrap(payload);
    {
      const targets = pickRendererTargets(await listTargets(port));
      const conn = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
      await conn.send("Runtime.evaluate", { expression: bootstrap });
      conn.close();
    }
    const afterReapply = await evaluateOnPage(port, `document.querySelectorAll('#${MARKER}-wallpaper').length`);
    check("重复注入不产生重复层", afterReapply === 1, `wp=${afterReapply}`);

    // 5. 整页刷新 → watch 应在 3s 轮询内恢复主题（addScriptToEvaluateOnNewDocument 随会话存活）
    {
      const targets = pickRendererTargets(await listTargets(port));
      const conn = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
      await conn.send("Page.enable");
      await conn.send("Page.reload");
      conn.close();
    }
    await waitFor(async () => (await evaluateOnPage(port, "!!window.__zcodeSkin")) === true, 12000);
    check("整页刷新后主题自动恢复", true);

    // 6. reset 脚本 → 全部移除
    {
      const targets = pickRendererTargets(await listTargets(port));
      const conn = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
      await conn.send("Runtime.evaluate", { expression: buildResetScript() });
      conn.close();
    }
    const afterReset = await evaluateOnPage(port, `!!document.getElementById('${MARKER}-wallpaper') || !!document.getElementById('${MARKER}-style')`);
    check("reset 移除全部注入", afterReset === false);

    // 7. 重新注入一次并截屏（视觉证据）
    {
      const targets = pickRendererTargets(await listTargets(port));
      const conn = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
      await conn.send("Runtime.evaluate", { expression: buildBootstrap(currentPayloadIn(cfgDir)) });
      const shot = await conn.send("Page.captureScreenshot", { format: "png" });
      const shotPath = path.join(dataDir(), "selftest.png");
      fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
      conn.close();
      check("截屏成功（视觉验证）", true, shotPath);
      const watchLog = fs.existsSync(path.join(cfgDir, "watch.log")) ? fs.readFileSync(path.join(cfgDir, "watch.log"), "utf8") : "";
      const watchPid = readPidIn(cfgDir);
      check("watch 日志与 pid 正常", watchLog.includes("injected") && !!watchPid, `pid=${watchPid}`);
    }
  } catch (e) {
    check("selftest 流程", false, e.message);
  } finally {
    // 清理：先停 watch（按测试数据目录的 pid），再关无头浏览器。
    // 只 kill 我们 spawn 的主进程，不用 taskkill /IM，避免误伤用户正开的浏览器。
    if (cfgDir) {
      const pid = readPidIn(cfgDir);
      if (pid) { try { process.kill(pid); } catch { /* ignore */ } }
    }
    try { watchChild?.kill(); } catch { /* ignore */ }
    try { edgeChild?.kill(); } catch { /* ignore */ }
    if (dataDirBak === undefined) delete process.env.ZCODE_SKIN_DATA_DIR;
    else process.env.ZCODE_SKIN_DATA_DIR = dataDirBak;
    await sleep(1000);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 文件句柄延迟，留给系统清理 */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

/** 在指定数据目录下构建当前 payload（selftest 用，等价于 watch 内的 currentPayload） */
function currentPayloadIn(dir) {
  const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) };
  const wallpaperDataUri = cfg.wallpaperPath && fs.existsSync(cfg.wallpaperPath) ? toDataUri(cfg.wallpaperPath) : undefined;
  return { css: buildCss(cfg), wallpaperDataUri, fit: cfg.fit };
}

function readPidIn(dir) {
  try { return Number(fs.readFileSync(path.join(dir, "watch.pid"), "utf8").trim()); } catch { return null; }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

async function resolveOpts(opts) {
  const stored = loadConfig();
  return {
    port: opts.port ? Number(opts.port) : stored.port ?? DEFAULTS.port,
    blur: opts.blur !== undefined ? clamp(opts.blur, 0, 30) : stored.blur ?? DEFAULTS.blur,
    dim: opts.dim !== undefined ? clamp(opts.dim, 0, 100) : stored.dim ?? DEFAULTS.dim,
    brighten: opts.brighten !== undefined ? clamp(opts.brighten, 0, 100) : stored.brighten ?? DEFAULTS.brighten,
    lightDim: opts["light-dim"] !== undefined ? clamp(opts["light-dim"], 0, 100) : stored.lightDim ?? DEFAULTS.lightDim,
    fit: ["cover", "contain"].includes(opts.fit) ? opts.fit : stored.fit ?? DEFAULTS.fit,
  };
}

async function ensureCdp(opts) {
  if (await cdpUp(opts.port)) return true;
  const r = await launchZcode(opts.port);
  if (r.ok) return true;
  if (r.reason === "running-without-cdp") {
    console.error("ZCode 正在运行但没有调试端口，无法注入。");
    console.error(`请完全退出 ZCode 后运行: node ${path.basename(process.argv[1])} relaunch --yes`);
  } else {
    console.error(`启动 ZCode 失败: ${r.reason}`);
  }
  process.exitCode = 1;
  return false;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const self = path.resolve(process.argv[1] ?? import.meta.url);

  switch (cmd) {
    case "apply": {
      const img = opts._[0];
      if (!img) { console.error("用法: apply <图片路径> [--blur N] [--dim N] [--brighten N] [--light-dim N] [--fit cover|contain]"); process.exitCode = 1; return; }
      const abs = path.resolve(img);
      if (!fs.existsSync(abs)) { console.error(`图片不存在: ${abs}`); process.exitCode = 1; return; }
      const o = await resolveOpts(opts);
      // 拷贝进数据目录，原图移动/删除不影响主题；路径先于注入保存——
      // 即使 ZCode 尚未带端口运行，下次启动 watch 也能直接用
      fs.mkdirSync(dataDir(), { recursive: true });
      const dest = path.join(dataDir(), "wallpaper" + path.extname(abs).toLowerCase());
      if (dest !== abs) fs.copyFileSync(abs, dest);
      saveConfig({ ...o, wallpaperPath: dest });
      if (!(await ensureCdp(o))) return;
      const payload = { css: buildCss(o), wallpaperDataUri: toDataUri(dest), fit: o.fit };
      const { injected, total } = await injectAll(o.port, payload);
      console.log(`已应用壁纸到 ${injected}/${total} 个窗口 (blur=${o.blur}, dim=${o.dim}, brighten=${o.brighten}, lightDim=${o.lightDim}, fit=${o.fit})`);
      if (injected > 0 && !readPid()) {
        console.log(`提示: 运行 \`node ${path.basename(self)} watch\` 可让主题在刷新/新窗口后保持`);
      }
      return;
    }
    case "adjust": {
      const o = await resolveOpts(opts);
      saveConfig(o);
      if (!(await cdpUp(o.port))) { console.log("配置已保存（ZCode 未运行，下次启动 watch/apply 时生效）"); return; }
      const { injected, total } = await injectAll(o.port, currentPayload());
      console.log(`已调整: blur=${o.blur}, dim=${o.dim}, brighten=${o.brighten}, lightDim=${o.lightDim}, fit=${o.fit} (${injected}/${total})`);
      return;
    }
    case "reset": {
      const o = await resolveOpts(opts);
      if (await cdpUp(o.port)) {
        const targets = pickRendererTargets(await listTargets(o.port));
        for (const t of targets) {
          try {
            const conn = await CdpConnection.connect(t.webSocketDebuggerUrl);
            await conn.send("Runtime.evaluate", { expression: buildResetScript() });
            conn.close();
          } catch { /* ignore */ }
        }
        console.log(`已从 ${targets.length} 个窗口移除主题`);
      } else {
        console.log("ZCode 未运行（无残留注入）");
      }
      saveConfig({ wallpaperPath: undefined });
      return;
    }
    case "launch": {
      const o = await resolveOpts(opts);
      const r = await launchZcode(o.port);
      console.log(r.ok ? `ZCode 已就绪 (${r.reason}, port ${o.port})` : `未启动: ${r.reason} — ZCode 正在无端口运行，请用 relaunch --yes`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "relaunch": {
      if (opts.yes !== true) {
        console.error("relaunch 会强制结束当前 ZCode 进程（未保存的会话内容会丢失）。确认请加 --yes");
        process.exitCode = 1;
        return;
      }
      const o = await resolveOpts(opts);
      const r = await relaunchZcode(o.port);
      console.log(r.ok ? `ZCode 已带调试端口重启 (port ${o.port})` : `重启失败: ${r.reason}`);
      if (r.ok) {
        // 给渲染进程一点时间，然后恢复主题
        await sleep(2000);
        if (loadConfig().wallpaperPath) {
          const { injected } = await injectAll(o.port, currentPayload());
          console.log(`主题已恢复到 ${injected} 个窗口`);
        }
      }
      return;
    }
    case "watch": {
      if (opts.stop) { await stopWatch(); return; }
      if (readPid()) { console.log(`watch 已在运行 (pid ${readPid()})`); return; }
      if (opts.detach) { await startWatchDetached((await resolveOpts(opts)).port); return; }
      const o = await resolveOpts(opts);
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(pidFile(), String(process.pid));
      await watchDaemon(o.port);
      return;
    }
    case "autostart": {
      await autostart(opts.off !== true);
      return;
    }
    case "repair-launchers": {
      const o = await resolveOpts(opts);
      await repairLaunchers(o.port, opts.check === true);
      return;
    }
    case "status": {
      const cfg = { ...DEFAULTS, ...loadConfig() };
      console.log(`配置: port=${cfg.port} blur=${cfg.blur} dim=${cfg.dim} brighten=${cfg.brighten} lightDim=${cfg.lightDim} fit=${cfg.fit}`);
      console.log(`壁纸: ${cfg.wallpaperPath ?? "(未设置)"}`);
      console.log(`watch: ${readPid() ? `运行中 (pid ${readPid()})` : "未运行"}`);
      const up = await cdpUp(cfg.port);
      if (up) {
        console.log(`CDP: 在线 (port ${cfg.port})`);
        const ts = pickRendererTargets(await listTargets(cfg.port));
        console.log(`渲染窗口: ${ts.length} 个`);
        for (const t of ts) console.log(`  - ${t.title} (${t.url.slice(0, 60)})`);
      } else if (await isZcodeRunning()) {
        console.log(`CDP: 离线 — ZCode 正在运行但没有调试端口（常见于更新器重建快捷方式之后）。`);
        console.log(`  修复：运行 repair-launchers 给快捷方式补端口后重启 ZCode；`);
        console.log(`  或完全退出 ZCode 后 relaunch --yes。`);
      } else {
        console.log(`CDP: 离线 — ZCode 未运行。apply 会自动以调试端口启动它。`);
      }
      return;
    }
    case "selftest": {
      await selftest();
      return;
    }
    case "print-css": {
      const o = await resolveOpts(opts);
      console.log(buildCss(o));
      return;
    }
    default:
      console.log(`zcode-skin — ZCode 桌面端壁纸工具
用法: node zcode-skin.mjs <命令>
  apply <图片> [--blur N] [--dim N] [--brighten N] [--light-dim N] [--fit ...]  应用壁纸（dim 仅暗色，brighten/light-dim 仅浅色）
  adjust [--blur N] [--dim N] [--brighten N] [--light-dim N] [--fit ...]    只调参数
  reset                                                      移除主题
  launch | relaunch --yes | watch [--stop] | autostart [--off]
  repair-launchers                                           快捷方式补调试端口
  selftest                                                   无头浏览器黑盒自测
  status`);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`错误: ${e.message}`);
    process.exitCode = 1;
  });
}
