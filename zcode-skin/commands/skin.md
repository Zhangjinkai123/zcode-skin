---
description: 给 ZCode 桌面端换背景壁纸或调整壁纸参数
---

处理用户对 ZCode 桌面端背景壁纸的请求。CLI（`zcode-skin.mjs`）随本插件分发，位于插件根目录，即本命令文件所在目录的上一级；用 `node <cli> <子命令>` 运行。完整命令表、工作原理与交互约定见本插件自带的 `zcode-skin` 技能（SKILL.md），以其为准。

用户参数解析后的可执行操作：

- 设置壁纸：`node <cli> apply <图片绝对路径>`（可选 `--blur 0-30` 模糊、`--dim 0-100` 压暗、`--fit cover|contain`）
- 只调参数：`node <cli> adjust --blur 8 --dim 30`
- 恢复官方界面：`node <cli> reset`
- 查看状态：`node <cli> status`（CDP 离线时会给出原因与修复建议）
- 修复快捷方式：`node <cli> repair-launchers --check` 预览，去掉 `--check` 实际写入（给快捷方式补调试端口，防止 ZCode 更新后主题丢失）
- 让主题在刷新/新窗口后保持：`node <cli> watch`（后台守护）；`watch --stop` 停止

约定：

1. 图片路径必须是绝对路径；如果用户只给了文件名，先在常见图片目录（桌面、下载、图片）里找到它，找不到再问。
2. apply 若报 "ZCode 正在运行但没有调试端口"，告知用户需要重启 ZCode 才能注入，由用户自己决定是否执行 `node <cli> relaunch --yes`（会强制结束 ZCode，未保存的会话内容会丢失——必须先向用户确认）。
3. 完成后用一句话报告结果（应用到几个窗口、当前 blur/dim/fit），并建议运行 watch 保持主题。
