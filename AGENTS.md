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
npm run build:app:mac     # dmg（arm64 + x64）——只能在 macOS 上跑（dmg 要 hdiutil），CI 用这条
npm run build:app:mac:local # 本机（Linux）交叉打 mac 包：只能出 zip，→ dist-app/tomato-writer-app-<版本>-<arch>.zip
npm run build:app:mac:legacy # 老 Mac 兼容包 dmg（x64，macOS 10.15+）——只能在 macOS 上跑，CI build-macos-legacy 用这条
npm run build:app:mac:legacy:local # 本机交叉打老 Mac 包：zip → tomato-writer-app-<版本>-x64-macos10.15.zip
npm run build:exe         # 备用控制台版单文件 exe（bun，需 /tmp/opencode/bun-tool 的 bun）
```

**macOS 打包要点**：

- `package.json` 里 `mac.target = dmg(arm64,x64)`、`artifactName = tomato-writer-app-${version}-${arch}.${ext}`（ASCII）、`identity: null`（无证书，明确跳过签名；Linux 上也只支持 skip）
- **CI（mac runner）打 dmg 时覆盖成 ad-hoc 签名**：`--config.mac.identity=-`（本机装的 electron-builder 26.18 已支持：`identity: "-"` 走 ad-hoc 分支，见 `app-builder-lib/out/mac/MacTargetHelper.js`；实测 `yargs` 只认 `identity=-`，中间**不能加空格**，`identity -` 会被解析成 `true`）。未签名包在 Apple Silicon 上下载后报「已损坏，应移到废纸篓」（右键打开也救不了，arm64 内核必须有效签名），ad-hoc 可绕开；默认 entitlements 模板已含 `disable-library-validation`，与 hardenedRuntime 默认值兼容。`build.yml` 里该步失败会 `||` 回退成完全未签名打包，保证 Release 一定有产物；本机 Linux 交叉包仍走 `identity: null`（Linux 上没有 codesign）。**此改动只能在 CI（打标签）时生效验证，本机无法验证签名**
- **dmg 只能在 macOS 上打**：本机 Linux 交叉打包只有 `zip` / `dir` 可用（`--mac zip --arm64`），产物是可用的 `.app` 压缩包，但 Release 附件用 CI（`build-macos` job，`macos-latest`）打的 dmg
- 本机打的 mac 包**只能验证包结构**（`unzip -Z` 看可执行位、`Contents/Info.plist`、`app.asar` 里含最新代码），不能在 Linux 上运行；界面与登录必须在真 Mac 上验证
- 未签名：Mac 首次打开要右键「打开」（或 `xattr -dr com.apple.quarantine`），说明文档里已写明
- 下载 Electron darwin 包偶发 600s 超时（`Timeout awaiting 'request'`），重跑同一条命令即可
- **老 Mac 兼容包（macOS 10.15 Catalina）**：Electron ≥33 不再支持 10.15（Chromium 上游砍的，跑起来缺 `UniformTypeIdentifiers` 直接 dyld 崩）、≥38 要求 macOS 12。老包固定 **Electron 32.3.3**（最后支持 10.15 的大版本），通过 CLI `--config.electronVersion=32.3.3` 覆盖，**不改仓库依赖**；只打 x64（10.15 没有 Apple Silicon）；产物名带 `macos10.15` 与新包区分（`tomato-writer-app-<版本>-x64-macos10.15.zip/.dmg`）。本机验证法：`/tmp/opencode/e32` 里 `npm i electron@32.3.3`（install script 被拦就手动 `node node_modules/electron/install.js`），用它的 `electron --no-sandbox <仓库>` 跑 `TOMATO_SELFTEST`——Electron 32 的 Linux 二进制能验证主进程/前端 API 兼容性（mac 上真实运行仍需实机）
- **数据目录按平台分流**（`electron/main.mjs`）：Win/Linux = 程序所在目录（AppImage 用 `APPIMAGE`）；macOS = `app.getPath("appData")/tomato-writer`（`.app` 内部会被更新覆盖、且不是「程序旁边」），首次运行要 `mkdirSync(DATA_DIR)`

产物命名统一 `tomato-writer-app-<版本号>.exe` / `.AppImage`：只用 ASCII，不要中文文件名（Release/网盘附件名会被非 ASCII 弄坏）。

使用说明的唯一正本是仓库根目录的 `使用说明.md`（入库）：改功能要同步更新它；本地打包随包分发时 `cp 使用说明.md dist-app/`。

### 版本号规则

**只有要发布 GitHub 版本时才改版本号**（改 `package.json` + `package-lock.json`），平时改代码、本地打包都保持当前版本号不动——本地临时包就用上一个已发布版本号命名，不要自己升 patch 号。

### 发布（仅在用户明确要求时）

- 仓库内容：源码 + `使用说明.md`（入库，因为 GitHub Release 附件要用它）+ 工作流；不上传 `node_modules/`、`dist/`、`dist-app/`、`使用说明.pdf`、`*.zip`、`.env`
- Release 附件 = `tomato-writer-app-<版本>.exe` + `tomato-writer-app-<版本>.AppImage` + `tomato-writer-app-<版本>-arm64.dmg` + `tomato-writer-app-<版本>-x64.dmg` + `tomato-writer-app-<版本>-x64-macos10.15.dmg`（老 Mac 兼容包）+ `tomato-writer-guide.md`（由仓库根的 `使用说明.md` 复制而来，**附件名必须 ASCII**：实测中文附件名会被 GitHub 弄成 `default.md`）；release job 必须 `actions/checkout`，否则工作区里没有 `使用说明.md`；`build.yml` 的 Release 附件白名单（`KEEP` 数组）要同步加新平台的产物，否则多余附件会被那步兜底删掉
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

## 卷模式（多卷上传）

**本地存储规则**（与写书计划 `卷.md` 一致，由 `server.mjs` 的 `readVolumeMd()` / `localVolumesOf()` 解析）：

- `<书根>/卷.md` 声明卷：`## vol_1` + `- 名称：新生` / `- 顺序：1` / `- 描述：…`，也认 `## 新生` 直接命名；先剥 `<!-- -->` 注释，含 `|` 的示例行（`## 卷ID | 名称 | 描述`）不算卷
- 卷实体目录 = `书根/书稿/<卷名>/第NN章-<标题>/`；`卷.md` 在书根、章节常在 `书根/书稿/` 下，所以 `readVolumeMd` 同时找 `bookDir/卷.md` 与 `bookDir/../卷.md`
- **各卷章号独立编号**（每卷从第 1 章起）；发布顺序 = 书根章节 → 各卷按 `卷.md` 的「顺序」 → 卷内按章号（`listBookChapters` 的排序即此规则）
- **有卷时发布标题按全书顺序连续编号**（`publishNum`/`publishTitle`，扁平与嵌套结构都一样）：番茄的 `chapter_index` 跨卷连续，两个卷都发「第1章」在番茄端会乱序；无卷时保持文件里的序号（原行为）

**平铺结构的卷**（`listFlatChapters`，兼容多种命名）：

- 卷前缀正则集中在 `VOL_PATTERNS` / `VOL_NUM_PAIR_RE`：`01卷-03章-标题`、`第一卷-03章-标题`、`卷二-01章-…`、`03-01-标题`（两段数字=卷号-章号）、`Vol.2-…` / `V2-…`、`<卷.md 卷名>-04章-…`
- 防误判：`第N卷` 的「卷」后面不能再跟汉字数字（否则「一卷」吞掉「第二卷」）；`N卷` 只认阿拉伯数字且「卷」后不能直接接常用字（`卷王的诞生` 不算卷）；两段数字的卷号限 1~2 位（`2020-03-xx` 不会被当卷）
- 顶层没有章节文件时把子目录当卷（卷名=目录名），`AUX_DIR_NAMES`（文档/设定/笔记…）跳过；子目录里有「第NN章-*」目录的属于嵌套结构，平铺不重复收

**番茄存储规则**（chunk 逆向 + 真实账号探测，务必照办）：

- 章节挂在书上（平铺表），每章带 `volume_id` + `volume_name`，卷只是分组；**没有移动章节 / 改章节顺序的接口**（全站搜不到 `move_article`/`order_article`）→ 章节只能追加，`chapter_index` 由番茄跨卷连续分配 → **上传顺序 = 最终阅读顺序**
- `GET /api/author/volume/volume_list/v1` 返回**倒序**（新卷在前），官方 UI 拿到后 `.reverse()`；`fetchRemoteVolumes()` 已统一成显示顺序（第 1 卷在前）
- 卷的写接口**参数只能走 query**（`apiPostQuery`）：`add_volume/v0`（`book_id`+`volume_name`）、`modify/v0`（`book_id` + `volume_data=JSON.stringify([{volume_id,volume_name},…])`，数组用**番茄原序**）；实测传 JSON body 一律 `code=-2 参数有误`
- `add_volume` 有业务限制 `code=-4054 暂不支持创建多个无章节的分卷` → **不能提前批量建卷**，必须等该卷要发第一章时再建（`ensureRemoteVolume()` 懒建）
- 本地卷 ↔ 番茄卷对照（`syncVolumes()`）：① 同名复用 ② 否则按位置认领番茄里未被认领的卷并把番茄卷**改名成本地卷名**（用户要求）③ 还多出来的卷懒建；前端 `alignVolName()` 用同一套位置认领规则对齐「改名前」的番茄卷名
- 界面：「卷对照预检」= `POST /api/volumes/sync {dry_run:1}`（只读）；发布时 `items[].local_volume` 交给服务端做对照/改名/建卷；章节匹配是**卷名 + 标题**，两级：① 完全同名 ② 去掉「第N章」前缀后同名（`chapterCore()` / 前端 `coreTitle()`），因为连续编号会改动标题，只比全文会漏配、重复追加章节；再退到「同卷 + 同章号」
- 自检：`TOMATO_SELFTEST=volumes` 用假 `api()` 验证卷展示、按「卷+标题 / 同卷同章号」对齐、卷顺序、`local_volume` 传参、卷对照预检
- 删卷：`POST /api/author/volume/delete_volume/v0/`（`book_id`+`volume_id`，**也是 query 参数**）；实测有章节的卷删除前要先删章，默认卷 `can_delete` 会变成 `false`
- 真机端到端已验证过两遍（《飞升后修系统…》那本 0 章的书）：改名番茄默认卷 → 发 2 章 → 自动建第二卷并发章 → 删章 → 删卷 → 改回原名，全部 `code=0`；第二遍用平铺命名（`01卷-01章-甲一.md`）走同一链路，并验证「改章节号后仍按标题命中已有章节、不重复追加」（章数不变、报 `-3027`）
- 番茄发章节的两道内容门槛（测试章踩到的）：太短报「章节字数不足」（`code=-2`，几十字必挂，几千字可过）；段落雷同报 `code=-3026 文章内容有大段落重复`（复制粘贴凑字数的测试文体会被拦）
- 已发布/审核中的章节不能再改：更新路径会报 `code=-3027 审核中的章节不允许修改`（删章同理受限），只能等审核结束
- 自检：`TOMATO_SELFTEST=flatvols` 用真临时目录验证平铺卷命名解析（`NN卷-NN章-标题`、中文卷号、两段数字、`卷王的诞生` 不算卷、发布标题全书连续编号）

## 上传进度与上传日志窗口

- `POST /api/publish` 带 `stream:1` → **NDJSON 流**（一行一个事件）：`{type:"start",total}` → 每章开始 `{type:"chap",i,total,title,action:"start"}` → 每章结果 `{type:"chap",i,total,ok,updated,volume,itemId,error,checks}` → `{type:"done",results}`；卷对照/建卷发 `{type:"log",text}`。**不带 `stream` 时行为完全不变**（一次性回 `{results}`），curl 老用法不受影响。
- 流已经开头发过再出错：全局 catch 必须走 `res.headersSent` 分支写 `{type:"error"}` 行，不能再调 `json()`（否则响应写两遍）。
- 前端 `apiStream(path, body, onEvent)` 解析 NDJSON（非 ndjson 响应自动退回普通 JSON）；`doPublish(bookId, items, mode, itemRows)` 的 `itemRows` 与 `items` **同序**，用来逐章定位行更新状态。
- 状态列只改那一行：`setRowState(row, kind, text)` 用 `mergedTrByKey` 找到 `<tr>` 直接写 `children[4]`，**不重建整表**（重建会丢滚动位置）；`followRowPage(row)` 把 `mPage` 切到该行所在页 + `scrollIntoView`（复选框 `chk-follow` 可关，默认开）。
- 刷新语义：`loadRemoteChapters(bookId, { keepPage, keepSel })` —— 发布/删除/「刷新章节列表」都**保留当前页、滚动位置和勾选**；只有换书（`mPageBook !== bookId`）才回第 1 页并恢复默认勾选。`buildMerged(keepSel)` 传旧的 `mSelSet` 时按 key 过滤保留。
- 上传日志窗口：`uplog()/openUplog()/closeUplog()/clearUplog()`；`#uplog-body` 默认 `height:25vh`（窗口 1/4）+ `resize:vertical`（可拖右下角）+ `overflow:auto`；追加行后仅当「本来就在底部」才 `scrollTop = scrollHeight`（用户往上翻历史时不强拉回）。
- **自检**：`TOMATO_SELFTEST=publish` —— 假 `fetch`（`ReadableStream` + `pull` 每 10ms 推一行事件，45 章）+ 假 `window.api`（卷/章节），断言逐章状态实时变化、当前页跟到最后一页、日志窗口 25vh/自动滚动/清除/关闭/重开、刷新后保留当前页与勾选。两个坑：① 自检里要先 `$("card-4").style.display = ""`，第 ④ 步卡片默认隐藏时 `clientHeight` 全是 0；② 「⏳ 上传中」是瞬间态，**别靠定时快照断言**（打包版消费快会抓不到、误报 FAIL）——用 `window.setRowState` 包一层记录出现过的文案。

## 章节来源（三种模式）与 Word 支持

`listBookChapters(路径)` 一条入口，按路径类型自动分流；`GET /api/book-chapters` 额外回 `single_doc`（是否单文档）和 `warnings`（加载提醒，界面显示在提示里）：

1. **嵌套结构**：`第NN章-标题/` 目录即一章，正文文件优先 `NN-标题.md`
2. **平铺结构**：一文件一章（`FLAT_FILE_RE` = md/txt/docx），卷前缀见上面的 `VOL_PATTERNS`
3. **单文档**：路径是**文件**时 → `listSingleDocChapters()` 按标题行拆章（txt/md/docx 都行）

**读正文一律走 `readNovelText(file)`**（三处调用点：嵌套、平铺、单文档）：

- `.md/.txt` 直读（去 BOM）；`.docx` 零依赖解析：`zipEntries()`（倒查 EOCD → 中央目录项 → 局部头）+ `zipExtract()`（`zlib.inflateRawSync`）+ `docxToText()`（`</w:p>` → 空行、`<w:br|cr>` → 换行、`<w:tab>` → 空格，其余标签删掉再解实体），只取 `word/document.xml`
- `.doc`（OLE 旧格式）**不支持**：`DOC_LEGACY_RE` 命中就报「另存为 .docx」，并通过 `warnLoad()` 在目录级提醒（`warnLegacyDocs()`），不要静默跳过
- 加密 docx（魔数 `D0CF11E0`）报「请先取消密码」

**单文档拆章规则**（`docHeading()`，改动要小心，误判会把正文切碎）：

- 只有**整行**是标题才算：行长 ≤ `DOC_HEAD_MAX`(40)；行首的 md 标记（`##`、`- `）先剥掉再判断（`## 第1章 开局` 也算标题）
- `第N章/回/节/卷`：序号后必须直接结束或跟分隔符（`第一章正文第一段。` 不算标题）；`卷` 标记只设置其后章节所属卷（卷名优先同目录/上一级 `卷.md` 声明，其次行内名字，最后 `第N卷`）
- `楔子/序章/序言/引子/前言/后记/尾声/终章/番外`：整行只有这个词（或加个短名）才算章
- 第一个标题之前的内容：≥200 字当作「前言」，否则丢弃并提醒；正文里的孤立页码行（整行只有数字）会被 `clean()` 去掉
- 有卷时发布标题按全书连续编号（与其它模式一致），章号缺失时在所属卷内按出现顺序续号

**界面**：`GET /api/browse` 除 `dirs` 外还回 `files`（`{name, legacy}`）与 `from_file`（传入的是文档路径 → 已改成列它所在目录），前端用 📄 列出可点文档（旧版 .doc 列出来但标 ⚠️ 不可点）；`from_file` 时点「浏览」不再上跳一级，避免离开文档所在目录。`isAuxDoc()` 统一排除 `卷.md`/`目录.md` 与 `-大纲`/`-场景`… 辅助文件（浏览列表与 `listFlatChapters` 都用它，否则 `卷.md` 会被当成一章）。

**自检**：`TOMATO_SELFTEST=docmode` —— 主进程用 `makeDocxBuffer()`（自己写 zip：局部头 + 中央目录 + EOCD，`zlib.deflateRawSync` + CRC32）造真 .docx，验证单文档 txt / docx / md（`## 第N章` 写法）三种拆章结果完全一致、卷归属正确、平铺 docx 可读、旧版 .doc 有提醒、`/api/browse` 的 `files` 能列出文档并把 .doc 标为 legacy。

## 已知坑

- 本机 npm 会拦 install scripts，装 electron 二进制要手动跑 `node node_modules/electron/install.js`
- 跑 Electron 需要 `--no-sandbox`；旧的 AppImage 残留进程会持单实例锁导致新实例静默退出（`pkill -f "[t]omato-writer"`）。注意 pkill 要和启动/构建命令**分成两条命令**跑：同一条命令的命令行里含 `tomato-writer`，`pkill -f` 会把执行命令的 shell 自己杀掉。同理 `pkill -f "[s]erver[.]mjs"` 与 `node --check server.mjs` 写在同一条命令里也会被杀（命令行里出现了 `server.mjs` 字样）——**pkill 一律单独一条**，查残留用 `pgrep -fa "[s]erve[r].mjs"`。另一个坑：**electron-builder 打包进行中也不能 pkill `[t]omato-writer`**——打包子进程（压缩 `tomato-writer-app-*.zip` 等）命令行同样命中，会把正在跑的打包 kill 掉（exit 143）；要清 AppImage 残留就在打包间隙做
- 番茄登录 Cookie 会过期（`.env` 里的 `TOMATO_COOKIE`），过期时接口报鉴权错，需重新走内嵌扫码登录
- 番茄 `code=-2 参数有误` = 必填参数缺失或格式不对（例：建书省略 `thumb_uri` 就这样报）。查这类问题别靠真建书试错，用**安全探测法**：`book_name` 填账号里已存在的书名 → 参数过关番茄回 `-2006 该书名已存在`（不会真建出书），回 `-2` 说明参数本身有问题
- 中文文件名会被 GitHub Release 附件名啃坏：`使用说明.md` 作为附件会变成 `default.md`（产物名同理），所以附件一律 ASCII（`tomato-writer-guide.md`）
- `softprops/action-gh-release` 的 `preremove: true` 清不掉「改名之前」的旧附件（实测 `default.md` 仍在），`build.yml` 里有个「删除不在白名单里的 Release 附件」步骤用 `secrets.GITHUB_TOKEN` 兜底删
- 本机 `api.github.com` 匿名访问限流很凶（轮询几次就 403），查 CI 状态要节制次数，或改看网页 HTML / `releases/download/...` 探测（302/200 = 附件在）
- `npx electron` 跑 `TOMATO_SELFTEST` 时**退出码不可靠**（断言 FAIL 也可能返回 0），判断结果要看日志里的 `[selftest] 结果：PASS/FAIL` 行
- `books` 自检会被「启动时已登录 → 主动加载书籍列表」的真实请求覆盖假数据，所以自检里先等 `msg-novels` 出结果再 mock（这是自检竞态，不是应用 bug）
