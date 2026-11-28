#!/usr/bin/env node
/**
 * 番茄小说发布 Web 工具 —— 零第三方依赖的本地服务。
 *
 * 用法：node web/server.mjs   →   http://127.0.0.1:8790
 *
 * 功能：Token 状态/刷新、书籍列表、建书、按 articlewriter 约定从书目录加载章节、批量发布章节、章节核验。
 * 鉴权与请求格式与 src/tomato/client.ts 完全一致（Cookie + X-Secsdk-Csrf-Token，
 * GET 走 query / POST 走 x-www-form-urlencoded，公共参数 aid=2503&app_name=muye_novel）。
 * .env 每次请求都重新读取，刷新 Token 后立即生效。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// 打包成单文件 exe 时（web/build/entry.mjs）__APP_ROOT__ 被设为 exe 所在目录，.env 等数据文件放 exe 旁边；
// 直接 node 跑源码时保持原行为（.env 在仓库根目录）
const ROOT = globalThis.__APP_ROOT__ ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
// 番茄接口调用诊断日志（打包版没有控制台，出错时靠这个文件排查）：与 .env 同目录
const LOG_FILE = path.join(ROOT, "app.log");
function logApp(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* 日志写不进去不影响功能 */ }
  console.log(line);
}

// 前端状态记忆（上次使用的书目录等），JSON：{ bookDir }
const STATE_FILE = path.join(ROOT, "web-state.json");
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}
const BASE = "https://fanqienovel.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const COMMON = { aid: "2503", app_name: "muye_novel" };
const PORT = Number(process.env.PORT || 8790);

// ---------- .env 读写（值可能含分号，必须按第一个 = 切分） ----------

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

function saveEnvKey(key, value) {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const line = `${key}=${value}`;
  const next = text.replace(new RegExp(`^${key}=.*$`, "m"), line);
  if (next !== text) {
    fs.writeFileSync(ENV_FILE, next);
    return;
  }
  // 键不存在则追加到文件末尾
  const prefix = text && !text.endsWith("\n") ? text + "\n" : text;
  fs.writeFileSync(ENV_FILE, prefix + line + "\n");
}

function removeEnvKey(key) {
  if (!fs.existsSync(ENV_FILE)) return;
  const text = fs.readFileSync(ENV_FILE, "utf8");
  fs.writeFileSync(ENV_FILE, text.replace(new RegExp(`^${key}=.*\\n?`, "m"), ""));
}

function saveCsrfToken(token) {
  saveEnvKey("TOMATO_CSRF_TOKEN", token);
}

// ---------- 番茄接口客户端（与 src/tomato/client.ts 一致） ----------

class TomatoApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function auth() {
  const env = loadEnv();
  if (!env.TOMATO_COOKIE) throw new TomatoApiError(-1, ".env 缺少 TOMATO_COOKIE");
  if (!env.TOMATO_CSRF_TOKEN) throw new TomatoApiError(-1, ".env 缺少 TOMATO_CSRF_TOKEN");
  return env;
}

// 供 Electron 注入登录会话用（已登录启动时把 .env 的 Cookie 补进内嵌页会话）
globalThis.__GET_COOKIE__ = () => loadEnv().TOMATO_COOKIE ?? "";

function headers(env, extra = {}) {
  return {
    Cookie: env.TOMATO_COOKIE,
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Origin: BASE,
    Referer: `${BASE}/main/writer/`,
    "X-Secsdk-Csrf-Token": env.TOMATO_CSRF_TOKEN,
    ...extra,
  };
}

async function parse(res, pathName) {
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new TomatoApiError(res.status, `返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (j.code !== 0) {
    const msg = j.message || j.msg || "未知错误";
    const hint = /登录|登陆|csrf|权限|未授权|token/i.test(msg)
      ? "（鉴权可能失效，请先刷新 Token）"
      : "";
    logApp(`[api-err] ${pathName} code=${j.code} msg=${msg} data=${JSON.stringify(j.data ?? null)}`);
    throw new TomatoApiError(j.code, `${msg}${hint}（番茄 code=${j.code}，详情见 ${LOG_FILE}）`);
  }
  return j.data;
}

async function apiGet(p, params = {}) {
  const env = auth();
  const qs = new URLSearchParams({ ...COMMON, ...flat(params) }).toString();
  const res = await fetch(`${BASE}${p}?${qs}`, { headers: headers(env) });
  return parse(res, p);
}

// 参数走 query 的 POST（番茄卷接口只认这种：实测 add_volume / modify/v0 传 JSON body 一律 code=-2 参数有误）
async function apiPostQuery(p, params = {}) {
  const env = auth();
  const qs = new URLSearchParams({ ...COMMON, ...flat(params) }).toString();
  const res = await fetch(`${BASE}${p}?${qs}`, { method: "POST", headers: headers(env) });
  return parse(res, p);
}

async function apiPost(p, params = {}) {
  const env = auth();
  const body = new URLSearchParams({ ...COMMON, ...flat(params) }).toString();
  const res = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: headers(env, { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }),
    body,
  });
  return parse(res, p);
}

function flat(p) {
  const r = {};
  for (const k of Object.keys(p)) r[k] = String(p[k]);
  return r;
}

// ---------- CSRF Token 刷新（与 refresh-token.sh 同原理） ----------

// 用指定 Cookie 向番茄申请 CSRF Token（不写 .env；签发成功即证明 Cookie 有效）
async function issueCsrf(cookie) {
  const res = await fetch(
    `${BASE}/api/author/book/book_list/v0?aid=2503&app_name=muye_novel`,
    {
      method: "HEAD",
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        Referer: `${BASE}/main/writer/`,
        "x-secsdk-csrf-request": "1",
        "x-secsdk-csrf-version": "1.2.22",
      },
    },
  );
  const line = res.headers.get("x-ware-csrf-token");
  if (!line) throw new Error("响应里没有 x-ware-csrf-token 头——Cookie 可能已失效，请重新抓取");
  const [code, token, maxAge, , session] = line.split(",");
  if (code !== "0" || !token) throw new Error(`服务端拒绝签发 Token（code=${code}）——Cookie 可能已失效`);
  return { token, hours: Math.round(Number(maxAge) / 3600000), session: `${session ?? ""}`.slice(0, 8) };
}

async function refreshCsrf() {
  const env = loadEnv();
  if (!env.TOMATO_COOKIE) throw new Error(".env 缺少 TOMATO_COOKIE");
  const r = await issueCsrf(env.TOMATO_COOKIE);
  saveCsrfToken(r.token);
  logApp(`[token] CSRF Token 已刷新（有效期约 ${r.hours}h）`); // 只记状态，不记 Token 内容
  return { ok: true, hours: r.hours }; // 不把 Token 片段返回给界面/日志
}

// ---------- 番茄登录（弹系统 Chrome 窗口扫码，自动收 Cookie + 签发 Token） ----------
// iframe 嵌不了番茄登录页（跨域读不到 Cookie），所以本地起一个真实浏览器窗口：
// 用户扫码 → 页面跳回 writer 主域 → 从浏览器提取 fanqienovel.com 域 Cookie
// → issueCsrf 试签发（成功即证明登录有效）→ 写 .env → 关浏览器。

// 自动探测浏览器：CHROME_PATH 环境变量优先，否则按平台找常见安装路径（Windows 上 Edge 一般预装）
function browserCandidates() {
  if (process.platform === "win32") {
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(Boolean);
    const list = [];
    for (const p of pf) list.push(path.join(p, "Google", "Chrome", "Application", "chrome.exe"));
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
    for (const p of pf) list.push(path.join(p, "Microsoft", "Edge", "Application", "msedge.exe"));
    return list;
  }
  if (process.platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
}
function findBrowser() {
  const envPath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  return browserCandidates().find((p) => p && fs.existsSync(p)) ?? null;
}

const LOGIN_URL = `${BASE}/main/writer/`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let login = { phase: "idle", message: "", result: null, error: null, diag: null }; // idle | waiting | saving | done | error
let loginDriver = null; // 当前登录驱动（puppeteer 外部浏览器 / Electron 应用内窗口）
let loginTimer = null;
let loginChecking = false;

function stopLoginTimer() {
  if (loginTimer) clearInterval(loginTimer);
  loginTimer = null;
}

function removeUserDataDir(dir) {
  // Chrome 退出瞬间可能仍在写 profile，rmSync 会撞 ENOTEMPTY/EBUSY；
  // 隔 500ms 重试几次，仍失败就留到 /tmp 由系统清理（绝不能让异常抛出）
  const attempt = (left) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      if (left > 0) setTimeout(() => attempt(left - 1), 500).unref?.();
    }
  };
  attempt(6);
}

function cleanupLogin() {
  stopLoginTimer();
  const d = loginDriver;
  loginDriver = null;
  if (d) try { d.close(); } catch { /* 收尾异常不外抛 */ }
}

function finishLogin(result, error) {
  cleanupLogin();
  login = result
    ? { phase: "done", message: "登录成功，Cookie 与 Token 已写入 .env", result, error: null }
    : { phase: "error", message: "", result: null, error: error || "登录失败" };
}

// 登录驱动接口：open(登录页URL) / alive() / currentUrl() / cookies()→Cookie串或null / close()
// 默认实现：puppeteer-core 驱动外部 Chrome/Edge（控制台版用）；
// Electron 版通过 globalThis.__LOGIN_DRIVER__ 注入应用内窗口驱动，登录不出应用窗口。
function createPuppeteerDriver() {
  let browser = null;
  let page = null;
  let userDataDir = null;
  return {
    async open(loginUrl) {
      const chrome = findBrowser();
      if (!chrome)
        throw new TomatoApiError(-1, "找不到 Chrome/Edge：请安装其一，或设置环境变量 CHROME_PATH 指向浏览器可执行文件");
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tomato-login-"));
      try {
        browser = await puppeteer.launch({
          executablePath: chrome,
          headless: false,
          userDataDir,
          args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,820"],
        });
      } catch (e) {
        this.close();
        throw new TomatoApiError(-1, `浏览器启动失败：${e.message}`);
      }
      page = await browser.newPage();
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    },
    alive: () => Boolean(browser && browser.connected),
    currentUrl: () => {
      try {
        return page ? page.url() : null;
      } catch {
        return null;
      }
    },
    async cookies() {
      if (!browser) return null;
      const cs = await browser.cookies(BASE);
      return cs.length ? cs.map((c) => `${c.name}=${c.value}`).join("; ") : null;
    },
    close() {
      if (browser) browser.close().catch(() => {});
      browser = null;
      page = null;
      if (userDataDir) {
        removeUserDataDir(userDataDir);
        userDataDir = null;
      }
    },
  };
}

async function startLogin() {
  if (login.phase === "waiting" || login.phase === "saving")
    throw new TomatoApiError(-2, "已有登录流程在进行中");
  const driver = globalThis.__LOGIN_DRIVER__ ? globalThis.__LOGIN_DRIVER__() : createPuppeteerDriver();
  await driver.open(LOGIN_URL); // 驱动内部错误自行带 TomatoApiError 语义抛出
  loginDriver = driver;
  login = { phase: "waiting", message: "登录窗口已打开，请扫码登录…", result: null, error: null, diag: null };

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  loginTimer = setInterval(async () => {
    try {
      if (loginChecking || login.phase !== "waiting") return;
      if (!driver.alive()) {
        finishLogin(null, "登录窗口已关闭，登录取消");
        return;
      }
      if (Date.now() > deadline) {
        finishLogin(null, "等待扫码超时（5 分钟），请重试");
        return;
      }
      const url = await driver.currentUrl();
      // SSO 跳转期间 URL 不在主域，不探测；回到 writer 主域后才开始验证
      if (!url || !url.startsWith(BASE)) {
        login.diag = `当前登录页地址：${url || "未知"}（尚未回到番茄主域）`;
        return;
      }
      const cookieStr = await driver.cookies();
      if (!cookieStr) return;
      // 关键判定：必须出现会话 Cookie sessionid / sessionid_ss（匿名访问只有 ttwid/serial_uuid
      // 等跟踪 Cookie；且实测 issueCsrf 对匿名会话也签发 Token，不能拿「签发成功」当登录依据）
      if (!/sessionid(_ss)?=/.test(cookieStr)) {
        // 诊断：只报 Cookie 数量与是否拿到登录会话，不列出 Cookie 名/值
        login.diag = `登录页已加载，会话 Cookie ${cookieStr.split(";").length} 个（还没拿到登录会话，请继续扫码）`;
        return;
      }
      loginChecking = true;
      try {
        // 试签发 CSRF Token：成功即证明 Cookie 是有效登录态（先验证、后写盘）
        const r = await issueCsrf(cookieStr);
        try {
          saveEnvKey("TOMATO_COOKIE", cookieStr);
          saveCsrfToken(r.token);
        } catch (e2) {
          // 写盘失败必须明说，否则界面上永远「等待扫码」、Cookie 永远缺失
          finishLogin(null, `登录成功，但写入 .env 失败（路径 ${ENV_FILE}）：${e2.message}`);
          return;
        }
        finishLogin({
          ok: true,
          hours: r.hours,
          cookies: cookieStr.split("; ").length, // 只报数量，Cookie / Token 内容不进界面与日志
        });
      } catch (e) {
        // 签发失败常见于登录跳转链中 Cookie 尚未写全；记录诊断并继续重试，界面可见
        login.diag = `已检测到登录 Cookie，但 Token 签发失败（重试中）：${e.message}`;
        console.log(`[login] ${login.diag}`);
      } finally {
        loginChecking = false;
      }
    } catch (e) {
      // 轮询里的任何意外都不应拖垮服务；窗口没了就按取消收尾
      if (login.phase === "waiting" || login.phase === "saving")
        finishLogin(null, `登录流程异常：${e.message}`);
    }
  }, 2500);
}

function cancelLogin() {
  if (login.phase !== "waiting" && login.phase !== "saving")
    throw new TomatoApiError(-2, "当前没有进行中的登录流程");
  finishLogin(null, "已手动取消登录");
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanupLogin();
    process.exit(0);
  });
}

// ---------- 按 articlewriter 约定扫描书籍目录 ----------
// 结构：<书名>/第NN章-<标题>/NN-<标题>.md（正文）＋ NN-<标题>-大纲/场景/人物/人物关系/信息/摘要.md（辅助）
// 有卷模式时章节目录位于 <书名>/<卷名>/ 下；「引言」为保留目录，跳过。
// 正文文件回退顺序：NN-<标题>.md → 第NN章-<标题>.md → 章节.md → 非辅助后缀的任意 .md
// 平铺结构（无章节目录时自动启用）：<书名>/01.md、02-标题.txt、第3章 标题.md……一文件一章，
// 序号与标题优先取文件名，取不到再看正文首行（第X章 标题，支持中文数字），再不行按排序续号。

const AUX_SUFFIXES = ["-大纲", "-场景", "-人物", "-人物关系", "-信息", "-摘要"];
// 不是正文的文档：卷.md 这类配置文件 + 带辅助后缀的笔记（大纲/场景/人物…），平铺与浏览都要排除
const AUX_DOC_NAMES = /^(卷|目录|简介|封面|书名)$/i;
const isAuxDoc = (name) => {
  const base = name.replace(/\.(md|txt|docx|doc)$/i, "");
  return AUX_DOC_NAMES.test(base) || AUX_SUFFIXES.some((s) => base.endsWith(s));
};
const CHAPTER_DIR_RE = /^第(\d+)章-(.+)$/;
// 正文文件：md/txt 直读；.docx 自己解 zip 读（见 readNovelText）；旧版 .doc 只报错不静默跳过
const FLAT_FILE_RE = /\.(md|txt|docx)$/i;
const NOVEL_FILE_RE = /\.(md|txt|docx)$/i;
const DOC_LEGACY_RE = /\.doc$/i;
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
const CN_NUM_RE = /^([0-9]+|[零一二三四五六七八九十百两]+)$/;
// 「第N章/第N回」前缀 + 剩余标题
const DI_TITLE_RE = /^第\s*([0-9零一二三四五六七八九十百两]+)\s*[章回]\s*[·:：\-—.、\s　]*(.*)$/;
// 「N章/N节/N回 标题」不带「第」字的写法（01卷-03章-标题 这种平铺命名很常见）
const CHAPTER_BARE_RE = /^([0-9]{1,4}|[零一二三四五六七八九十百两]+)\s*[章节回]\s*[·:：\-—.、\s　]*(.*)$/;
// 「N」或「N-标题 / N.标题 / N 标题」开头带阿拉伯数字
const NUM_TITLE_RE = /^([0-9]{1,4})\s*[.:：、\-—\s　]*(.*)$/;

function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二三四五六七八九十百两]+$/.test(s)) return NaN;
  let total = 0;
  let num = 0;
  for (const ch of s) {
    if (ch === "十") { total += (num || 1) * 10; num = 0; }
    else if (ch === "百") { total += (num || 1) * 100; num = 0; }
    else if (CN_DIGITS[ch] !== undefined) num = CN_DIGITS[ch];
    else return NaN;
  }
  return total + (num || 0);
}

function stripChapterPrefix(title) {
  return String(title || "")
    .replace(DI_TITLE_RE, (_, _n, rest) => rest)
    .replace(CHAPTER_BARE_RE, (_, _n, rest) => rest)
    .trim();
}

// 章节标题的「去序号」形态（第N章/N节 前缀都剥掉 + 去空白）：
// 本地与番茄章节对齐用 —— 卷模式下发布标题会按全书连续编号，去掉序号后仍能对上番茄上已有的旧标题
const CHAPTER_NUM_PREFIX_RE = /^第?\s*[0-9零一二三四五六七八九十百两]+\s*[章节回]\s*[·:：\-—.、\s　]*/;
const chapterCore = (t) => String(t ?? "").replace(CHAPTER_NUM_PREFIX_RE, "").replace(/\s+/g, "");

function firstMeaningfulLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^#+\s*/, "").replace(/^\*+\s*/, "").trim();
    if (t) return t;
  }
  return "";
}

// ---------- 正文文件读取：md/txt 直读，.docx 自解（零依赖：手解 zip + zlib） ----------
function zipEntries(buf) {
  // 从「中央目录结尾记录」(EOCD) 倒查，再按中央目录项拿到每个文件在 zip 里的位置
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/docx 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const entry = {
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      localOff: buf.readUInt32LE(off + 42),
      name: buf.toString("utf8", off + 46, off + 46 + buf.readUInt16LE(off + 28)),
    };
    out.push(entry);
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return out;
}

function zipExtract(buf, entry) {
  const lh = entry.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`zip 局部头损坏：${entry.name}`);
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip 压缩方式 ${entry.method} 不支持：${entry.name}`);
}

const XML_ENTS = { "&lt;": "<", "&gt;": ">", "&quot": '"', "&apos": "'", "&nbsp": " ", "&amp;": "&" };
const decodeXml = (s) =>
  s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos|amp);?/g, (m) => XML_ENTS[m] ?? m);

// docx 的 document.xml → 纯文本：段落之间空行分隔（番茄按空行分段），段内换行保留
function docxToText(xml) {
  const bodyStart = xml.indexOf("<w:body");
  const bodyEnd = xml.indexOf("</w:body>");
  let s = bodyStart >= 0 ? xml.slice(xml.indexOf(">", bodyStart) + 1, bodyEnd > 0 ? bodyEnd : xml.length) : xml;
  s = s
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<w:(br|cr)[^>]*\/>/g, "\n")
    .replace(/<\/w:p\s*>/g, "\n\n") // 段落边界 → 空行（mdToHtml 按空行分段）
    .replace(/<[^>]+>/g, ""); // 其余标签一律去掉（正文都在 <w:t> 里，内容里的 < > 是实体不会误伤）
  return decodeXml(s)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readDocxText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd0) {
    throw new TomatoApiError(-1, `${path.basename(file)} 是加密的 .docx，读不了；请在 Word 里取消密码后另存`);
  }
  const entries = zipEntries(buf);
  const main = entries.find((e) => e.name === "word/document.xml");
  if (!main) throw new TomatoApiError(-1, `${path.basename(file)} 里没有 word/document.xml（不是有效的 .docx）`);
  return docxToText(zipExtract(buf, main).toString("utf8"));
}

// 读正文（md/txt/docx）；旧版 .doc 明确报错（OLE 二进制解析成本高，让用户另存为 .docx）
function readNovelText(file) {
  if (DOC_LEGACY_RE.test(file))
    throw new TomatoApiError(-1, `${path.basename(file)} 是旧版 .doc 格式，读不了：请在 Word 里「另存为 → .docx」`);
  if (/\.docx$/i.test(file)) {
    try {
      return readDocxText(file);
    } catch (e) {
      if (e instanceof TomatoApiError) throw e;
      throw new TomatoApiError(-1, `读取 .docx 失败：${path.basename(file)}（${e.message}）`);
    }
  }
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

// 加载过程中的提醒（旧版 .doc、被跳过的内容等），随 /api/book-chapters 一起回给界面
let loadWarnings = [];
const warnLoad = (m) => { if (!loadWarnings.includes(m)) loadWarnings.push(m); };

// 平铺文件名里的「卷」前缀（兼容多种命名，全部可选；解析后卷名仍可被 卷.md 的声明覆盖）
const VOL_NUM = "[0-9]{1,4}|[零一二三四五六七八九十百两]+";
const VOL_SEPS = "[\\s\\-_—.、，·＋+]*";
// 「卷」后面不能直接跟汉字数字/常用字，否则「一卷」会吞掉「第二卷…」、
// 「卷王的诞生」会被当成卷 —— 序号后面必须紧跟分隔符或结束才认
const NOT_CN = "(?![零一二三四五六七八九十百两])";
const NOT_HAN = "(?![零一二三四五六七八九十百两王宗哥儿子女风草叶)])";
const VOL_PATTERNS = [
  new RegExp(`^第\\s*(${VOL_NUM})\\s*卷${NOT_CN}${VOL_SEPS}([\\s\\S]*)$`), // 第1卷- / 第一卷：
  new RegExp(`^卷\\s*(${VOL_NUM})${VOL_SEPS}([\\s\\S]*)$`), // 卷1- / 卷一
  new RegExp(`^([0-9]{1,4})\\s*卷${NOT_HAN}${VOL_SEPS}([\\s\\S]*)$`), // 01卷- / 1卷 第一章（仅阿拉伯数字，避免「一卷」）
  new RegExp(`^[Vv][Oo][Ll]\\.?\\s*[\\s\\-_—.、，·＋+]*([0-9]{1,4})[\\s\\-_—.、，·＋+]*([\\s\\S]*)$`), // Vol.1- / VOL 1_ / Vol.2第一章
  new RegExp(`^[Vv]\\.?\\s*([0-9]{1,4})[\\s\\-_—.、，·＋+]+([\\s\\S]*)$`), // V1- / v2_（V 后必须跟序号+分隔符，避免误伤标题）
];
// 「卷号-章号」纯数字两段（如 01-03-标题）：两段都算序号，第一段当卷、第二段当章
// 卷号限 1~2 位，避免把「2020-03」这类日期/编号文件名误判成卷
const VOL_NUM_PAIR_RE = /^([0-9]{1,2})\s*[\-_—.、，·\s]+([0-9]{1,4})(?=[\s\-_—.、，·]|$)([\s\S]*)$/;
const VOL_SEPS_RE = /^[\s\-_—.、，·＋+]/; // 卷标记与后面内容之间的分隔符（单个字符判断用）
const VOL_SEPS_RE_G = /^[\s\-_—.、，·＋+]+/g;
// 书根/书稿下常见但不是卷的目录（平铺模式找卷子目录时跳过）
const AUX_DIR_NAMES = ["案头资料", "文档", "笔记", "素材", "设定", "大纲", "归档", "引言", "导出", "备份"];

// 平铺模式：目录下直接放章节文件（md/txt/docx），一文件一章；可带卷前缀（01卷-03章-标题 等）
// 卷来源（都兼容，优先级从高到低）：① 文件名里的卷标记 ② 卷.md 声明的卷名作前缀 ③ 文件名「卷号-章号」两段数字 ④ 卷子目录
function listFlatChapters(bookDir) {
  const entryFiles = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && FLAT_FILE_RE.test(e.name) && !e.name.startsWith(".") && !isAuxDoc(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  const warnLegacyDocs = (dir) => {
    try {
      const legacy = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && DOC_LEGACY_RE.test(e.name))
        .map((e) => e.name);
      if (legacy.length)
        warnLoad(`${dir} 里有 ${legacy.length} 个旧版 .doc（${legacy.slice(0, 3).join("、")}${legacy.length > 3 ? "…" : ""}），读不了：请在 Word 里另存为 .docx`);
    } catch { /* ignore */ }
  };
  warnLegacyDocs(bookDir);
  const files = entryFiles(bookDir).map((n) => ({ file: n, dirVol: null }));
  // 顶层没有章节文件时，把子目录当卷（卷名 = 目录名），目录里放平铺章节
  if (!files.length) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(bookDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
    } catch { /* ignore */ }
    for (const d of dirs) {
      if (AUX_DIR_NAMES.some((x) => d.name === x || d.name.startsWith(x))) continue;
      const innerDir = path.join(bookDir, d.name);
      // 里面是「第NN章-*」章节目录 → 属于嵌套结构，交给上面的嵌套扫描，平铺不重复收
      try {
        if (fs.readdirSync(innerDir, { withFileTypes: true }).some((e) => e.isDirectory() && CHAPTER_DIR_RE.test(e.name))) continue;
      } catch { /* ignore */ }
      const inner = entryFiles(innerDir);
      warnLegacyDocs(innerDir);
      if (!inner.length) continue;
      for (const n of inner) files.push({ file: n, dirVol: d.name });
    }
  }
  if (!files.length) return [];
  // 卷.md（书根或上一级）声明的卷：名称/顺序用来给「第N卷」取名与排序
  const mdVolumes = readVolumeMd(bookDir).volumes;
  const declaredByOrder = new Map(mdVolumes.map((v) => [v.order, v.name]));
  const declaredByName = new Map(mdVolumes.map((v) => [v.name, v]));
  const declaredNames = [...declaredByName.keys()].sort((a, b) => b.length - a.length);
  files.sort((a, b) => (a.dirVol ?? "").localeCompare(b.dirVol ?? "", "zh") || a.file.localeCompare(b.file, "zh", { numeric: true, sensitivity: "base" })); // 自然序：2 < 10
  const out = [];
  const lastNumByVol = new Map(); // 各卷独立续号（卷内章号从 1 起算）
  for (const { file: name, dirVol } of files) {
    const base0 = name.replace(FLAT_FILE_RE, "");
    let volNum = null; // 文件名里解析出的卷号
    let volName = dirVol; // 卷名（卷.md 声明的名字优先）
    let base = base0;
    // ① 卷标记
    for (const re of VOL_PATTERNS) {
      const m = base.match(re);
      if (!m) continue;
      const n = cnToNum(m[1]);
      if (Number.isNaN(n)) continue;
      volNum = n;
      base = m[2].trim();
      break;
    }
    // ② 卷.md 里的卷名直接作前缀（新生-第3章 xxx / 新生/第3章 xxx）
    if (volNum === null && !volName) {
      const hit = declaredNames.find((n2) => base === n2 || (base.startsWith(n2) && VOL_SEPS_RE.test(base[n2.length])));
      if (hit) {
        volName = hit;
        volNum = mdVolumes.find((v) => v.name === hit)?.order ?? null;
        base = base.slice(hit.length).replace(VOL_SEPS_RE_G, "");
      }
    }
    // ③ 「卷号-章号」两段数字（01-03-标题）
    let num = null;
    let title = null;
    if (volNum === null && !volName) {
      const pair = base.match(VOL_NUM_PAIR_RE);
      if (pair) {
        volNum = Number(pair[1]);
        base = pair[3].replace(VOL_SEPS_RE_G, "").trim(); // 去掉卷号-章号后面的分隔符
        title = null;
        num = Number(pair[2]); // 先把第二段当章号（卷-章 已定），后面文件名解析若能给出标题就用它
      }
    }
    let m = base.match(DI_TITLE_RE) || base.match(CHAPTER_BARE_RE) || base.match(NUM_TITLE_RE);
    if (m) {
      const n = cnToNum(m[1]);
      if (!Number.isNaN(n)) { num = n; title = m[2].trim(); }
    }
    let content = readNovelText(path.join(bookDir, name));
    content = content.replace(/^#\s.*\n/, "").replace(/^\n+|\n+$/g, ""); // 去首部 H1
    // 文件名给不全序号/标题 → 看正文首行（如「第一章 初入江湖」）
    if (num === null || !title) {
      const cm = firstMeaningfulLine(content).match(DI_TITLE_RE);
      if (cm) {
        const n = cnToNum(cm[1]);
        if (!Number.isNaN(n)) {
          if (num === null) num = n;
          if (!title) title = cm[2].trim();
        }
      }
    }
    const key = volName ?? (volNum !== null ? `#${volNum}` : "");
    const numFromName = num !== null;
    if (num === null) num = (lastNumByVol.get(key) ?? 0) + 1; // 纯标题文件名：按排序位置在该卷内续号
    // 剥掉标题自带的「第N章」前缀，避免发布标题重复章节号
    title = stripChapterPrefix(title);
    // 文件名没给出标题 → 去掉序号/章节号后剩下的那段就是章节名（两段数字命名常见）
    if (!title) {
      const rest = stripChapterPrefix(base);
      if (rest && rest !== String(num)) title = rest;
    }
    // 完全没有序号（纯标题文件名）时，文件名本身就是章节名
    if (!title && !numFromName) title = base.trim();
    lastNumByVol.set(key, num);
    // 卷名：卷.md 声明的名字 > 目录名/文件名里的卷名 > 「第N卷」
    const finalVol = volName ?? (volNum !== null ? (declaredByOrder.get(volNum) ?? `第${volNum}卷`) : null);
    out.push({
      num,
      title,
      vol: finalVol,
      volNum,
      file: dirVol ? `${dirVol}/${name}` : name,
      wordCount: content.replace(/\s/g, "").length,
      content,
    });
  }
  // 有卷：按「卷的顺序（卷.md 顺序 / 卷号）→ 卷内章号」排；无卷：仍按章节序号排（原行为）
  const volOrder = new Map();
  if (out.some((c) => c.vol)) {
    mdVolumes.forEach((v, i) => volOrder.set(v.name, i + 1));
    let extra = mdVolumes.length;
    for (const c of out) {
      if (c.vol && !volOrder.has(c.vol)) volOrder.set(c.vol, ++extra);
    }
    out.sort(
      (a, b) =>
        (a.vol ? 1 : 0) - (b.vol ? 1 : 0) ||
        (volOrder.get(a.vol) ?? 0) - (volOrder.get(b.vol) ?? 0) ||
        (a.vol ?? "").localeCompare(b.vol ?? "", "zh") ||
        a.num - b.num
    );
  } else {
    // 按解析出的章节序号排序（稳定：同号文件保持文件名自然序）。
    // 否则「第N章/第N回」命名或序号在正文里的文件会按文件名落在中文区，顺序错乱
    out.sort((a, b) => a.num - b.num);
  }
  // 番茄的 chapter_index 是全书连续的（卷只是分组），所以有卷时发布标题按全书顺序连续编号，
  // 否则两个卷都有「第1章」会在番茄端看起来乱序；无卷时保持文件里的序号不变
  const renumber = volOrder.size > 0;
  return out.map((c, i) => ({
    index: i + 1,
    ...c,
    publishNum: renumber ? i + 1 : c.num,
    publishTitle: c.title
      ? `第${renumber ? i + 1 : c.num}章 ${c.title}`
      : `第${renumber ? i + 1 : c.num}章`,
  }));
}

// ---------- 本地卷（卷.md）规则：与写书计划里「小说 → 卷 → 章节」的约定对齐 ----------
// 真实书里 卷.md 有两种写法，都要认：
//   ## vol_1 / - 名称：新生 / - 顺序：1 / - 描述：…      （神念换天、听潮人）
//   ## 旱魃除灾 / - 名称：旱魃除灾 / - 顺序：1            （八仙剧本：标题即卷名）
// 模板自带的 <!-- … --> 说明里有「## 卷ID | 名称 | 描述」示例行，先剥注释再解析，示例也不算卷。
function readVolumeMd(bookDir) {
  // 传进来的可能是单个文档（整本一个文件）→ 卷.md 在它所在目录/上一级
  let dir = bookDir;
  try {
    if (fs.statSync(bookDir).isFile()) dir = path.dirname(bookDir);
  } catch { /* 路径不存在时按原样拼路径 */ }
  // 卷.md 在书根，而章节常在 书根/书稿/ 下：两个位置都找
  for (const p of [path.join(dir, "卷.md"), path.join(path.dirname(dir), "卷.md")]) {
    if (!fs.existsSync(p)) continue;
    let txt;
    try {
      txt = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
    } catch {
      continue;
    }
    const volumes = [];
    for (const block of txt.split(/\r?\n(?=##\s)/)) {
      const hm = block.match(/^##\s+(.+?)\s*$/m);
      if (!hm) continue;
      const f = {};
      for (const fm of block.matchAll(/^\s*[-*]\s*(名称|顺序|描述)\s*[:：]\s*(.*)$/gm)) f[fm[1]] = fm[2].trim();
      const name = f["名称"] || hm[1].trim();
      if (!name || name.includes("|")) continue;
      const order = Number(f["顺序"]);
      volumes.push({ id: hm[1].trim(), name, order: Number.isFinite(order) ? order : volumes.length + 1, desc: f["描述"] ?? "" });
    }
    volumes.sort((a, b) => a.order - b.order);
    return { file: p, volumes };
  }
  return { file: null, volumes: [] };
}

// 本地卷清单 = 卷.md 声明的卷 ∪ 实际扫到的卷目录（卷.md 顺序优先，未声明的排在后面）
function localVolumesOf(bookDir, chapters) {
  const md = readVolumeMd(bookDir);
  const byName = new Map();
  md.volumes.forEach((v) => byName.set(v.name, { name: v.name, order: v.order, declared: true, count: 0 }));
  for (const c of chapters) {
    if (!c.vol) continue;
    if (!byName.has(c.vol)) byName.set(c.vol, { name: c.vol, order: md.volumes.length + byName.size + 1, declared: false, count: 0 });
    byName.get(c.vol).count++;
  }
  return [...byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh"));
}

// ---------- 番茄端的卷：读取 / 与本地卷对照 / 建卷 ----------
// 实测规则（chunk 逆向 + 真实账号只读探测，另见 AGENTS.md）：
// - 章节挂在书上（平铺表），每章带 volume_id / volume_name，卷只是分组容器
// - volume_list/v1 返回**倒序**（新卷在前），官方 UI 拿到后 .reverse() → 这里统一按显示顺序（第 1 卷在前）返回
// - 没有「移动章节 / 改章节顺序」的接口 → 章节只能追加，chapter_index 由番茄按发布顺序跨卷连续分配
// - add_volume / modify/v0 的参数只能走 query（实测传 JSON body 一律 code=-2 参数有误）
// - 建卷限制：code=-4054「暂不支持创建多个无章节的分卷」→ 新卷只能紧邻它的第一章发布前创建
async function fetchRemoteVolumeRaw(bookId) {
  const data = await apiGet("/api/author/volume/volume_list/v1", { book_id: bookId });
  return Array.isArray(data) ? data : (data?.volume_list ?? []);
}

async function fetchRemoteVolumes(bookId) {
  return (await fetchRemoteVolumeRaw(bookId)).slice().reverse(); // 显示顺序
}

const volNameOf = (v) => String(v?.volume_name ?? "").trim();

// 章节列表：接口单页上限 100，自动翻页拉全量（满页才继续，最多 50 页兜底）
async function fetchChapters(bookId, volumeId = "") {
  const items = [];
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const data = await apiGet("/api/author/chapter/chapter_list/v1", {
      book_id: bookId,
      volume_id: volumeId,
      page_index: pageIndex,
      page_count: 100,
      status: 0,
      must_have_correction_feedback: 0,
      need_correction_feedback_num: 1,
      sort: "",
    });
    const list = Array.isArray(data) ? data : (data?.item_list ?? []);
    items.push(...list);
    if (list.length < 100) break; // 不满一页 = 已取完
  }
  return items;
}

// 全书章节：逐卷取（实测 volume_id 传空不等于「全部卷」，逐卷取最稳），并补上 volume_id / volume_name
async function fetchAllChapters(bookId) {
  const vols = await fetchRemoteVolumes(bookId);
  if (!vols.length) return fetchChapters(bookId, "");
  const out = [];
  for (const v of vols) {
    const id = String(v.volume_id);
    for (const it of await fetchChapters(bookId, id)) {
      if (!it.volume_id) it.volume_id = id;
      if (!it.volume_name) it.volume_name = volNameOf(v);
      out.push(it);
    }
  }
  return out;
}

// 本地卷名 → 番茄卷的对照（规则）：
// 1) 同名直接复用；2) 没同名的本地卷按位置认领番茄里未被认领的卷，并把番茄卷**改名成本地卷名**；
// 3) 还多出来的本地卷 → add_volume 新建（dryRun 只报告不建：番茄不允许同时存在多个无章节的空卷）
async function syncVolumes(bookId, names, { dryRun = false } = {}) {
  const raw = await fetchRemoteVolumeRaw(bookId); // 番茄原序（新卷在前）
  const display = raw.slice().reverse(); // 显示顺序（第 1 卷在前）
  const wanted = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const taken = new Set();
  const matched = new Map(); // 本地卷名 → { volume_id, volume_name, action }
  for (const n of wanted) {
    const hit = display.find((v) => !taken.has(String(v.volume_id)) && volNameOf(v) === n);
    if (hit) {
      taken.add(String(hit.volume_id));
      matched.set(n, { volume_id: String(hit.volume_id), volume_name: volNameOf(hit), action: "复用同名卷" });
    }
  }
  const free = display.filter((v) => !taken.has(String(v.volume_id)));
  const toCreate = [];
  for (const n of wanted) {
    if (matched.has(n)) continue;
    const v = free.shift(); // 按位置认领：本地第 i 卷 ↔ 番茄第 i 卷
    if (v) {
      taken.add(String(v.volume_id));
      matched.set(n, { volume_id: String(v.volume_id), volume_name: volNameOf(v), action: `改名 → ${n}` });
    } else toCreate.push(n);
  }

  const actions = [];
  const renames = [...matched].filter(([, v]) => v.action !== "复用同名卷");
  if (renames.length) {
    if (dryRun) {
      for (const [n, v] of renames) actions.push(`将把番茄卷「${v.volume_name}」(${v.volume_id}) 改名为「${n}」`);
    } else {
      // modify/v0 要整卷列表（volume_data = 番茄**原序**，与官方 UI reverse 后一致），只改名字、不动 volume_id
      const nameById = new Map(renames.map(([n, v]) => [String(v.volume_id), n]));
      const vd = raw.map((v) => ({
        volume_id: String(v.volume_id),
        volume_name: nameById.get(String(v.volume_id)) ?? volNameOf(v),
      }));
      await apiPostQuery("/api/author/volume/modify/v0", { book_id: bookId, volume_data: JSON.stringify(vd) });
      for (const [n, v] of renames) {
        matched.set(n, { volume_id: v.volume_id, volume_name: n, action: `已改名「${v.volume_name}」→「${n}」` });
        actions.push(`已把番茄卷「${v.volume_name}」改名为「${n}」`);
      }
    }
  }

  for (const n of toCreate) {
    if (dryRun) actions.push(`番茄上没有可认领的卷：「${n}」将在发布该卷第一章前新建`);
    else actions.push(`番茄上没有可认领的卷：「${n}」将在发布该卷第一章前新建（番茄不许同时存在多个空卷）`);
    // 不在这里建：番茄 code=-4054 不让同时存在多个无章节的分卷，必须等该卷要发第一章时再建
    matched.set(n, { volume_id: "", volume_name: n, action: "待新建", pending: true });
  }

  const map = new Map();
  for (const n of wanted) map.set(n, matched.get(n));
  return { map, actions, volumes: wanted.map((n) => ({ local: n, ...matched.get(n) })) };
}

// 懒建卷：发布某卷的第一章前调用（add_volume 只认 query 参数）
async function ensureRemoteVolume(bookId, name) {
  let createdId = "";
  try {
    const data = await apiPostQuery("/api/author/volume/add_volume/v0", { book_id: bookId, volume_name: name });
    createdId = String(data?.volume_id ?? "");
  } catch (e) {
    if (e.code === -4054)
      throw new TomatoApiError(-4054, `番茄不允许同时存在多个无章节的分卷，建卷「${name}」失败：先把前一卷的章节发出去（或删除空卷）`);
    throw e;
  }
  if (!createdId) {
    const again = await fetchRemoteVolumes(bookId); // 接口没回 volume_id → 回查列表按名字找
    createdId = String(again.find((v) => volNameOf(v) === name)?.volume_id ?? "");
  }
  if (!createdId) throw new TomatoApiError(-1, `新建卷「${name}」失败：番茄没返回 volume_id`);
  logApp(`[volumes] 已新建卷「${name}」(volume_id=${createdId})`);
  return createdId;
}

// ---------- 单文档模式：所有章节都在一个文件里（txt / md / docx），从文档里拆出章节 ----------
// 章节标题行（只有「整行就是标题」的短行才算，正文里出现的「第3章」字样不会误判）
const DOC_HEAD_WORD_RE = /^(楔子|序章|序言|引子|前言|后记|尾声|终章|番外篇|番外)(?:[ 　.．、:：·\-—–]+[^。．,，;；!！?？\s]{0,20})?$/;
const DOC_HEAD_MAX = 40;

function docHeading(line) {
  // md 写法（## 第1章 标题）先剥掉标记，纯文本行原样
  const t = String(line).trim().replace(/^#+\s*/, "").replace(/^[*\-–—]{1,3}\s+(?=\S)/, "").trim();
  if (!t || t.length > DOC_HEAD_MAX) return null;
  let m = t.match(/^第\s*([0-9零一二三四五六七八九十百两]+)\s*([章回节卷])([\s\S]*)$/);
  if (m) {
    // 序号+章/卷后面必须是行尾或分隔符，否则是正文句子（「第一章正文第一段。」不算标题）
    if (m[3] && !/^[ 　.．、:：·\-—–]/.test(m[3])) return null;
    const n = cnToNum(m[1]);
    if (Number.isNaN(n)) return null;
    return { kind: m[2] === "卷" ? "vol" : "chap", num: n, title: m[3].trim() };
  }
  m = t.match(/^([0-9]{1,4}|[零一二三四五六七八九十百两]+)\s*[章回节]([ \t.．、:：·\-—–]+[\s\S]*|)$/);
  if (m) {
    const n = cnToNum(m[1]);
    if (Number.isNaN(n)) return null;
    return { kind: "chap", num: n, title: m[2].trim() };
  }
  m = t.match(DOC_HEAD_WORD_RE);
  // 「楔子」这种独占一行（或后面只跟个短名）才算章；「楔子正文，足够长的一段…」是正文，不能当标题
  if (m) return { kind: "chap", num: null, title: [m[1], (m[2] ?? "").trim()].filter(Boolean).join(" ") };
  return null;
}

// 整本一个文件 → 章节列表。文档里的「第N卷」标记决定其后章节属于哪一卷，
// 卷名优先用同目录 卷.md 声明的名字；章号缺失时按出现顺序在该卷内续号
function listSingleDocChapters(file) {
  const label = path.basename(file).replace(/\.(docx|txt|md)$/i, "");
  let text;
  try {
    text = readNovelText(file).replace(/\r/g, "");
  } catch (e) {
    if (e instanceof TomatoApiError) throw e;
    throw new TomatoApiError(-1, `读取文档失败：${file}（${e.message}）`);
  }
  const declaredByOrder = new Map(readVolumeMd(file).volumes.map((v) => [v.order, v.name]));
  const lines = text.split("\n");
  // 去首尾空白、行尾空格、孤立页码行（txt/docx 粘贴常见），并压掉多余空行
  const clean = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/^\d{1,4}[ 　]*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const out = [];
  const pre = [];
  let cur = null;
  let vol = null;
  const flush = () => {
    if (!cur) return;
    let body = clean(cur.lines.join("\n"));
    let title = cur.title;
    if (!title) {
      const head = body.split("\n")[0].trim(); // 「第1章」单独一行、标题在下一行的写法
      if (head && head.length <= 24 && body.includes("\n")) {
        title = head;
        body = body.split("\n").slice(1).join("\n").trim();
      }
    }
    if (body) out.push({ num: cur.num, title: stripChapterPrefix(title), vol: cur.vol, file: `${label}#${out.length + 1}`, content: body });
    cur = null;
  };
  for (const raw of lines) {
    const h = docHeading(raw);
    if (h && h.kind === "vol") {
      flush();
      vol = declaredByOrder.get(h.num) ?? (h.title || `第${h.num}卷`);
      continue;
    }
    if (h && h.kind === "chap") {
      flush();
      cur = { num: h.num, title: h.title, vol, lines: [] };
      continue;
    }
    (cur ? cur.lines : pre).push(raw);
  }
  flush();
  if (!out.length) {
    const body = clean(lines.join("\n"));
    if (!body) throw new TomatoApiError(-1, `文档里没有正文：${file}`);
    warnLoad("文档里没找到「第N章 标题」这样的章节行，整篇作为一个章节");
    out.push({ num: 1, title: label, vol, file: `${label}#1`, content: body });
  }
  const preBody = clean(pre.join("\n"));
  if (preBody && out.length > 1) {
    if (preBody.length >= 200) {
      out.unshift({ num: null, title: "前言", vol: out[0].vol, file: `${label}#前言`, content: preBody });
      warnLoad(`文档开头有 ${preBody.length} 字不属于任何章节，已作为「前言」章节`);
    } else {
      warnLoad(`文档开头 ${preBody.length} 字（书名/简介之类）没有章节标题，已忽略`);
    }
  }
  const lastNum = new Map(); // 卷内章号续号（各卷独立）
  for (const c of out) {
    const key = c.vol ?? "";
    if (c.num === null) c.num = (lastNum.get(key) ?? 0) + 1;
    lastNum.set(key, Math.max(lastNum.get(key) ?? 0, c.num));
  }
  // 有卷 → 发布标题按全书顺序连续编号（番茄 chapter_index 跨卷连续）；无卷 → 用文档里的章号
  const renumber = out.some((c) => c.vol);
  return out.map((c, i) => ({
    index: i + 1,
    ...c,
    volNum: null,
    wordCount: c.content.replace(/\s/g, "").length,
    publishNum: renumber ? i + 1 : c.num,
    publishTitle: c.title ? `第${renumber ? i + 1 : c.num}章 ${c.title}` : `第${renumber ? i + 1 : c.num}章`,
  }));
}

function listBookChapters(bookDir) {
  loadWarnings = [];
  let st = null;
  try {
    st = fs.statSync(bookDir);
  } catch { /* 不存在 */ }
  if (st?.isFile()) return listSingleDocChapters(bookDir); // 直接给了一个文档 → 单文档模式
  if (!st?.isDirectory()) throw new TomatoApiError(-1, `书目录不存在：${bookDir}`);
  // 无「第NN章-*」章节目录时自动尝试平铺结构
  let topEntries = [];
  try {
    topEntries = fs.readdirSync(bookDir, { withFileTypes: true });
  } catch { /* ignore */ }
  if (!topEntries.some((e) => e.isDirectory() && CHAPTER_DIR_RE.test(e.name))) {
    const flat = listFlatChapters(bookDir);
    if (flat.length) return flat;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const found = [];
  const scan = (dir, vol) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const m = ent.name.match(CHAPTER_DIR_RE);
      if (m) {
        const num = Number(m[1]);
        const title = m[2];
        const folder = path.join(dir, ent.name);
        const files = fs.readdirSync(folder).filter((f) => NOVEL_FILE_RE.test(f));
        const file =
          files.find((f) => f === `${pad(num)}-${title}.md`) ??
          files.find((f) => f === `第${pad(num)}章-${title}.md`) ??
          files.find((f) => f === "章节.md") ??
          files.find((f) => !AUX_SUFFIXES.some((s) => f.endsWith(`${s}.md`))) ??
          files.find((f) => NOVEL_FILE_RE.test(f) && !AUX_SUFFIXES.some((s) => f.endsWith(`${s}.docx`)));
        if (!file) {
          if (fs.readdirSync(folder).some((f) => DOC_LEGACY_RE.test(f)))
            warnLoad(`${ent.name}/ 里只有旧版 .doc，读不了（请在 Word 里另存为 .docx）`);
          continue; // 没有正文文件的章节目录，跳过
        }
        let content = readNovelText(path.join(folder, file));
        content = content.replace(/^#\s.*\n/, "").replace(/^\n+|\n+$/g, ""); // 去首部 H1
        found.push({
          num,
          title,
          vol: vol || null,
          file: path.relative(bookDir, path.join(folder, file)),
          wordCount: content.replace(/\s/g, "").length,
          content,
        });
      } else if (!vol && ent.name !== "引言") {
        scan(path.join(dir, ent.name), ent.name); // 卷实体目录（只下钻一层）
      }
    }
  };
  scan(bookDir, null);
  // 顺序规则（用户定的）：书根章节 → 各卷按 卷.md 的「顺序」 → 卷内按章号
  const volRank = new Map(readVolumeMd(bookDir).volumes.map((v, i) => [v.name, i + 1]));
  const rank = (vol) => (vol ? (volRank.get(vol) ?? volRank.size + 1) : 0);
  found.sort(
    (a, b) =>
      (a.vol ? 1 : 0) - (b.vol ? 1 : 0) ||
      rank(a.vol) - rank(b.vol) ||
      (a.vol ?? "").localeCompare(b.vol ?? "", "zh") ||
      a.num - b.num
  );
  // 有卷时发布标题按全书顺序连续编号（番茄的 chapter_index 就是跨卷连续的，
  // 两卷都有「第1章」在番茄端会看起来乱序）；无卷时保持目录里的序号（原行为）
  const renumber = found.some((c) => c.vol);
  return found.map((c, i) => ({
    index: i + 1,
    ...c,
    publishNum: renumber ? i + 1 : c.num,
    publishTitle: `第${renumber ? i + 1 : c.num}章 ${c.title}`, // 番茄风格：阿拉伯数字
  }));
}

function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

// 发布前风险检查（官网 UI「内容检测方式」同一端点）：POST /app/book/pre_audit_article/v0/
// pre_audit_type：1=基础检测（不限次数）、0=全面检测（每章节限 2 次）；返回 risk_texts 列表
async function preAudit(itemId, html, type) {
  const data = await apiPost("/app/book/pre_audit_article/v0/", {
    item_id: itemId,
    content: html,
    pre_audit_type: type,
  });
  const r = data?.pre_audit_result ?? {};
  const risks = Array.isArray(r.risk_texts) ? r.risk_texts.filter((x) => x && x.text) : [];
  return { risks };
}

// ---------- HTTP 路由 ----------

function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TomatoApiError(-2, "请求体不是合法 JSON");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // 静态页面
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(globalThis.__INDEX_HTML__ ?? fs.readFileSync(path.join(__dirname(), "index.html")));
      return;
    }

    switch (`${req.method} ${url.pathname}`) {
      // Token / Cookie 状态 + 建书额度预检
      case "GET /api/status": {
        const env = loadEnv();
        let check = null;
        try {
          check = await apiGet("/app/book/check_frequency/v0/");
        } catch (e) {
          check = { error: e.message };
        }
        json(res, 200, {
          cookieOk: Boolean(env.TOMATO_COOKIE),
          // 只报状态，不回 Cookie / Token 的任何片段（界面与日志里都不出现凭证内容）
          tokenOk: Boolean(env.TOMATO_CSRF_TOKEN),
          appMode: globalThis.__LOGIN_DRIVER__ ? "app" : "console", // 应用内窗口版 / 控制台+外部浏览器版
          check,
        });
        return;
      }

      case "POST /api/refresh-token": {
        json(res, 200, await refreshCsrf());
        return;
      }

      // 退出登录：清除 .env 里的 Cookie/Token 与登录会话 Cookie（内嵌页由前端重新加载为未登录登录页）
      case "POST /api/logout": {
        if (login.phase === "waiting" || login.phase === "saving") finishLogin(null, "已取消登录");
        removeEnvKey("TOMATO_COOKIE");
        removeEnvKey("TOMATO_CSRF_TOKEN");
        try {
          globalThis.__ON_LOGOUT__?.();
        } catch { /* 清会话失败不影响退出主流程 */ }
        json(res, 200, { ok: true });
        return;
      }

      // 已登录时：界面内嵌页直接显示番茄作家后台首页（不清 Cookie；会话缺登录 Cookie 时从 .env 注入）
      case "POST /api/home/show": {
        const body = await readBody(req);
        const id = Number(body.webContentsId);
        if (!id) throw new TomatoApiError(-2, "缺少 webContentsId");
        if (!globalThis.__ON_HOME_SHOW__) throw new TomatoApiError(-2, "当前运行模式不支持内嵌首页");
        await globalThis.__ON_HOME_SHOW__(id);
        json(res, 200, { ok: true });
        return;
      }

      // 应用内登录（Electron）：前端内嵌 webview 附加后上报其 webContents id，
      // 登录流程直接驱动这个内嵌页（不再有独立登录窗口）
      case "POST /api/login/attach": {
        const body = await readBody(req);
        const id = Number(body.webContentsId);
        if (!id) throw new TomatoApiError(-2, "缺少 webContentsId");
        if (!globalThis.__ON_LOGIN_ATTACH__) throw new TomatoApiError(-2, "当前运行模式不支持应用内登录");
        globalThis.__ON_LOGIN_ATTACH__(id);
        json(res, 200, { attached: true });
        return;
      }

      // 番茄登录：弹系统 Chrome 窗口扫码，完成后自动收 Cookie + 签发 Token 写 .env
      case "POST /api/login/start": {
        await startLogin();
        json(res, 200, login);
        return;
      }

      case "GET /api/login/status": {
        json(res, 200, login);
        return;
      }

      case "POST /api/login/cancel": {
        cancelLogin();
        json(res, 200, login);
        return;
      }

      case "GET /api/novels": {
        const data = await apiGet("/api/author/book/book_list/v0", { page_index: 0, page_count: 50 });
        const list = Array.isArray(data) ? data : data?.book_list ?? data?.list ?? [];
        json(res, 200, list);
        return;
      }

      // 删除书籍（逆向自番茄前端 BookManage chunk）：POST /api/author/book/delete/v0, book_id。
      // 番茄规则：签约中/已签约不可删（签约评估通过 21 天后不签约可删）。列表条目自带 can_delete/is_signing，
      // 这里服务端再校验一次防绕过；字段缺失（接口演进）时不拦，由番茄端返回错误兜底。
      case "POST /api/book/delete": {
        const body = await readBody(req);
        const bookId = String(body.book_id || "");
        if (!bookId) throw new TomatoApiError(-2, "缺少 book_id");
        const listData = await apiGet("/api/author/book/book_list/v0", { page_index: 0, page_count: 50 });
        const list = Array.isArray(listData) ? listData : listData?.book_list ?? listData?.list ?? [];
        const book = list.find((b) => String(b.book_id) === bookId);
        if (!book) throw new TomatoApiError(-1, "账号下未找到该书籍（可能已被删除，请刷新列表）");
        if (book.is_signing) throw new TomatoApiError(-1, "作品签约中暂不支持删除（签约评估通过 21 天后不签约可删除）");
        if (book.can_delete === false) throw new TomatoApiError(-1, "该书籍当前不可删除（已签约或不满足删除条件）");
        const data = await apiPost("/api/author/book/delete/v0", { book_id: bookId });
        json(res, 200, { book_id: bookId, book_name: book.book_name ?? "", data });
        return;
      }

      // 建书分类字典（番茄前端 CATEGORY_LIST）：GET /api/author/book/category_list/v0/?gender=0|1
      // 返回平铺列表，label 字段即分组：主分类 / 主题 / 角色 / 情节。这里按 label 分组返回，前端渲染下拉框。
      case "GET /api/categories": {
        const gender = url.searchParams.get("gender") || "0";
        const data = await apiGet("/api/author/book/category_list/v0/", { gender });
        const list = Array.isArray(data) ? data : data?.list ?? data?.category_list ?? [];
        const order = [];
        const byLabel = new Map();
        for (const c of list) {
          const label = String(c.label ?? "其他");
          if (!byLabel.has(label)) {
            byLabel.set(label, []);
            order.push(label);
          }
          byLabel.get(label).push({
            category_id: String(c.category_id),
            name: c.name ?? "",
            description: c.description ?? "",
          });
        }
        json(res, 200, { gender, groups: order.map((label) => ({ label, items: byLabel.get(label) })) });
        return;
      }

      // 诊断日志尾部：界面里点「查看诊断日志」用（打包版没有控制台，靠这个看番茄返回了什么）
      case "GET /api/log": {
        let text = "";
        try {
          const buf = fs.readFileSync(LOG_FILE, "utf8");
          text = buf.length > 6000 ? buf.slice(-6000) : buf;
        } catch {
          text = "（还没有日志：暂时没有接口出过错）";
        }
        json(res, 200, { file: LOG_FILE, text });
        return;
      }

      // 记住书目录：前端改变书目录时上报，下次打开页面回填
      case "GET /api/book-dir": {
        json(res, 200, { dir: loadState().bookDir ?? null });
        return;
      }
      case "POST /api/book-dir": {
        const body = await readBody(req);
        const dir = String(body.dir ?? "").trim();
        if (!dir) throw new TomatoApiError(-1, "dir 不能为空");
        json(res, 200, saveState({ bookDir: dir }));
        return;
      }

      case "POST /api/book/create": {
        const body = await readBody(req);
        // 主要角色：界面/命令行传「、」或逗号分隔的名字也行，这里统一转成番茄要用的 JSON 数组字符串
        const rolesRaw = String(body.roles ?? "").trim();
        if (rolesRaw && !rolesRaw.startsWith("[")) {
          body.roles = JSON.stringify(rolesRaw.split(/[、,，;；/\n]+/).map((s) => s.trim()).filter(Boolean));
        }
        // 封面：界面上不填封面，但番茄这个字段不能省——官方建书提交处（chunk 8034.266c0c9a.js）
        // 三级兜底后必定带 thumb_uri：上传图 → 模板图 → 官方默认封面 novel-static/7107d91219967759d105674fa8393923。
        // 我们之前省略该字段，番茄就回「参数有误」。之后要换封面去番茄后台改。
        // 想用别的默认图：.env 配 TOMATO_DEFAULT_THUMB=novel-xxx/yyy
        const DEFAULT_THUMB = "novel-static/7107d91219967759d105674fa8393923";
        const env = loadEnv();
        const thumb = String(body.thumb_uri ?? "").trim();
        body.thumb_uri = thumb || String(env.TOMATO_DEFAULT_THUMB ?? "").trim() || DEFAULT_THUMB;
        if (!String(body.is_self_pic ?? "").trim()) body.is_self_pic = "0";
        // activity_id / label_list 界面上已不显示，按官方默认值补上（官方：activity_id=0、label_list=""）
        if (body.activity_id === undefined) body.activity_id = "0";
        if (body.label_list === undefined) body.label_list = "";
        logApp(`[create] 提交番茄 book_name=${body.book_name} gender=${body.gender} category=${body.category} sign_pattern=${body.sign_pattern} thumb_uri=${body.thumb_uri} roles=${body.roles ?? ""} 简介=${[...String(body.abstract ?? "")].length}字`);
        let data;
        try {
          data = await apiPost("/api/author/book/create/v0/", body);
        } catch (e) {
          logApp(`[create] 失败：${e.message} 参数=${JSON.stringify(body)}`);
          throw e;
        }
        logApp(`[create] 成功 book_id=${data?.book_id}`);
        json(res, 200, { book_id: String(data.book_id), data });
        return;
      }

      // 文件夹浏览：列子目录并标记「书目录」（含 .articlewriter-meta.json 或 第NN章-* 章节目录）
      // 不指定路径时从用户主目录开始浏览（不设默认书目录，由用户点选）
      case "GET /api/browse": {
        let p = path.resolve(url.searchParams.get("path") || os.homedir());
        let fromFile = false;
        try {
          if (fs.statSync(p).isFile()) {
            p = path.dirname(p); // 当前值是文档（单文档模式）→ 列它所在目录
            fromFile = true;
          }
        } catch { /* 不存在则下面报错 */ }
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory())
          throw new TomatoApiError(-1, `目录不存在：${p}`);
        const isBookDir = (dir) => {
          try {
            const sub = fs.readdirSync(dir, { withFileTypes: true });
            return (
              sub.some((s) => s.isFile() && s.name === ".articlewriter-meta.json") ||
              sub.some((s) => s.isDirectory() && CHAPTER_DIR_RE.test(s.name)) ||
              sub.some((s) => s.isFile() && FLAT_FILE_RE.test(s.name)) // 平铺结构：直接放章节文件
            );
          } catch {
            return false;
          }
        };
        let entries = [];
        try {
          entries = fs
            .readdirSync(p, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => ({ name: e.name, isBook: isBookDir(path.join(p, e.name)) }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh"));
        } catch {
          /* 无权限则空列表 */
        }
        // 可点的文档：单文档模式（整本一个文件）或平铺的章节文件，直接点文件名即可加载
        // 卷.md、大纲/设定这类辅助文件不算「可点的正文文档」
        let files = [];
        try {
          files = fs
            .readdirSync(p, { withFileTypes: true })
            .filter(
              (e) =>
                e.isFile() && !e.name.startsWith(".") && !isAuxDoc(e.name) && (NOVEL_FILE_RE.test(e.name) || DOC_LEGACY_RE.test(e.name))
            )
            .map((e) => ({ name: e.name, legacy: DOC_LEGACY_RE.test(e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh"));
        } catch {
          /* 无权限则空列表 */
        }
        // Windows：列出可用磁盘（C:\、D:\…），供界面一键切换盘符；到盘根时 parent 置空
        const drives =
          process.platform === "win32"
            ? Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + ":\\").filter((d) => {
                try {
                  return fs.existsSync(d);
                } catch {
                  return false; // 光驱无盘/异常盘符不影响浏览
                }
              })
            : [];
        let parent = path.dirname(p);
        if (parent === p) parent = null; // 已到盘根（C:\ 的 dirname 还是 C:\）
        json(res, 200, { path: p, parent, drives, isBook: isBookDir(p), from_file: fromFile, dirs: entries, files });
        return;
      }

      // 从本地加载章节：书目录（articlewriter 嵌套 / 平铺一文件一章）或单个文档（整本一个文件，按「第N章」拆章）
      // 顺带给出本地卷清单与加载提醒（旧版 .doc、被忽略的开头等）
      case "GET /api/book-chapters": {
        const p = url.searchParams.get("path");
        if (!p) throw new TomatoApiError(-2, "请先指定书目录或文档（第 4 步输入路径或点「浏览」选择）");
        const chapters = listBookChapters(p);
        const md = readVolumeMd(p);
        let singleDoc = false;
        try {
          singleDoc = fs.statSync(p).isFile();
        } catch { /* 不存在时 listBookChapters 已经报过错 */ }
        json(res, 200, {
          path: p,
          single_doc: singleDoc,
          chapters,
          volumes: localVolumesOf(p, chapters),
          volume_md: md.file,
          warnings: loadWarnings,
        });
        return;
      }

      // 番茄卷列表：统一按显示顺序（第 1 卷在前；接口本身是倒序）
      case "GET /api/volumes": {
        const bookId = url.searchParams.get("book_id") || "";
        if (!bookId) throw new TomatoApiError(-2, "请先指定 book_id");
        const volumes = await fetchRemoteVolumes(bookId);
        json(res, 200, {
          volumes: volumes.map((v) => ({
            volume_id: String(v.volume_id ?? ""),
            volume_name: volNameOf(v),
            item_count: Number(v.item_count ?? 0),
            can_delete: Boolean(v.can_delete),
          })),
        });
        return;
      }

      // 卷对照：本地卷名 → 番茄卷（dry_run=1 只出计划，不改番茄端；否则改名 / 认领）
      case "POST /api/volumes/sync": {
        const body = await readBody(req);
        const bookId = String(body.book_id || "");
        const names = Array.isArray(body.volume_names) ? body.volume_names : [];
        if (!bookId) throw new TomatoApiError(-2, "缺少 book_id");
        if (!names.length) throw new TomatoApiError(-2, "没有本地卷可对照（书目录里没有卷.md，也没有卷目录）");
        const r = await syncVolumes(bookId, names, { dryRun: Boolean(body.dry_run) });
        logApp(`[volumes] ${body.dry_run ? "预检" : "同步"} 本地卷=${names.join(",")} → ${r.volumes.map((v) => `${v.local}=>${v.volume_id || "(待建)"}(${v.action})`).join(" ")}`);
        json(res, 200, { volumes: r.volumes, actions: r.actions });
        return;
      }

      // 章节列表：指定 volume_id 只取该卷；不指定则逐卷取全书（番茄没有「全部卷」的可靠取值）
      case "GET /api/chapters": {
        const bookId = url.searchParams.get("book_id") || "";
        if (!bookId) throw new TomatoApiError(-2, "请先指定 book_id");
        const volumeId = url.searchParams.get("volume_id") || "";
        if (volumeId) {
          json(res, 200, await fetchChapters(bookId, volumeId));
          return;
        }
        const vols = await fetchRemoteVolumes(bookId);
        const items = await fetchAllChapters(bookId);
        // 没有卷的书（volume_list 为空）也要能列章
        if (!vols.length && !items.length) json(res, 200, await fetchChapters(bookId, ""));
        else json(res, 200, items);
        return;
      }

      // 删除章节（逆向自番茄前端 ChapterManage chunk）：
      // POST /api/author/delete_article/v1，参数 book_id + item_id；草稿另带 is_draft=1。
      // 不可恢复，前端须二次确认。
      case "POST /api/chapter/delete": {
        const body = await readBody(req);
        const bookId = String(body.book_id || "");
        const itemId = String(body.item_id || "");
        if (!bookId) throw new TomatoApiError(-2, "缺少 book_id");
        if (!itemId) throw new TomatoApiError(-2, "缺少 item_id");
        const params = { book_id: bookId, item_id: itemId };
        if (body.is_draft) params.is_draft = 1;
        const data = await apiPost("/api/author/delete_article/v1", params);
        json(res, 200, { item_id: itemId, data });
        return;
      }

      // 批量发布：逐章处理，item 带 item_id = 更新已有章节（跳过 new_article），否则全新上传；
      // 每章先风险检查（基础必跑/全面可选）再 publish_article，遇错即停
      case "POST /api/publish": {
        const body = await readBody(req);
        const bookId = String(body.book_id || "");
        const items = Array.isArray(body.items) ? body.items : [];
        if (!bookId) throw new TomatoApiError(-2, "缺少 book_id");
        if (!items.length) throw new TomatoApiError(-2, "没有要发布的章节");
        let useAi = 2; // 1=是（使用AI）、2=否（未使用AI），默认申报"否"
        if (body.use_ai !== undefined && body.use_ai !== null && body.use_ai !== "") {
          useAi = Number(body.use_ai);
          if (useAi !== 1 && useAi !== 2) throw new TomatoApiError(-2, "use_ai 只能是 1（是）或 2（否）");
        }
        const checkType = body.check_type === "full" ? "full" : "base";
        // stream=1 → 逐章回推进度（NDJSON，一行一个事件），界面据此实时更新状态与日志窗口；不带 stream 时行为不变（一次性回 results）
        const streaming = Boolean(body.stream);
        if (streaming)
          res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        const emit = (o) => {
          if (!streaming) return;
          try {
            res.write(JSON.stringify(o) + "\n");
          } catch {
            /* 客户端已断开 */
          }
        };
        const results = [];
        // 卷模式：item 可带 local_volume（本地卷名；空 = 不带卷，落番茄默认卷）。
        // 先把本地卷和番茄卷对照好（同名复用 / 按位置认领并改名成本地卷名 / 缺的建卷），再逐卷发布
        const localNames = [];
        for (const it of items) {
          const n = String(it.local_volume ?? "").trim();
          if (n && !localNames.includes(n)) localNames.push(n);
        }
        const volPlan = localNames.length ? await syncVolumes(bookId, localNames) : null;
        if (volPlan) {
          for (const a of volPlan.actions) {
            logApp(`[publish] ${a}`);
            emit({ type: "log", text: a });
          }
          logApp(`[publish] 卷对照：${volPlan.volumes.map((v) => `${v.local}→${v.volume_id || "(待建)"}`).join(" ")}`);
        }
        const volNameById = new Map();
        for (const v of await fetchRemoteVolumes(bookId)) volNameById.set(String(v.volume_id), volNameOf(v));
        // 番茄没有「移动章节 / 插中间」的接口：新章先按「卷内标题」找番茄已有章节，找到就走更新路径，避免重复追加
        // 标题匹配两级：① 完全同名 ② 去掉「第N章」前缀后同名 —— 第二级保证「发布标题连续编号」改动后仍能对上旧章节
        const remoteByVol = new Map(); // volume_id → { exact: Map(标题 → item_id), core: Map(去序号标题 → item_id) }
        const remoteTitleIndex = async (volumeId) => {
          if (!remoteByVol.has(volumeId)) {
            const exact = new Map();
            const core = new Map();
            for (const c of await fetchChapters(bookId, volumeId)) {
              const t = String(c.title ?? c.chapter_title ?? "").trim();
              const id = String(c.item_id ?? c.id ?? "");
              if (!t || !id) continue;
              if (!exact.has(t)) exact.set(t, id);
              const k = chapterCore(t);
              if (k && !core.has(k)) core.set(k, id);
            }
            remoteByVol.set(volumeId, { exact, core });
          }
          return remoteByVol.get(volumeId);
        };
        const pushResult = (idx, r) => {
          results.push(r);
          emit({ type: "chap", i: idx, total: items.length, title: r.title, ok: r.ok, updated: r.updated, volume: r.volume, error: r.error, checks: r.checks });
        };
        emit({ type: "start", total: items.length });
        for (let idx = 0; idx < items.length; idx++) {
          const it = items[idx];
          emit({ type: "chap", i: idx, total: items.length, title: it.title, action: "start" });
          try {
            let itemId, volumeId, volumeName;
            let updated = Boolean(it.item_id);
            const lv = String(it.local_volume ?? "").trim();
            const planned = lv && volPlan ? volPlan.map.get(lv) : null;
            let target = planned;
            if (planned && !planned.volume_id) {
              // 番茄上还没有这个卷 → 此刻建卷（紧接着就发它的第一章，避免同时存在多个空卷）
              const vid = await ensureRemoteVolume(bookId, lv);
              target = { volume_id: vid, volume_name: lv, action: "已新建" };
              volPlan.map.set(lv, target);
              volNameById.set(vid, lv);
              emit({ type: "log", text: `已新建番茄卷「${lv}」` });
            }
            if (lv && target && !target.volume_id)
              throw new TomatoApiError(-1, `卷「${lv}」在番茄上还没建好，无法发布《${it.title}》`);
            if (it.item_id) {
              itemId = String(it.item_id);
              volumeId = String(it.volume_id ?? "") || String(target?.volume_id ?? "");
              if (!volumeId) throw new TomatoApiError(-2, `章节「${it.title}」缺少 volume_id，无法更新`);
              volumeName = String(it.volume_name ?? "") || volNameById.get(volumeId) || target?.volume_name || "";
            } else {
              const title = String(it.title ?? "").trim();
              const hit = target?.volume_id ? await remoteTitleIndex(target.volume_id) : null;
              const known = hit ? (hit.exact.get(title) ?? (chapterCore(title) ? hit.core.get(chapterCore(title)) : "") ?? "") : "";
              if (known) {
                itemId = known;
                updated = true;
                volumeId = target.volume_id;
                volumeName = target.volume_name;
              } else {
                const draft = await apiPost("/api/author/article/new_article/v0/", {
                  book_id: bookId,
                  need_reuse: 0,
                });
                itemId = String(draft.item_id);
                volumeId = String(draft?.volume_id ?? "");
                volumeName = "正文";
                try {
                  let vd = draft?.volume_data;
                  if (typeof vd === "string") vd = JSON.parse(vd);
                  if (Array.isArray(vd)) {
                    const hit2 = vd.find((v) => String(v.volume_id) === volumeId) ?? vd[0];
                    if (hit2?.volume_name) volumeName = hit2.volume_name;
                  }
                } catch {
                  /* 用默认名 */
                }
                // 指定了本地卷 → 发布到对照出来的番茄卷（编辑器里换卷也是这两个字段）
                if (target?.volume_id) {
                  volumeId = target.volume_id;
                  volumeName = target.volume_name;
                }
              }
            }
            const contentHtml = mdToHtml(String(it.content || ""));
            // 发布前风险检查（与官网 UI「内容检测方式」同一端点）：
            // 基础检测（type=1，不限次数）总是执行；全面检测（type=0，每章限 2 次）可选。
            // 与官网一致：任一检查请求异常都视为通过、不阻断发布（-3056 次数用尽同理）。
            const checks = {};
            try {
              checks.base = await preAudit(itemId, contentHtml, 1);
            } catch (e) {
              checks.base = { error: e.message };
            }
            if (checkType === "full") {
              try {
                checks.full = await preAudit(itemId, contentHtml, 0);
              } catch (e) {
                checks.full = { error: e.message };
              }
              const risks = checks.full?.risks;
              if (Array.isArray(risks) && risks.length > 0) {
                pushResult(idx, {
                  title: it.title,
                  ok: false,
                  itemId,
                  updated,
                  volume: volumeName,
                  checks,
                  error: `全面检测发现 ${risks.length} 处风险内容（中止发布）：${risks.map((r) => r.text).join(" / ")}`,
                });
                break;
              }
            }
            const data = await apiPost("/api/author/publish_article/v0/", {
              item_id: itemId,
              book_id: bookId,
              content: contentHtml,
              title: String(it.title || "").trim(),
              volume_id: volumeId,
              volume_name: volumeName,
              timer_status: 0,
              timer_time: 0,
              publish_status: 1,
              need_pay: 0,
              use_ai: useAi,
              device_platform: "pc",
              speak_type: 0,
              timer_chapter_preview: "[]",
              has_chapter_ad: "false",
              chapter_ad_types: "",
            });
            logApp(`[publish] ${updated ? "更新" : "新建"}《${String(it.title || "").trim()}》卷=${volumeName || volumeId} item_id=${itemId}`);
            pushResult(idx, { title: it.title, ok: true, itemId, updated, volume: volumeName, volumeId, checks, data });
          } catch (e) {
            pushResult(idx, { title: it.title, ok: false, error: e.message, code: e.code });
            break; // 遇错即停，避免半截状态
          }
        }
        if (streaming) {
          emit({ type: "done", results });
          res.end();
        } else json(res, 200, { results });
        return;
      }

      default:
        json(res, 404, { error: `未知路由：${req.method} ${url.pathname}` });
    }
  } catch (e) {
    // 流式响应（发布进度）已经开了头 → 错误也只能按 NDJSON 事件回，不能再写一遍 JSON 响应
    if (res.headersSent) {
      logApp(`[error] 流式响应中断：${e.message}`);
      try {
        res.write(JSON.stringify({ type: "error", error: e.message, code: e.code ?? null }) + "\n");
        res.end();
      } catch { /* 客户端已断开 */ }
      return;
    }
    const status = e instanceof TomatoApiError && e.code === -2 ? 400 : 500;
    json(res, status, { error: e.message, code: e.code ?? null });
  }
});

function __dirname() {
  return path.dirname(fileURLToPath(import.meta.url));
}

// 启动：端口冲突时给出可读提示而不是堆栈报错。
// 同工具实例已在运行（双击 exe 重复启动的常见场景）→ 提示无需重复启动；
// 端口被别的程序占用 → 自动往后试 9 个端口
function isOurInstance(port) {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.text() : ""))
    .then((t) => t.includes("番茄小说发布工具")) // 与 index.html <title> 一致
    .catch(() => false);
}

// 注意：不能用 server.listen(port, host, cb) 传成功回调——Bun 在监听失败时不会移除
// 待触发的 listening 回调，重试成功后旧回调也会被调用，日志会多打一行错误端口
let currentPort = 0;
server.on("listening", () => {
  console.log(`番茄发布工具已启动：http://127.0.0.1:${currentPort}`);
  if (!globalThis.__ON_LISTEN__) {
    console.log(`用浏览器打开上面的地址即可；关闭本窗口即退出（端口可用环境变量 PORT 修改）`);
  }
  globalThis.__ON_LISTEN__?.(currentPort);
});

function listen(port, tries) {
  currentPort = port;
  server.once("error", async (e) => {
    if (e.code === "EADDRINUSE") {
      if (await isOurInstance(port)) {
        console.log(`已有一个番茄发布工具在运行：http://127.0.0.1:${port} —— 无需重复启动，直接用浏览器打开即可`);
        globalThis.__ALREADY_RUNNING__?.(port);
        process.exit(0);
      }
      if (tries < 9) {
        console.log(`端口 ${port} 已被其他程序占用，改用 ${port + 1} 重试…`);
        return listen(port + 1, tries + 1);
      }
      console.error(`启动失败：端口 ${PORT}~${port} 均被占用`);
      process.exit(1);
    }
    console.error(`启动失败：${e.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1");
}

listen(PORT, 0);
