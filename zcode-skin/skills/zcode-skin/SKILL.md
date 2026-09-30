---
name: zcode-skin
description: 给 ZCode 桌面端设置、调整或还原自定义背景壁纸。当用户想换 ZCode 背景、设置壁纸、调壁纸模糊/透明度，或想恢复 ZCode 官方界面时使用。
---

# ZCode 桌面端壁纸（zcode-skin）

CLI 是本插件自带的 `zcode-skin.mjs`（下称 `<cli>`），零依赖，要求 Node >= 22。它位于插件根目录，即**本 SKILL.md 所在目录的上一级**：若技能加载时注入了 Base directory（`…/zcode-skin/skills/zcode-skin`），则 `<cli>` 为 `<Base directory>/../../zcode-skin.mjs`。先确认该文件存在再调用；找不到时不要猜缓存路径，改从用户安装本插件的来源目录查找。调用方式 `node <cli> <子命令>`。

## 命令

| 目的 | 命令 |
|---|---|
| 设置壁纸 | `node <cli> apply <图片绝对路径> [--blur 0-30] [--dim 0-100]（仅暗色主题） [--brighten 0-100]（仅浅色主题，白层提亮） [--light-dim 0-100]（仅浅色主题，压暗） [--fit cover\|contain]` |
| 调整参数（不换图） | `node <cli> adjust --blur 8 --dim 30 --light-dim 6` |
| 还原官方界面 | `node <cli> reset` |
| 启动带调试端口的 ZCode | `node <cli> launch` |
| 重启 ZCode 并恢复注入 | `node <cli> relaunch --yes`（会结束当前 ZCode 进程，需用户确认） |
| 后台保持主题 | `node <cli> watch`；停止：`node <cli> watch --stop` |
| 开机自启 watch（Windows） | `node <cli> autostart`；取消：`node <cli> autostart --off` |
| 修复快捷方式（加调试端口） | `node <cli> repair-launchers --check` 预览；去掉 `--check` 实际写入 |
| 查看状态 | `node <cli> status`（CDP 离线时会给出原因与修复建议） |

## 工作原理与约束

- 通过 `--remote-debugging-port=9222` 启动 ZCode，再经 Chrome DevTools Protocol 向渲染进程注入 CSS（背景透明化 + 壁纸层 + 压暗/模糊）。不修改任何 ZCode 安装文件。
- ZCode 已在运行但**没有**调试端口时，apply 会失败并提示用 `relaunch --yes`。relaunch 强制结束 ZCode（未保存的会话内容丢失），必须先征得用户同意，绝不自动执行。
- watch 守护进程每 3 秒轮询，配置改动（apply/adjust）后约 3 秒内自动同步到所有窗口，页面刷新、新窗口、重启 ZCode（若以调试端口启动）都会自动恢复主题。
- 配置与壁纸副本存放在 `~/.zcode/cli/plugins/data/zcode-skin/`；日志 `watch.log`，排障先看它和 `status`。

## 交互约定

- 用户给图后直接 apply；找不到文件就先搜常见目录（桌面/下载/图片），再找不到才问。
- 应用成功后报告：应用到几个窗口、当前 blur/dim/fit，并建议 `watch`（或 `autostart`）保持主题。
- 用户说"恢复原样/取消壁纸"就是 `reset`。
