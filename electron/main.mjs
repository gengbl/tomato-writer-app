// 番茄小说发布工具 —— Electron 应用入口（应用内窗口版）
//
// 与 console 版（bun 单文件 exe）共用同一套 server.mjs 业务代码：
//   - 主窗口直接加载 http://127.0.0.1:PORT 的工具界面，用户无需再开浏览器
//   - 「登录番茄账号」不弹新窗口：登录页内嵌在「登录状态」页下方（<webview> 标签），
//     扫码成功后内嵌区自然跳转到已登录的番茄作家后台首页
//   - server.mjs 通过 globalThis.__LOGIN_DRIVER__ / __ON_LOGIN_ATTACH__ / __ON_LISTEN__ / __APP_ROOT__ 接入
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, session, shell, webContents } from "electron";

// 自检用：造一个最小合法的 .docx（zip + deflateRaw），用来验证 Word 正文读取（不依赖外部文件）
function makeDocxBuffer(paras) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = -1;
    for (const x of b) c = (c >>> 8) ^ crcTable[(c ^ x) & 0xff];
    return (c ^ -1) >>> 0;
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`],
  ];
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const body = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const lhBuf = Buffer.concat([lh, nameBuf, body]);
    locals.push(lhBuf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    off += lhBuf.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
// .env / web-state.json 存放处：打包版在 exe 旁边（整目录拷走即带走登录状态），开发模式在 web/ 下。
// 注意 AppImage 的 process.execPath 在临时挂载目录（退出即销毁），要用 APPIMAGE 变量取真实文件位置；
// macOS 的 .app 是个目录包（改名/更新都会丢数据），数据放 ~/Library/Application Support/tomato-writer
const exeDir = app.isPackaged
  ? process.platform === "darwin"
    ? path.join(app.getPath("appData"), "tomato-writer")
    : path.dirname(process.env.APPIMAGE || process.execPath)
  : path.resolve(SELF_DIR, "..");
const DATA_DIR = exeDir;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true }); // macOS 上首次运行时该目录还不存在
} catch { /* 已存在或无权限，写文件时再报错 */ }

// 抹掉 UA 里的 Electron 标识，避免番茄登录页识别
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;
const LOGIN_PARTITION = "persist:tomato-login";

let mainWin = null;
let attachedGuest = null; // 界面内嵌登录 webview 的 webContents（前端经 /api/login/attach 上报）

// 每次登录从干净 Cookie 开始：残留的过期 sessionid 会干扰「登录成功」判定
function loginSession() {
  return session.fromPartition(LOGIN_PARTITION);
}

// 登录驱动（server.mjs 调用）：驱动界面内嵌 webview + 专属会话提取 Cookie
function makeLoginDriver() {
  let guest = null;
  const ses = loginSession();
  return {
    async open(loginUrl) {
      if (!attachedGuest || attachedGuest.isDestroyed())
        throw new Error("登录视图未就绪（界面内嵌登录页未打开）");
      guest = attachedGuest;
      await ses.clearStorageData({ storages: ["cookies"] });
      guest.loadURL(loginUrl).catch(() => {});
    },
    alive: () => Boolean(guest && !guest.isDestroyed()),
    currentUrl: () => {
      try {
        return guest && !guest.isDestroyed() ? guest.getURL() : null;
      } catch {
        return null;
      }
    },
    async cookies() {
      if (!guest || guest.isDestroyed()) return null;
      const cs = await ses.cookies.get({ domain: "fanqienovel.com" });
      return cs.length ? cs.map((c) => `${c.name}=${c.value}`).join("; ") : null;
    },
    // 不主动销毁内嵌页：登录成功后界面要显示作家后台首页；取消/出错时前端移除元素即销毁
    close() {},
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // 已有实例：直接退出（双击多次不会出现两个窗口抢端口）
} else {
  app.on("second-instance", () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  globalThis.__LOGIN_DRIVER__ = makeLoginDriver;
  // 已登录启动时：内嵌页直接显示作家后台首页；会话里没有登录 Cookie（如手动拷贝的 .env）就先把 .env Cookie 注入会话
  globalThis.__ON_HOME_SHOW__ = async (id) => {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return;
    attachedGuest = wc;
    const ses = loginSession();
    const cs = await ses.cookies.get({ domain: "fanqienovel.com" });
    if (!cs.some((c) => /^sessionid(_ss)?$/.test(c.name))) {
      const cookieStr = globalThis.__GET_COOKIE__?.() || "";
      for (const p of cookieStr.split(";")) {
        const i = p.indexOf("=");
        if (i <= 0) continue;
        try {
          await ses.cookies.set({ url: "https://fanqienovel.com", name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() });
        } catch { /* 个别 Cookie 属性不合规则跳过 */ }
      }
    }
    wc.loadURL("https://fanqienovel.com/main/writer/").catch(() => {});
  };
  globalThis.__ON_LOGOUT__ = () => {
    // 退出登录：清除内嵌登录会话的 Cookie，让内嵌页回到未登录态
    if (attachedGuest && !attachedGuest.isDestroyed()) attachedGuest.loadURL("about:blank").catch(() => {});
    return loginSession().clearStorageData({ storages: ["cookies"] });
  };
  globalThis.__ON_LOGIN_ATTACH__ = (id) => {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) attachedGuest = wc;
  };

  let listenPort = 0;
  globalThis.__ON_LISTEN__ = (port) => {
    listenPort = port;
    mainWin = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 940,
      minHeight: 620,
      title: "番茄小说发布工具",
      autoHideMenuBar: true,
      webPreferences: { spellcheck: false, webviewTag: true },
    });
    mainWin.webContents.setUserAgent(UA);
    // 页面 <title> 会随番茄页面变，锁死为工具名
    mainWin.on("page-title-updated", (e) => e.preventDefault());
    mainWin.on("closed", () => (mainWin = null));
    // 应用菜单被移除（见下方 setApplicationMenu(null)），DevTools 的默认快捷键失效，这里自己接 F12 / Ctrl+Shift+I
    mainWin.webContents.on("before-input-event", (_e, input) => {
      const k = String(input.key || "").toLowerCase();
      if (input.type === "keyDown" && (k === "f12" || (input.control && input.shift && k === "i")))
        mainWin.webContents.toggleDevTools();
    });
    if (process.env.TOMATO_DEVTOOLS === "1" || process.argv.includes("--devtools"))
      mainWin.webContents.openDevTools({ mode: "detach" });
    // 页面里的 window.open（如「🖼 打开封面设置页」）交给系统浏览器，应用内不开新窗口
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    mainWin.loadURL(`http://127.0.0.1:${port}`);

    if (process.env.TOMATO_SELFTEST) {
      mainWin.webContents.once("did-finish-load", async () => {
        try {
          await new Promise((r) => setTimeout(r, 800)); // 等首屏渲染完
          if (process.env.TOMATO_SELFTEST === "login") {
            // 自动登录流验证：初始化时未登录 → 前端自动 attach → start → waiting
            const base = `http://127.0.0.1:${listenPort}`;
            await new Promise((r) => setTimeout(r, 5000)); // 等自动登录流程起来
            const st = await (await fetch(`${base}/api/login/status`)).json();
            console.log(`[selftest] 登录状态: phase=${st.phase} message=${st.message || st.error || ""} diag=${st.diag || ""}`);
            if (st.phase === "waiting") {
              const cs = await loginSession().cookies.get({ domain: "fanqienovel.com" });
              console.log(`[selftest] 内嵌页会话 Cookie 数: ${cs.length}（应>0，证明登录页已加载且会话可读）`);
              const c = await (await fetch(`${base}/api/login/cancel`, { method: "POST" })).json();
              console.log(`[selftest] 取消后: phase=${c.phase} error=${c.error}`);
            }
          } else if (process.env.TOMATO_SELFTEST === "cookie") {
            // 全链路（除扫码）：自动登录流起来后，把已有有效 Cookie 注入内嵌会话（等效扫码成功）
            // → 服务端轮询检测 sessionid → 签发 Token → 写 .env → status 变绿 → 点退出 → 回到未登录+自动登录页
            const base = `http://127.0.0.1:${listenPort}`;
            await new Promise((r) => setTimeout(r, 4000)); // 等自动登录 attach+open（清 Cookie、加载登录页）
            const envText = fs.readFileSync(process.env.TOMATO_TEST_COOKIE_FILE, "utf8");
            const m = envText.match(/^TOMATO_COOKIE=(.*)$/m);
            if (!m) throw new Error("测试文件里没有 TOMATO_COOKIE");
            const pairs = m[1].trim().replace(/^"|"$/g, "").split("; ");
            let n = 0;
            for (const p of pairs) {
              const i = p.indexOf("=");
              if (i <= 0) continue;
              try {
                await loginSession().cookies.set({ url: "https://fanqienovel.com", name: p.slice(0, i), value: p.slice(i + 1) });
                n++;
              } catch { /* 个别 Cookie 属性不合规则跳过 */ }
            }
            console.log(`[selftest] 已注入 ${n} 个 Cookie 到登录会话`);
            await new Promise((r) => setTimeout(r, 7000)); // 等一轮轮询（检测→签发→写盘）
            const st = await (await fetch(`${base}/api/login/status`)).json();
            console.log(`[selftest] login: phase=${st.phase} error=${st.error || ""} diag=${st.diag || ""}`);
            if (st.phase === "done") console.log(`[selftest] result=${JSON.stringify(st.result)}`);
            const s2 = await (await fetch(`${base}/api/status`)).json();
            console.log(`[selftest] status: cookieOk=${s2.cookieOk} tokenOk=${s2.tokenOk}`);
            // 退出流程验证：登录后按钮应变成「退出番茄账号」→ 点击退出 → 状态回到未登录 → 前端自动重新打开登录页
            await new Promise((r) => setTimeout(r, 1000)); // 等前端轮询刷新按钮形态
            const btns = await mainWin.webContents.executeJavaScript(
              `JSON.stringify({login: getComputedStyle(document.getElementById("btn-login")).display, logout: getComputedStyle(document.getElementById("btn-logout")).display})`);
            console.log(`[selftest] 登录后按钮: ${btns}（应为 login=none, logout=block）`);
            await mainWin.webContents.executeJavaScript(`window.confirm = () => true; document.getElementById("btn-logout").click(); true`);
            await new Promise((r) => setTimeout(r, 4000)); // 退出 + 前端自动重新登录
            const s3 = await (await fetch(`${base}/api/status`)).json();
            const st3 = await (await fetch(`${base}/api/login/status`)).json();
            const cs3 = await loginSession().cookies.get({ domain: "fanqienovel.com" });
            console.log(`[selftest] 退出后: cookieOk=${s3.cookieOk} tokenOk=${s3.tokenOk} loginPhase=${st3.phase} 会话Cookie数=${cs3.length}`);
            app.exit(s2.cookieOk && st.phase === "done" && s3.cookieOk === false && s3.tokenOk === false && st3.phase === "waiting" && !cs3.some((c) => c.name.startsWith("sessionid")) ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "home") {
            // 已登录启动场景：.env 已有 Cookie/Token → 初始化应自动内嵌并显示作家后台首页
            const base = `http://127.0.0.1:${listenPort}`;
            await new Promise((r) => setTimeout(r, 4000));
            const s = await (await fetch(`${base}/api/status`)).json();
            const embedShown = await mainWin.webContents.executeJavaScript(
              `getComputedStyle(document.getElementById("login-embed")).display !== "none"`);
            await new Promise((r) => setTimeout(r, 3000)); // 等首页加载
            const guestUrl = attachedGuest && !attachedGuest.isDestroyed() ? attachedGuest.getURL() : null;
            const hasLogin = (await loginSession().cookies.get({ domain: "fanqienovel.com" })).some((c) => /^sessionid(_ss)?$/.test(c.name));
            console.log(`[selftest] home: cookieOk=${s.cookieOk} embed=${embedShown} guestUrl=${guestUrl} 会话含sessionid=${hasLogin}`);
            app.exit(s.cookieOk && embedShown && guestUrl && guestUrl.includes("fanqienovel.com") && hasLogin ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "categories") {
            // 建书分类下拉验证：打开第 3 屏 → 番茄字典填充 4 个下拉框 → 提交值取 id；切换频道应换字典
            const opts = () =>
              mainWin.webContents.executeJavaScript(
                `JSON.stringify(["bk-cat-main","bk-cat-theme","bk-cat-role","bk-cat-plot"].map((id) => {` +
                  `const s = document.getElementById(id); return id + "=" + s.options.length + "项" + (s.value ? "(已选" + s.value + ")" : "");}))`
              );
            await mainWin.webContents.executeJavaScript(`showTab(3); true`); // 打开「③ 创建新书」（会取分类字典、填示例简介）
            await new Promise((r) => setTimeout(r, 3500));
            const a = JSON.parse(await opts());
            const val = await mainWin.webContents.executeJavaScript(
              `(() => { const s = document.getElementById("bk-cat-main"); s.selectedIndex = 1; s.dispatchEvent(new Event("change")); return categoryValue(); })()`
            );
            console.log(`[selftest] 女频分类: ${a.join(" ")}`);
            console.log(`[selftest] 选中主分类后 categoryValue = ${val}`);
            const rolesOut = await mainWin.webContents.executeJavaScript(
              `(() => { const s = document.getElementById("bk-roles"); s.value = "王晓晓、刘馨,陈桓 / 李沁"; return rolesValue(); })()`
            );
            console.log(`[selftest] 角色「王晓晓、刘馨,陈桓 / 李沁」→ rolesValue = ${rolesOut}`);
            const coverUrl = await mainWin.webContents.executeJavaScript(`coverPageUrl("1234567890")`);
            console.log(`[selftest] 封面页 URL = ${coverUrl}`);
            const abstractInfo = JSON.parse(
              await mainWin.webContents.executeJavaScript(
                `(() => { const t = document.getElementById("bk-abstract"); const m = document.getElementById("msg-abstract");` +
                  `const 示例 = { 是真实文字: t.value.includes("王晓晓") && !t.value.includes("①"), 字数: [...t.value.trim()].length };` +
                  `t.value = "试".repeat(60); t.dispatchEvent(new Event("input"));` +
                  `return JSON.stringify({ 示例, 字数提示: m.textContent, 预填按钮还在: !!document.getElementById("btn-pending"), 日志按钮: !!document.getElementById("btn-log") }); })()`
              )
            );
            console.log(
              `[selftest] 简介: 真实文字示例=${abstractInfo.示例.是真实文字}（${abstractInfo.示例.字数} 字） 字数提示=${abstractInfo.字数提示} 预填按钮还在=${abstractInfo.预填按钮还在} 诊断日志按钮=${abstractInfo.日志按钮}`
            );
            await mainWin.webContents.executeJavaScript(
              `(() => { const g = document.getElementById("bk-gender"); g.value = "1"; g.dispatchEvent(new Event("change")); return true; })()`
            );
            await new Promise((r) => setTimeout(r, 3500));
            const b = JSON.parse(await opts());
            console.log(`[selftest] 男频分类: ${b.join(" ")}`);
            const okCount = (arr) => arr.every((s) => Number((/\d+/.exec(s) || [0])[0]) > 5);
            let rolesOk = false;
            try { rolesOk = JSON.parse(rolesOut).join(",") === "王晓晓,刘馨,陈桓,李沁"; } catch { /* 非法 JSON，判失败 */ }
            const pass =
              okCount(a) && okCount(b) && /^\d+(,\d+)*$/.test(val) && !b[0].includes("(已选") && rolesOk &&
              coverUrl.includes("/book-info/1234567890") && abstractInfo.示例.是真实文字 &&
              abstractInfo.示例.字数 >= 50 && abstractInfo.示例.字数 <= 200 &&
              abstractInfo.字数提示.includes("✓") && !abstractInfo.预填按钮还在 && abstractInfo.日志按钮;
            console.log(`[selftest] 结果：${pass ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(pass ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "books") {
            // 「② 我的书籍」联动验证：登录后主动刷新（表格+下拉）、签约书删除置灰、删除后全页面联动
            const out = await mainWin.webContents.executeJavaScript(`(async () => {
              let 远端刷新 = 0;
              const origRemote = window.loadRemoteChapters;
              window.loadRemoteChapters = () => { 远端刷新++; };
              let 书目 = [
                { book_id: "101", book_name: "测试书A", word_count: 1200 },
                { book_id: "102", book_name: "测试书B", is_signing: true },
              ];
              const origApi = window.api;
              window.api = async (p, o) => {
                if (p === "/api/novels") return 书目;
                if (p === "/api/book/delete") { const id = JSON.parse(o.body).book_id; 书目 = 书目.filter((b) => b.book_id !== id); return { book_id: id }; }
                return null;
              };
              const log = [];
              // 等启动时那次真实「② 我的书籍」加载结束，否则它会覆盖下面的假数据（自检竞态，非应用 bug）
              for (let i = 0; i < 20; i++) {
                const t = document.getElementById("msg-novels").textContent;
                if (t.includes("本") || t.includes("失败")) break;
                await new Promise((r) => setTimeout(r, 500));
              }
              refreshNovelsAfterLogin("登录成功后");
              await new Promise((r) => setTimeout(r, 200));
              const tr = () => document.querySelectorAll("#tbl-novels tbody tr");
              log.push("登录后表格行=" + tr().length);
              log.push("表格可见=" + (getComputedStyle(document.getElementById("tbl-novels")).display !== "none"));
              log.push("目标书籍下拉项=" + document.getElementById("pub-book").options.length);
              log.push("签约书删除置灰=" + tr()[1].querySelectorAll("button")[1].disabled);
              window.confirm = () => true;
              document.getElementById("bk-dir").value = "";
              await deleteBook(书目.find((b) => b.book_id === "101") || { book_id: "101", book_name: "测试书A" });
              await new Promise((r) => setTimeout(r, 200));
              log.push("删除后表格行=" + tr().length);
              log.push("删除后提示=" + document.getElementById("msg-novels").textContent);
              log.push("删除后联动刷新远端章节=" + 远端刷新);
              window.api = origApi;
              window.loadRemoteChapters = origRemote;
              return JSON.stringify(log);
            })()`);
            const lines = JSON.parse(out);
            for (const l of lines) console.log("[selftest] " + l);
            const ok =
              lines[0] === "登录后表格行=2" && lines[1] === "表格可见=true" && lines[2] === "目标书籍下拉项=2" &&
              lines[3] === "签约书删除置灰=true" && lines[4] === "删除后表格行=1" &&
              lines[5].includes("已删除《测试书A》") && lines[5].includes("现有 1 本") && lines[6] === "删除后联动刷新远端章节=1";
            console.log(`[selftest] 结果：${ok ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(ok ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "volumes") {
            // 卷模式前端逻辑验证：本地卷展示、按「卷+标题 / 同卷同章号」对齐、卷顺序、item 带 local_volume、卷对照预检
            const out = await mainWin.webContents.executeJavaScript(`(async () => {
              const 本地章 = [
                { index: 1, num: 1, title: "序章", vol: null, file: "f0.md", wordCount: 10, content: "c0", publishTitle: "第1章 序章" },
                { index: 2, num: 1, title: "广告", vol: "新生", file: "f1.md", wordCount: 11, content: "c1", publishTitle: "第1章 广告" },
                { index: 3, num: 2, title: "上传", vol: "新生", file: "f2.md", wordCount: 12, content: "c2", publishTitle: "第2章 上传" },
                { index: 4, num: 3, title: "新家", vol: "新生", file: "f3.md", wordCount: 13, content: "c3", publishTitle: "第3章 新家" },
                { index: 5, num: 1, title: "文档", vol: "独立", file: "f4.md", wordCount: 14, content: "c4", publishTitle: "第1章 文档" },
                { index: 6, num: 2, title: "单干", vol: "独立", file: "f5.md", wordCount: 15, content: "c5", publishTitle: "第2章 单干" },
              ];
              const origApi = window.api;
              window.api = async (p, o) => {
                if (p.startsWith("/api/book-chapters"))
                  return { path: "/x/书稿", chapters: 本地章, volume_md: "/x/卷.md",
                    volumes: [{ name: "新生", order: 1, declared: true, count: 3 }, { name: "独立", order: 2, declared: true, count: 2 }] };
                if (p.startsWith("/api/volumes/sync")) {
                  const b = JSON.parse(o.body);
                  return { actions: ["将把番茄卷「第一卷：默认」(v1) 改名为「独立」"],
                    volumes: [{ local: "新生", volume_id: "v9", volume_name: "新生", action: "复用同名卷" },
                              { local: "独立", volume_id: "v1", volume_name: "第一卷：默认", action: "改名 → 独立" }] };
                }
                if (p.startsWith("/api/volumes?"))
                  return { volumes: [{ volume_id: "v9", volume_name: "新生", item_count: 3, can_delete: false },
                                     { volume_id: "v1", volume_name: "第一卷：默认", item_count: 4, can_delete: true }] };
                if (p.startsWith("/api/chapters?"))
                  return [
                    { item_id: "9001", title: "第1章 广告", volume_id: "v9" },
                    { item_id: "9002", title: "第2章 上传", volume_id: "v9" },
                    { item_id: "9004", title: "第3章 新的家", volume_id: "v9" }, // 标题不同、章号相同 → 走「同卷同章号」回退
                    { item_id: "9005", title: "第7章 文档", volume_id: "v1" },   // 序号不同、标题相同 → 走「去序号标题」匹配
                    { item_id: "9003", title: "第9章 番外", volume_id: "v1" },   // 番茄独有 → 仅番茄端
                  ];
                return null;
              };
              const log = [];
              document.getElementById("bk-dir").value = "/x/书稿";
              document.getElementById("pub-book").innerHTML = '<option value="1">测试书</option>';
              document.getElementById("pub-book").value = "1";
              await document.getElementById("btn-split").onclick();
              await new Promise((r) => setTimeout(r, 400));
              log.push("加载提示=" + document.getElementById("msg-split").textContent);
              await loadRemoteChapters("1");
              await new Promise((r) => setTimeout(r, 400));
              log.push("合并行数=" + mergedRows.length);
              log.push("顺序=" + mergedRows.map((r) => (r.vol || "书根") + "#" + r.num).join(","));
              log.push("匹配上的本地行=" + mergedRows.filter((r) => r.local && r.remote).length);
              log.push("仅番茄端行=" + mergedRows.filter((r) => !r.local).length);
              log.push("番外所在卷=" + (mergedRows.find((r) => !r.local) || {}).vol);
              const it书根 = rowItem(mergedRows.find((r) => r.local && !r.vol));
              const it新生 = rowItem(mergedRows.find((r) => r.local && r.vol === "新生" && r.num === 1));
              const it独立 = rowItem(mergedRows.find((r) => r.local && r.vol === "独立" && r.num === 1));
              log.push("local_volume=" + JSON.stringify([it书根.local_volume, it新生.local_volume, it独立.local_volume]));
              log.push("更新路径带item_id=" + (mergedRows.find((r) => r.local && r.remote)?.remote ? "yes" : "no"));
              log.push("卷列内容=" + [...document.querySelectorAll("#tbl-merged tbody tr")].slice(0, 3).map((tr) => tr.children[2].textContent.trim()).join("|"));
              await document.getElementById("btn-vol-plan").onclick();
              await new Promise((r) => setTimeout(r, 300));
              log.push("卷对照预检=" + document.getElementById("msg-publish").textContent.replace(/\\n/g, " / "));
              window.api = origApi;
              return JSON.stringify(log);
            })()`);
            const lines = JSON.parse(out);
            for (const l of lines) console.log("[selftest] " + l);
            const ok =
              lines[0].includes("卷 2 个") && lines[0].includes("新生(3章)") &&
              lines[1] === "合并行数=7" &&
              lines[2] === "顺序=书根#1,新生#1,新生#2,新生#3,独立#1,独立#2,独立#9" &&
              lines[3] === "匹配上的本地行=4" && lines[4] === "仅番茄端行=1" && lines[5] === "番外所在卷=独立" &&
              lines[6] === 'local_volume=["","新生","独立"]' && lines[7] === "更新路径带item_id=yes" &&
              lines[8].includes("新生") && lines[9].includes("改名 → 独立");
            console.log(`[selftest] 结果：${ok ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(ok ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "flatvols") {
            // 平铺模式「NN卷-NN章-标题」命名解析回归：真临时目录 + 真 /api/book-chapters（不碰番茄）
            const dir = path.join(app.getPath("temp"), "tomato-flat-selftest");
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(path.join(dir, "书稿"), { recursive: true });
            fs.writeFileSync(
              path.join(dir, "卷.md"),
              "# 自检 卷\n\n## vol_1\n- 名称：甲卷\n- 顺序：1\n\n## vol_2\n- 名称：乙卷\n- 顺序：2\n"
            );
            for (const n of [
              "01卷-01章-甲一.md", // 卷号-章号
              "第一卷-02章-甲二.md", // 中文卷号
              "第2卷-01章-乙一.md",
              "02-02-两段数字.md", // 纯两段数字
              "卷王的诞生.md", // 干扰项：不是卷
              "01卷-02章-甲二-大纲.md", // 干扰项：辅助文件，不算章节
            ])
              fs.writeFileSync(path.join(dir, "书稿", n), `# ${n.replace(/\.(md|txt)$/, "")}\n\n正文段落。\n`);
            const out = await mainWin.webContents.executeJavaScript(`(async () => {
              const r = await window.api("/api/book-chapters?path=" + encodeURIComponent(${JSON.stringify(path.join(dir, "书稿"))}));
              return JSON.stringify({
                卷: (r.volumes ?? []).map((v) => v.name + "(" + v.count + "章)"),
                章: (r.chapters ?? []).map((c) => (c.vol ?? "书根") + "|" + c.publishTitle),
              });
            })()`);
            const got = JSON.parse(out);
            console.log("[selftest] 本地卷=" + got["卷"].join(" "));
            for (const l of got["章"]) console.log("[selftest] 章 " + l);
            const ok =
              got["卷"].join(",") === "甲卷(2章),乙卷(2章)" &&
              got["章"].join(",") ===
                "书根|第1章 卷王的诞生,甲卷|第2章 甲一,甲卷|第3章 甲二,乙卷|第4章 乙一,乙卷|第5章 两段数字";
            console.log(`[selftest] 结果：${ok ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(ok ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "publish") {
            // 上传过程实时状态 / 当前页跟随 / 上传日志窗口（清除·关闭·重开·1/4 高·滚动跟随）/ 刷新保留当前页 —— 全程假数据，不碰番茄
            const out = await mainWin.webContents.executeJavaScript(`(async () => {
              const $ = (id) => document.getElementById(id);
              $("card-4").style.display = ""; // 自检里让第 ④ 步卡片可见，才能量到上传日志窗口的实际高度
              // 45 章本地章节（每页 20 行 → 3 页）
              chapters = Array.from({ length: 45 }, (_, i) => ({
                index: i + 1, num: i + 1, title: "章" + (i + 1), vol: null, file: "f" + (i + 1) + ".md",
                content: "正文", wordCount: 100, publishNum: i + 1, publishTitle: "第" + (i + 1) + "章 章" + (i + 1),
              }));
              remoteList = [];
              remoteVols = [];
              localVolumes = [];
              mPageSize = 20;
              mPage = 1;
              mPageBook = "9";
              buildMerged();
              renderMerged();
              $("pub-book").innerHTML = '<option value="9">测试书</option>';
              $("pub-book").value = "9";
              clearUplog();
              const origApi = window.api;
              const origFetch = window.fetch;
              const origConfirm = window.confirm;
              window.confirm = () => true;
              window.api = async (p) => {
                if (p.startsWith("/api/volumes")) return { volumes: [] };
                if (p.startsWith("/api/chapters"))
                  return Array.from({ length: 45 }, (_, i) => ({ item_id: "900" + i, title: "第" + (i + 1) + "章 章" + (i + 1), volume_id: "", volume_name: "" }));
                return null;
              };
              // 假的流式发布：每 10ms 推一行 NDJSON 事件（第 5 章故意失败）
              const total = 45;
              let sent = 0;
              const stateSeen = new Set(); // 记录状态列出现过的文案（⏳ 是瞬间态，靠快照抓不稳，直接记录）
              const origSetRowState = window.setRowState;
              window.setRowState = (row, kind, text) => {
                stateSeen.add(text);
                return origSetRowState(row, kind, text);
              };
              window.fetch = (path, opts) => {
                if (!String(path).startsWith("/api/publish")) return origFetch(path, opts);
                const enc = new TextEncoder();
                const next = () => {
                  if (sent > total * 2) return null;
                  if (sent === 0) { sent++; return JSON.stringify({ type: "start", total }); }
                  const k = sent - 1;
                  sent++;
                  if (k % 2 === 0) {
                    const i = k / 2;
                    return JSON.stringify({ type: "chap", i, total, title: "第" + (i + 1) + "章 章" + (i + 1), action: "start" });
                  }
                  const i = (k - 1) / 2;
                  return JSON.stringify({
                    type: "chap", i, total, title: "第" + (i + 1) + "章 章" + (i + 1), ok: i !== 4,
                    updated: false, volume: "甲卷", itemId: "900" + i, checks: { base: { risks: [] } },
                    error: i === 4 ? "模拟失败：字数不足" : undefined,
                  });
                };
                return Promise.resolve(
                  new Response(
                    new ReadableStream({
                      pull(c) {
                        return new Promise((res) =>
                          setTimeout(() => {
                            const line = next();
                            if (line === null) c.close();
                            else c.enqueue(enc.encode(line + "\\n"));
                            res();
                          }, 10)
                        );
                      },
                    }),
                    { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
                  )
                );
              };
              const cells = () => [...document.querySelectorAll("#tbl-merged tbody tr")].map((tr) => (tr.children[4] || {}).textContent || "");
              const snap = () => ({
                页码: $("merged-pager").textContent,
                视口高: window.innerHeight,
                元素高: $("uplog-body").clientHeight,
                内容高: $("uplog-body").scrollHeight,
                上传中: cells().filter((t) => t.includes("上传中")).length,
                已上传: cells().filter((t) => t.includes("已上传")).length,
                失败: cells().filter((t) => t.includes("失败")).length,
                日志行: $("uplog-body").childElementCount,
                日志滚到底: $("uplog-body").scrollHeight > $("uplog-body").clientHeight && $("uplog-body").scrollTop > 0,
                面板: getComputedStyle($("uplog-panel")).display,
                高度比: Math.round(($("uplog-body").clientHeight / window.innerHeight) * 100),
              });
              const p = $("btn-publish-all").onclick();
              await new Promise((r) => setTimeout(r, 150));
              const s1 = snap();
              await new Promise((r) => setTimeout(r, 350));
              const mid = snap();
              await p;
              await new Promise((r) => setTimeout(r, 250)); // 发布结束后服务端会自动刷新一次（只刷状态、保留当前页）
              const after = snap();
              const 勾选 = mSelSet.size;
              const 摘要 = $("msg-publish").textContent;
              window.fetch = origFetch;
              window.confirm = origConfirm;
              // 日志窗口控件：清除 → 关闭 → 重新打开 → 恢复高度
              $("btn-uplog-clear").click();
              const 清除后 = $("uplog-body").childElementCount;
              $("btn-uplog-close").click();
              const 关闭后面板 = getComputedStyle($("uplog-panel")).display;
              const 关闭后按钮 = getComputedStyle($("btn-uplog-open")).display;
              $("btn-uplog-open").click();
              const 重开后面板 = getComputedStyle($("uplog-panel")).display;
              const 高度 = $("uplog-body").style.height;
              $("uplog-body").style.height = "400px";
              $("btn-uplog-reset").click();
              const 恢复高度 = $("uplog-body").style.height;
              window.api = origApi;
              window.setRowState = origSetRowState;
              return JSON.stringify({ s1, mid, after, 勾选, 摘要, 清除后, 关闭后面板, 关闭后按钮, 重开后面板, 高度, 恢复高度, 状态文案: [...stateSeen] });
            })()`);
            const got = JSON.parse(out);
            console.log("[selftest] 150ms=" + JSON.stringify(got.s1));
            console.log("[selftest] 500ms=" + JSON.stringify(got.mid));
            console.log("[selftest] 结束=" + JSON.stringify(got.after));
            console.log(`[selftest] 勾选=${got.勾选} 清除后=${got.清除后} 关闭=${got.关闭后面板}/${got.关闭后按钮} 重开=${got.重开后面板} 高度=${got.高度}→${got.恢复高度}`);
            console.log("[selftest] 状态文案=" + JSON.stringify(got.状态文案));
            console.log("[selftest] 摘要=" + got.摘要);
            const 四分之一 = (n) => n >= 22 && n <= 28;
            const ok =
              got.mid.面板 !== "none" &&
              got.s1.日志行 >= 8 &&
              got.状态文案.some((t) => t.includes("上传中")) && // ⏳ 靠 setRowState 钩子记录，不靠快照撞时机
              got.mid.已上传 + got.mid.失败 >= 5 &&
              got.mid.已上传 + got.mid.失败 < 45 &&
              got.mid.日志行 >= 20 &&
              got.mid.日志滚到底 === true &&
              四分之一(got.mid.高度比) &&
              got.after.页码.includes("第 3 / 3 页") &&
              got.after.已上传 === 45 &&
              got.勾选 === 45 &&
              got.摘要.includes("成功 44 / 45") &&
              got.清除后 === 0 &&
              got.关闭后面板 === "none" &&
              got.关闭后按钮 !== "none" &&
              got.重开后面板 !== "none" &&
              got.恢复高度 === "25vh";
            console.log(`[selftest] 结果：${ok ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(ok ? 0 : 1);
          } else if (process.env.TOMATO_SELFTEST === "docmode") {
            // 单文档拆章 + Word 读取回归：整本一个文件（txt/docx/md 结果要一致）、平铺 docx、旧版 .doc 提醒、浏览面板列出文档
            const dir = path.join(app.getPath("temp"), "tomato-doc-selftest");
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(path.join(dir, "单文档"), { recursive: true });
            fs.mkdirSync(path.join(dir, "平铺docx"), { recursive: true });
            fs.writeFileSync(
              path.join(dir, "单文档", "卷.md"),
              "# 自检 卷\n\n## vol_1\n- 名称：甲卷\n- 顺序：1\n\n## vol_2\n- 名称：乙卷\n- 顺序：2\n"
            );
            const 本文 = [
              "书名：测试稿",
              "简介：整本放在一个文件里的自检稿。",
              "",
              "楔子",
              "",
              "楔子正文，足够长的一段，用来说明它也会被当成一章来处理。",
              "",
              "第一卷 新生",
              "",
              "第1章 甲一",
              "",
              "甲一正文第一段。",
              "7",
              "甲一正文第二段。",
              "",
              "第2章 甲二",
              "",
              "甲二正文。",
              "",
              "第二卷",
              "",
              "第三章 乙一",
              "",
              "乙一正文，属于第二卷。",
              "",
              "尾声",
              "",
              "收尾正文，这一段也够长，同样当成一章来处理。",
            ];
            fs.writeFileSync(path.join(dir, "单文档", "整本.txt"), 本文.join("\n"));
            fs.writeFileSync(path.join(dir, "单文档", "整本.docx"), makeDocxBuffer(本文));
            // md 版：同样的内容，标题行写成 ## 第N章 / ## 第N卷，拆章结果要与 txt 完全一致
            fs.writeFileSync(
              path.join(dir, "单文档", "整本.md"),
              本文.map((l) => (/^(楔子|尾声)$|^第[一二三123]章\s|^第[一二]卷(\s|$)/.test(l) ? `## ${l}` : l)).join("\n")
            );
            fs.writeFileSync(path.join(dir, "平铺docx", "01卷-01章-甲一.docx"), makeDocxBuffer(["甲一平铺正文第一段。", "甲一平铺正文第二段。"]));
            fs.writeFileSync(path.join(dir, "平铺docx", "01卷-02章-甲二.docx"), makeDocxBuffer(["甲二平铺正文。"]));
            fs.writeFileSync(path.join(dir, "平铺docx", "01卷-03章-甲三.doc"), "旧版 doc 内容");
            const out = await mainWin.webContents.executeJavaScript(`(async () => {
              const get = async (p) => {
                const r = await window.api("/api/book-chapters?path=" + encodeURIComponent(p));
                return {
                  single: r.single_doc,
                  卷: (r.volumes ?? []).map((v) => v.name + "(" + v.count + ")"),
                  章: (r.chapters ?? []).map((c) => (c.vol ?? "书根") + "|" + c.publishTitle),
                  提醒: r.warnings ?? [],
                };
              };
              return JSON.stringify({
                txt: await get(${JSON.stringify(path.join(dir, "单文档", "整本.txt"))}),
                docx: await get(${JSON.stringify(path.join(dir, "单文档", "整本.docx"))}),
                md: await get(${JSON.stringify(path.join(dir, "单文档", "整本.md"))}),
                flat: await get(${JSON.stringify(path.join(dir, "平铺docx"))}),
                浏览: (await window.api("/api/browse?path=" + encodeURIComponent(${JSON.stringify(path.join(dir, "平铺docx"))}))).files.map((f) => f.name + (f.legacy ? "(旧版)" : "")),
                浏览单文档: (await window.api("/api/browse?path=" + encodeURIComponent(${JSON.stringify(path.join(dir, "单文档"))}))).files.map((f) => f.name),
              });
            })()`);
            const got = JSON.parse(out);
            for (const k of ["txt", "docx", "md", "flat"]) {
              console.log(`[selftest] ${k} single=${got[k].single} 卷=${got[k]["卷"].join(" ")}`);
              for (const l of got[k]["章"]) console.log(`[selftest] ${k} 章 ${l}`);
              for (const w of got[k]["提醒"]) console.log(`[selftest] ${k} 提醒 ${w}`);
            }
            console.log(`[selftest] 浏览 ${got["浏览"].join(" ")}`);
            console.log(`[selftest] 浏览单文档 ${got["浏览单文档"].join(" ")}`);
            const 期望章 = ["书根|第1章 楔子", "甲卷|第2章 甲一", "甲卷|第3章 甲二", "乙卷|第4章 乙一", "乙卷|第5章 尾声"];
            const ok =
              got.txt.single === true &&
              got.docx.single === true &&
              got.md.single === true &&
              got.txt["卷"].join(",") === "甲卷(2),乙卷(2)" &&
              got.txt["章"].join(",") === 期望章.join(",") &&
              got.docx["章"].join(",") === got.txt["章"].join(",") &&
              got.md["章"].join(",") === got.txt["章"].join(",") &&
              got.docx["提醒"].length === got.txt["提醒"].length &&
              got.docx["提醒"].every((w, i) => w.replace(/\d+/g, "#") === got.txt["提醒"][i].replace(/\d+/g, "#")) &&
              got.flat["章"].join(",") === "第1卷|第1章 甲一,第1卷|第2章 甲二" &&
              got.flat["提醒"].some((w) => w.includes(".doc")) &&
              got["浏览"].filter((f) => !f.endsWith("(旧版)")).length === 2 &&
              got["浏览"].some((f) => f.endsWith("(旧版)")) &&
              got["浏览单文档"].join(",") === "整本.docx,整本.md,整本.txt";
            console.log(`[selftest] 结果：${ok ? "PASS ✅" : "FAIL ❌"}`);
            app.exit(ok ? 0 : 1);
          } else {
            const text = await mainWin.webContents.executeJavaScript("document.body.innerText.slice(0, 300)");
            console.log("[selftest] 窗口加载成功，页面文本开头：\n" + text);
          }
          app.exit(0);
        } catch (e) {
          console.error("[selftest] 失败：", e.message);
          app.exit(1);
        }
      });
    }
  };

  (async () => {
    await app.whenReady();
    Menu.setApplicationMenu(null);
    loginSession().setUserAgent(UA); // 内嵌登录页用普通 Chrome UA
    globalThis.__APP_ROOT__ = DATA_DIR;
    await import("../server.mjs"); // server 监听成功后经 __ON_LISTEN__ 开主窗口
  })();

  app.on("window-all-closed", () => app.quit());
}
