# ZCode Skin — ZCode 桌面端自定义背景壁纸

A single-file ZCode desktop plugin that sets a custom wallpaper via CDP injection — blur, dimming and watermark hiding included, no app files touched.

给 ZCode 桌面客户端换任意自定义背景图片：通过 Chrome DevTools Protocol (CDP) 向渲染进程注入 CSS，**不修改任何 ZCode 安装文件**，ZCode 升级不受影响，一条命令还原。支持模糊/压暗/取景模式调节、隐藏欢迎页 Logo 水印、刷新与新窗口后自动恢复主题。

## 安装（插件市场）

前置条件：装有 [Node.js](https://nodejs.org/) ≥ 22（本插件零 npm 依赖）。

1. 打开 ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace**，粘贴本仓库地址：

   ```
   https://github.com/Zhangjinkai123/zcode-skin
   ```

2. 进入该市场，安装 **ZCode 壁纸换肤（ZCode Skin）**。
3. 安装后即可直接对话（如"给 ZCode 换个壁纸，压暗一点"）或使用 `/skin` 斜杠命令。

## 直接用命令行（不装插件）

本仓库 `zcode-skin/zcode-skin.mjs` 是零依赖单文件 CLI，复制出来单独跑也行：

```bash
# 应用壁纸（ZCode 未以调试端口运行时会自动带端口启动）
node zcode-skin.mjs apply D:\pictures\wall.jpg --blur 6 --dim 30

# 让主题在刷新/新窗口后保持，可开机自启
node zcode-skin.mjs watch
node zcode-skin.mjs autostart

# 一键还原官方界面
node zcode-skin.mjs reset
```

首次使用若 ZCode 已在运行（无调试端口），需完全退出 ZCode 后执行一次 `node zcode-skin.mjs relaunch --yes`（会结束当前进程，注意保存会话内容）。

## 常用参数

| 参数 | 说明 |
|---|---|
| `--blur 0-30` | 背景模糊半径（px），0 为完全清晰 |
| `--dim 0-100` | 背景压暗百分比，低一点更透亮 |
| `--fit cover\|contain` | 铺满裁切 / 完整显示（contain 自动垫同图高斯模糊背景） |
| `--port N` | 调试端口，默认 9222 |

更多命令（`launch` / `relaunch` / `repair-launchers` / `selftest` / `status` 等）见 [zcode-skin/README.md](zcode-skin/README.md)。

## 工作原理

ZCode 生产构建不带调试端口，本工具以 `--remote-debugging-port` 启动它（或修复快捷方式自带端口），再经 CDP 向每个渲染窗口注入一段幂等 bootstrap：背景与 Tailwind v4 `--color-*` 语义变量透明化 + 固定定位壁纸层（含模糊/压暗），`watch` 守护进程每 3 秒轮询，页面刷新、新窗口、配置改动都自动同步。全程不改安装文件，卸载即 `reset`。

## 已知限制

- 透明化基于 ZCode 当前版本的 `--color-*` 变量名，官方大版本若改名需同步调整 `buildCss`。
- 壁纸以 data URI 内联注入，超过 20MB 拒绝；建议压缩后使用。
- `relaunch` 会强杀 ZCode 进程（ZCode 关窗即驻留托盘，普通关闭不退进程）。

## License

MIT
