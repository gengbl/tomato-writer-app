# tomato-writer-app

番茄小说本地发布工具：扫码登录作家后台、查看/创建书籍、从本地加载章节并批量发布。支持三种读取模式——articlewriter 嵌套目录、平铺 md/txt（`01卷-03章-标题` 这类卷前缀）、**整本一个文档**（按「第N章」拆章）；**三种模式都能直接读 Word（.docx）**。支持**卷模式**（`卷.md`/卷目录/文档里的「第一卷」标记，自动与番茄的卷对照、改名、建卷）。Electron 应用内窗口，无需浏览器。

## 开发

```bash
npm install
npm start        # 控制台模式（浏览器打开 UI，登录走系统 Chrome）
npm run app      # Electron 应用模式（应用内登录/首页）
```

## 打包

```bash
npm run build:app:win     # Windows 免安装 exe（dist-app/tomato-writer-app-<版本>.exe）
npm run build:app:linux   # Linux AppImage（dist-app/tomato-writer-app-<版本>.AppImage）
npm run build:app:mac     # macOS dmg（arm64 + x64）——需在 macOS 上跑；非 Mac 上用 build:app:mac:local 出 zip
npm run build:app:mac:legacy # 老 Mac 兼容 dmg（x64，macOS 10.15 Catalina，固定 Electron 32.3.3）；非 Mac 上用 build:app:mac:legacy:local 出 zip
npm run build:exe         # 控制台单文件版（需 bun）
```

## CI

**只有推送 `v*` 标签（如 `v0.1.5`）或在 Actions 里手动触发时才构建**，自动产出 Windows exe、Linux AppImage、macOS dmg（arm64 + x64，需 macOS 12+）+ 老 Mac 兼容 dmg（x64，macOS 10.15+），并创建 GitHub Release（附安装包 + `使用说明.md`）。包未购买苹果证书、CI 上做 ad-hoc 签名，Mac 首次打开需右键「打开」。日常 push 到 main 不触发打包。
