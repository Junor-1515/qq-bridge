# 可选 DSH 插件

这里两个包都是 **可选组件**：qq-bridge 本体启动不依赖它们。只想让桥接转发消息，可以先不装；要用 QQ 专用 agent preset，或想从 DSH 设置页切换桥接模式，再按需安装。

| 组件 | 作用 | 不装会怎样 |
| --- | --- | --- |
| [qq-agent-presets](qq-agent-presets/README.md) | 两个 DSH agent preset：`qq-chat` / `qq-chat-v2`，附带 `qq-tool-restrict` 安全守卫 | 默认 `agentPreset: qq-chat` 找不到，需要改配置或自己提供 preset |
| [qq-mode-console](qq-mode-console/README.md) | DSH host 插件，注册 `qq-mode` 设置命名空间 | 仍可用 `config.json` / 控制台切模式，只是 DSH 设置页没有这一项 |

## 安装

`node scripts/setup-dsh.mjs` 会把这里两个目录链到 `~/.dsh/plugins/`，再注册进 DSH profile；也可以照各自 README 手动 `link:`。

## 版本

根目录的 `scripts/bump-version.mjs` 会同时 bump 根包和 `plugins/*/package.json`，所以三处版本始终一致。
