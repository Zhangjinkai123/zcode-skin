# zcode-skin — ZCode 桌面端自定义背景壁纸

给 ZCode 桌面客户端换任意自定义背景图片。通过 Chrome DevTools Protocol (CDP) 向渲染进程注入 CSS，**不修改任何 ZCode 安装文件**，ZCode 升级不受影响，`reset` 一键还原。

实现思路参考 [Logocceai/zcode-beautify](https://github.com/Logocceai/zcode-beautify)，为本机环境独立重写，零 npm 依赖（需 Node ≥ 22，内置 WebSocket）。

## 工作原理

1. ZCode 生产构建不带调试端口，`launch`/`apply` 以 `--remote-debugging-port=9222` 启动 ZCode（检测到已有无端口实例时会提示用 `relaunch --yes`，不会擅自杀进程）。
2. 经 CDP 向每个渲染窗口注入一段幂等 bootstrap 脚本：
   - `html/body` 背景透明化 + ZCode 的 `--color-*` 语义变量改为半透明（亮/暗色两套，按 `theme-zai-light/dark` 区分），壁纸得以透出；
   - 一层固定定位壁纸（cover / contain 两种取景），可叠加模糊与压暗；浅色主题下可改用白色提亮层（`--brighten`）；
   - contain 模式自动垫一层同图高斯模糊背景。
3. `watch` 守护进程保持 CDP 会话并每 3 秒轮询：页面刷新、新窗口、配置改动都会自动同步主题。

## 快速开始

```bash
cd <本插件目录>

# 设置壁纸（ZCode 需以调试端口运行；未运行会自动带端口启动）
node zcode-skin.mjs apply D:\pictures\wall.jpg --blur 6 --dim 30

# 让主题在刷新/新窗口后保持，并可开机自启
node zcode-skin.mjs watch
node zcode-skin.mjs autostart

# 一键还原官方界面
node zcode-skin.mjs reset
```

首次使用如果 ZCode 已经在运行（无调试端口），需要完全退出 ZCode 后执行一次：

```bash
node zcode-skin.mjs relaunch --yes   # 会结束当前 ZCode 进程，注意保存会话内容
```

推荐再做一次 `node zcode-skin.mjs repair-launchers`（先 `--check` 预览）：它给桌面/开始菜单/任务栏钉选的 ZCode 快捷方式补上调试端口参数。**ZCode 更新器会用不带参数的快捷方式覆盖开始菜单项**，这是"重启后主题丢失"的最常见根因；补过之后，日常直接点快捷方式启动即可，配合 `watch` + `autostart` 主题全程自动恢复。

## 命令一览

| 命令 | 说明 |
|---|---|
| `apply <图片>` | 应用壁纸，可选 `--blur 0-30`、`--dim 0-100`、`--brighten 0-100`（浅色主题提亮）、`--fit cover\|contain`、`--port` |
| `adjust` | 只调参数不换图，参数同上 |
| `reset` | 移除注入、清空壁纸配置 |
| `launch` | 启动带调试端口的 ZCode |
| `relaunch --yes` | 结束当前 ZCode 并以调试端口重启（显式确认才执行） |
| `watch` / `watch --stop` | 后台守护 / 停止 |
| `autostart` / `autostart --off` | Windows 开机自启 watch（写入启动文件夹 VBS） |
| `repair-launchers` / `--check` | 给 ZCode 快捷方式追加调试端口参数 / 只预览不修改 |
| `selftest` | 黑盒自测：起无头 Edge/Chrome 渲染进程跑完整链路（注入/透明化/幂等/刷新恢复/reset/截屏），不触碰正在运行的 ZCode |
| `status` | 配置、watch、CDP、窗口一览；CDP 离线时给出原因与修复建议 |
| `print-css` | 调试：输出将注入的 CSS |

配置与壁纸副本在 `~/.zcode/cli/plugins/data/zcode-skin/`；watch 日志 `watch.log`。

## 作为 ZCode 插件安装（分发）

本插件随附一份本地插件市场目录：拿到的发布包（或 Git 仓库）解压/克隆到任意位置后，**把包含 `marketplace.json` 的那个目录**作为市场根目录使用：

1. ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace**，粘贴该目录的完整路径并添加。
2. 进入 **个人 → ZCode 壁纸换肤**，点 **安装**（后续更新也在同一入口点 **更新**）。
3. 安装后获得 `/skin` 斜杠命令与 `zcode-skin` 技能：直接对话说"给 ZCode 换个壁纸"即可，agent 会代为调用内置的 CLI。

发布包结构：

```
<市场根目录>/
├── marketplace.json        # 市场目录清单（名称、版本、插件入口）
└── zcode-skin/             # 插件本体（CLI、/skin 命令、zcode-skin 技能）
    ├── zcode-skin.mjs
    ├── commands/skin.md
    ├── skills/zcode-skin/SKILL.md
    └── .zcode-plugin/plugin.json
```

前置条件：机器上装有 Node ≥ 22（插件内 CLI 零 npm 依赖）。管理已安装插件请进 **Settings → Plugins**。

## 已知限制

- `dim`/透明度基于 ZCode 当前版本的 `--color-*` 变量名，官方大版本改名后需同步调整 `buildCss`。
- 图片以 data URI 内联注入，超过 20MB 会拒绝；建议压缩后使用。
- `relaunch` 会强杀 ZCode 进程（ZCode 关窗即驻留托盘，普通关闭不退进程）。
