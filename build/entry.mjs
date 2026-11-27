// 单文件打包入口：bun build --compile 用这个文件做入口
// 1) index.html 以文本形式内嵌进可执行文件（__INDEX_HTML__，见 server.mjs）
// 2) .env / web-state.json 等数据文件改在「exe 所在目录」（__APP_ROOT__）
import path from "node:path";
import html from "../index.html" with { type: "text" };

globalThis.__INDEX_HTML__ = html;
globalThis.__APP_ROOT__ = path.dirname(process.execPath);

await import("../server.mjs");
