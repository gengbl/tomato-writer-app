// 番茄小说发布工具 —— Electron 应用入口（应用内窗口版）
//
// 与 console 版（bun 单文件 exe）共用同一套 server.mjs 业务代码：
//   - 主窗口直接加载 http://127.0.0.1:PORT 的工具界面，用户无需再开浏览器
//   - 「登录番茄账号」不弹新窗口：登录页内嵌在「登录状态」页下方（<webview> 标签），
//     扫码成功后内嵌区自然跳转到已登录的番茄作家后台首页
//   - server.mjs 通过 globalThis.__LOGIN_DRIVER__ / __ON_LOGIN_ATTACH__ / __ON_LISTEN__ / __APP_ROOT__ 接入
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, session, webContents } from "electron";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
// .env / web-state.json 存放处：打包版在 exe 旁边（整目录拷走即带走登录状态），开发模式在 web/ 下。
// 注意 AppImage 的 process.execPath 在临时挂载目录（退出即销毁），要用 APPIMAGE 变量取真实文件位置
const exeDir = app.isPackaged ? path.dirname(process.env.APPIMAGE || process.execPath) : path.resolve(SELF_DIR, "..");
const DATA_DIR = exeDir;

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
            console.log(`[selftest] status: cookieOk=${s2.cookieOk} token=${s2.tokenPrefix}`);
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
            console.log(`[selftest] 退出后: cookieOk=${s3.cookieOk} token=${s3.tokenPrefix} loginPhase=${st3.phase} 会话Cookie数=${cs3.length}`);
            app.exit(s2.cookieOk && st.phase === "done" && s3.cookieOk === false && s3.tokenPrefix === null && st3.phase === "waiting" && !cs3.some((c) => c.name.startsWith("sessionid")) ? 0 : 1);
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
