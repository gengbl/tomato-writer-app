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
npm run build:app:win     # Windows 免安装 exe（dist-app/tomato-writer-app.exe）
npm run build:app:linux   # Linux AppImage
npm run build:exe         # 控制台单文件版（需 bun）
```

## CI

推送 `v*` 标签（如 `v0.1.0`）自动构建 Windows exe 与 Linux AppImage 并发布到 GitHub Release；普通 push 仅产出构建产物供下载验证。
