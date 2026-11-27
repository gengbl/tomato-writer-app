# AGENTS.md — 协作约定

## 构建与发布（最高优先级，务必遵守）

1. **GitHub 上只在打标签时构建。** `.github/workflows/build.yml` 的触发条件只有 `push tags: v*` 和 `workflow_dispatch`——推代码（main / PR）**不触发打包**。因此平时推 `main` 只同步源码，不会跑 CI、不产生产物。
2. **构建一律优先本地。** 日常验证、试打包都在本机做（产物在 `dist-app/`，已被 `.gitignore` 排除，不入库）。CI 只用于发版时产出 Windows/Linux 正式版。
3. **改完代码就本地打包**（不用等指令）：每次功能改动或修复验证通过后，立刻 `npm run build:app:win` + `npm run build:app:linux` 重打两个包（版本号不动），再对新 AppImage 跑一次 `TOMATO_SELFTEST` 自检确认打包版可用。
4. **提交 / 推送 / 打标签要等指令。** 只有 GitHub 发版（打 `v*` 标签）必须用户明确下达指令；打标签前才允许升版本号。日常改代码 + 本地打包都不提交、不推送、不打标签。

### 本地构建命令

```bash
npm run build:app:win     # → dist-app/tomato-writer-app-<版本>.exe（Windows portable）
npm run build:app:linux   # → dist-app/tomato-writer-app-<版本>.AppImage（Linux）
npm run build:exe         # 备用控制台版单文件 exe（bun，需 /tmp/opencode/bun-tool 的 bun）
```

产物命名统一 `tomato-writer-app-<版本号>.exe` / `.AppImage`：只用 ASCII，不要中文文件名（Release/网盘附件名会被非 ASCII 弄坏）。

使用说明的唯一正本是仓库根目录的 `使用说明.md`（入库）：改功能要同步更新它；本地打包随包分发时 `cp 使用说明.md dist-app/`。

### 版本号规则

**只有要发布 GitHub 版本时才改版本号**（改 `package.json` + `package-lock.json`），平时改代码、本地打包都保持当前版本号不动——本地临时包就用上一个已发布版本号命名，不要自己升 patch 号。

### 发布（仅在用户明确要求时）

- 仓库内容：源码 + `使用说明.md`（入库，因为 GitHub Release 附件要用它）+ 工作流；不上传 `node_modules/`、`dist/`、`dist-app/`、`使用说明.pdf`、`*.zip`、`.env`
- Release 附件 = `tomato-writer-app-<版本>.exe` + `tomato-writer-app-<版本>.AppImage` + `tomato-writer-guide.md`（由仓库根的 `使用说明.md` 复制而来，**附件名必须 ASCII**：实测中文附件名会被 GitHub 弄成 `default.md`）；release job 必须 `actions/checkout`，否则工作区里没有 `使用说明.md`
- 流程：改 `package.json` 版本（同步 `package-lock.json`）→ commit → `git push origin main`（不触发 CI）→ `git tag vX.Y.Z && git push origin vX.Y.Z`（这一步才触发 GitHub 构建 + 建 Release）
- 本机推送需绕过坏掉的隧道：仓库已配 `core.sshCommand = "ssh -o ProxyCommand=none"`，手动推送用 `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push ...`

## 仓库与代码约定

- 单文件后端 `server.mjs`（HTTP 接口 + 番茄 API 封装）、单文件前端 `index.html`（无框架、无打包）、入口 `electron/main.mjs`
- 数据文件（`.env`、`web-state.json`、`app.log`）放 `ROOT`，**三种跑法 ROOT 不同，别搞错**：
  - 打包版（exe/AppImage）：exe 所在目录 → `dist-app/`（AppImage 用 `APPIMAGE` 变量取真实路径，不能用 `process.execPath`，那是临时挂载点）
  - Electron 开发模式（`npx electron .`）：仓库目录 → `tomato-writer-app/.env`（`electron/main.mjs` 里 `DATA_DIR = electron/..`）
  - 独立跑 `node server.mjs`（控制台版/调试）：仓库上级目录 → `/home/fosky/workspace/.env`
- **`.env` 是扫码登录得到的凭证（Cookie / CSRF Token），绝不能删、不能覆盖**：删了就得重新扫码。现存三处（对应上面三种 ROOT）：`dist-app/.env`、`tomato-writer-app/.env`、`/home/fosky/workspace/.env`。跑 `TOMATO_SELFTEST` 需要登录态时**直接复用现成的 `.env`**，不要往目标目录拷文件（真要补，只允许 `cp -n` 不覆盖已存在的）；测试结束后**不清理** `.env`、`web-state.json`，也不要把它们从 `dist-app/` 里删掉
- 番茄接口没有公开文档，路径均来自作家后台前端 chunk 逆向；新接口先在 `async-main` chunk 里找 URL 常量再实现
- **凭证不回显**：界面与日志任何地方都不出现 Cookie / CSRF Token / sessionid 的内容或片段。`GET /api/status` 只返回布尔 `cookieOk` / `tokenOk`（不再有 `tokenPrefix`）；`/api/refresh-token`、登录结果只报 `ok` + 有效期 + Cookie 个数；登录诊断只报 Cookie 个数，不列 Cookie 名
- 前端调用后端一律走 `api()`；破坏性操作（删除书籍/章节）必须服务端二次校验 + 前端双重确认
- 状态一致性：登录成功或启动时已登录 → 主动拉「② 我的书籍」（表格 + ④ 目标书籍下拉）；删除 / 新建书籍后所有相关视图联动刷新（书籍表格、目标书籍下拉、合并章节表、封面跳转目标）。自检模式 `TOMATO_SELFTEST=books` 用假 `api()` 验证这条链路
- 建书界面只留必要字段（书名、频道、签约模式、分类下拉、主要角色、简介）；`activity_id`/`label_list`/封面参数不在界面出现，由 `server.mjs` 补官方默认值
- 「跳转到番茄网页」（如封面/书信息页 `https://fanqienovel.com/main/writer/book-info/<book_id>`）一律前端 `window.open`，由主进程 `setWindowOpenHandler` → `shell.openExternal` 交给系统浏览器，应用内不开新窗口
- 主要角色：界面上填「、」/逗号分隔的名字，前端 `rolesValue()` 与后端 `/api/book/create` 都会转成番茄要的 JSON 数组字符串（两端都兜，命令行直调也生效）
- 建书界面不提供封面输入：但 `thumb_uri` **是番茄必填参数**，`server.mjs` 统一兜底为官方默认图 `novel-static/7107d91219967759d105674fa8393923`（官方建书提交处也是三级兜底，从不省略），之后由用户在番茄后台换；要换默认图在 `.env` 配 `TOMATO_DEFAULT_THUMB=novel-xxx/yyy`
- 建书官方参数形态（逆向自 chunk `8034.266c0c9a.js`）：`book_name`、`roles=JSON.stringify(名字数组)`、`category=id 逗号串`、`gender`、`thumb_uri`、`abstract`、`activity_id(0)`、`is_self_pic(0)`、`label_list("")`；`activity_id` 非 0 时才额外带 `group_category_id`
- 排障通道：番茄接口非 0 一律 `logApp()` 写 `app.log`（与 `.env` 同目录），错误消息带上 `番茄 code=N` 和日志路径；界面「📄 查看诊断日志」读 `GET /api/log`；F12 / Ctrl+Shift+I 打开 DevTools（主进程 `before-input-event` 自己接的，菜单已移除故默认快捷键失效），`--devtools` 或 `TOMATO_DEVTOOLS=1` 启动即打开

## 已知坑

- 本机 npm 会拦 install scripts，装 electron 二进制要手动跑 `node node_modules/electron/install.js`
- 跑 Electron 需要 `--no-sandbox`；旧的 AppImage 残留进程会持单实例锁导致新实例静默退出（`pkill -f "[t]omato-writer"`）。注意 pkill 要和启动/构建命令**分成两条命令**跑：同一条命令的命令行里含 `tomato-writer`，`pkill -f` 会把执行命令的 shell 自己杀掉
- 番茄登录 Cookie 会过期（`.env` 里的 `TOMATO_COOKIE`），过期时接口报鉴权错，需重新走内嵌扫码登录
- 番茄 `code=-2 参数有误` = 必填参数缺失或格式不对（例：建书省略 `thumb_uri` 就这样报）。查这类问题别靠真建书试错，用**安全探测法**：`book_name` 填账号里已存在的书名 → 参数过关番茄回 `-2006 该书名已存在`（不会真建出书），回 `-2` 说明参数本身有问题
- `npx electron` 跑 `TOMATO_SELFTEST` 时**退出码不可靠**（断言 FAIL 也可能返回 0），判断结果要看日志里的 `[selftest] 结果：PASS/FAIL` 行
