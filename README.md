# tomato-writer-app

番茄小说本地发布工具：扫码登录作家后台、查看/创建书籍、从本地目录加载章节（articlewriter 嵌套结构或平铺 md/txt）并批量发布。Electron 应用内窗口，无需浏览器。

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
npm run build:exe         # 控制台单文件版（需 bun）
```

## CI

**只有推送 `v*` 标签（如 `v0.1.5`）或在 Actions 里手动触发时才构建**，自动产出 Windows exe 与 Linux AppImage，并创建 GitHub Release（附两个安装包 + `使用说明.md`）。日常 push 到 main 不触发打包。
