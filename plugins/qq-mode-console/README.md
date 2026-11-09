<p align="center">
  <img src="../../assets/banner.svg" alt="qq-mode-console" width="100%">
</p>

<h1 align="center">qq-mode-console</h1>
<p align="center"><strong>把 QQ 桥接的运行模式暴露成 DSH 设置命名空间。</strong></p>

<p align="center">
  <a href="https://github.com/Junor-1515/qq-bridge/releases"><img alt="release" src="https://img.shields.io/github/v/release/Junor-1515/qq-bridge?style=flat-square&color=ff8fc7"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-7dd3fc?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.1--rc.2-6d5efc?style=flat-square">
</p>
<p align="center">
  <a href="#它做什么">它做什么</a> ·
  <a href="#安装">安装</a> ·
  <a href="#设置项">设置项</a> ·
  <a href="#为什么需要它">为什么需要它</a> ·
  <a href="#版本">版本</a>
</p>

---

> 这是 [qq-bridge](../../README.md) 的**可选组件**。桥接本体不依赖它；想用 DSH 设置页读写 `qq-mode` 时再装。

## 它做什么

这是一个 **DSH host 插件**，只做一件事：注册 `qq-mode` 设置命名空间，让 DSH 设置页/设置 API 能读写 QQ 桥接的运行模式和 ownerQQ。

- 没有 WebUI 卡片，也不改 DSH 前端。
- 桥接进程通过 DSH settings API 读写这个命名空间；控制台切模式时也会写回这里。
- 命名空间能写的前提是：loader entry 的 `id` 必须等于命名空间名（`qq-mode`），且 `Config` 至少有一个带 `volatile` 标记的字段。两条都在本包里处理好了。

## 安装

在 **DSH profile 的 `package.json`** 里加：

```json
{
  "dependencies": {
    "qq-mode-console": "link:C:/Users/<you>/.dsh/plugins/qq-mode-console"
  }
}
```

同步依赖后重启 DSH。设置 API 的 `settings/describe` 里会出现 `qq-mode` 命名空间。

> 在本仓库里源码就在 `plugins/qq-mode-console/`；`node scripts/setup-dsh.mjs` 会自动把它链到 `~/.dsh/plugins/qq-mode-console`。

## 设置项

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | `chat` / `closed-agent` / `reserved` / `reserved2` / `simulation` | 桥接运行模式；`simulation` 是 `reserved2` 的规范别名 |
| `ownerQQ` | string | 管理员 QQ；留空表示不通过 DSH 设置覆盖 `config.json` |

默认 `mode = reserved2`，不改变已有用户行为。

## 为什么需要它

DSH 0.1.7 起设置命名空间由 loader entry 推导，不再调用 `ctx.settings.register()`。如果 entry id 和命名空间不一致，桥接写设置会一直报：

```text
No configurable plugin entry "qq-mode"
```

模式只在本地生效，下一次 DSH 轮询就被覆盖回去。本包用 `cordis.patch.yml` 把 entry id 固定成 `qq-mode`，并用 `Config` 暴露可写的 volatile 字段，解决这个错位。

> DSH 0.2.0+ 下 `apply()` 是空操作，命名空间照样出现、照样可写；这是预期行为，不是没装好。

## 版本

本组件跟随 qq-bridge 主仓库统一发版：推送到 `main` 后，GitHub Actions 会把根包和 `plugins/*` 的版本一起 bump，并提交 `chore(release): ... [skip version]`。想跳过某次自动 bump，在 commit message 里写 `[skip version]`。

## License

MIT

---

本组件随 [qq-bridge](../../README.md) 一起发布。
