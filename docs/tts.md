# 语音合成（TTS）

桥接内置的文字转语音：文字回复照常是中文，语音条的语言由「音色」决定（日语会先翻译再合成）。

## 两个功能

1. **点名朗读（功能一）**：聊天里让它读某段文字，它会调用 `qq_speak` 发一条语音。
   - 路由：`POST /api/socialV2/tts-say`（MCP 工具 `qq_speak` → 该路由）
   - 太长会截断：`tts.explicit.maxChars`（默认 300）
   - 开关：`tts.enabled` 与 `tts.explicit.enabled`
   - 指定语言读：对方明确说「用日语读」/「用中文读」时，`qq_speak` 传 `lang:"ja"` / `"zh"`。**不换音色、不换模型**，只把文字翻成那种语言再念（合成时 `text_lang` 跟着文本走，参考音频还是这个音色自己的）。`tts.langVoices` 只有你确实想换一副嗓子时才填；填同一个 id 就等于完全不换。没明确说就别传 `lang`。
   - 名字读音：翻译提示词里写死了「晓山瑞希」→「暁山みずき」（あきやま みずき，平假名写死防止被读错），不许写成 みつき；网名 Amia 保留原文。
   - 先有一句话再念：`tts.explicit.leadInMs`（默认 90000，0 = 不检查）。窗口内这个会话没发过普通文字消息，`qq_speak` 会直接打回，让 agent 先回一句——和 bili「先回一句再甩视频」是同一条规矩，语音自然排在文字后面。自动语音不走这条。
2. **自动跟一条（功能二）**：它每说 N 段话就有概率在后面补一条语音。念什么语言由「默认语言」决定（`tts.auto.lang`：空 = 跟当前音色，`zh` / `ja` = 固定；跟音色语言不同时先把文字翻过去）。按会话覆盖里也能单独设一档。
   - 「一段」= **拆分前整段回复**（不是拆开发出去的每一条），读的也是整段，避免文音错位
   - 计数到 `minSegments~maxSegments` 之间随机值时掷骰子，命中概率 `probability`
   - 还有最短间隔、字数上下限、每日上限
   - 自动语音**不占** `socialV2.voice` 的每分钟 2 条 / 每小时 10 条额度

## 引擎

| 引擎 | 说明 | 需要 |
| --- | --- | --- |
| `sapi` | Windows 自带 System.Speech，离线、免费、音色机械 | 无 |
| `sovits` | GPT-SoVITS 本地服务（api_v2 的 `/tts`），能克隆音色、按情绪换参考音频 | 显存 + 常驻服务 |
| `edge` | edge-tts（微软云端），音色自然但克隆不了 | `pip install edge-tts` + 联网 |

一个音色一条记录，字段见 `tts.voices[]`：`id / label / engine / lang(zh|ja|auto)`，
SoVITS 还有 `baseUrl / apiFlavor / promptText / promptLang / speed / refAudio`，
SAPI 有 `sapiVoice / sapiRate`，edge 有 `edgeVoice`。

## 日语：翻译而不是硬读

日语模型读中文音会全歪，所以日语音色 + 中文原文时，先走一层翻译：

- 接口：OpenAI 兼容（默认 `https://model.jsnu.edu.cn/v1`，模型 `deepseek-v4-flash`）
- Key：`tts.translate.apiKeyEnv` 指定的环境变量，或 `~/.dsh/.credentials.yaml` 的 `refs.<name>`
- 提示词要求口语、不用敬语（タメ口）、保留ね・よ・じゃん 之类的语气
- 译文按 hash 缓存（`state/tts-cache/tr-*.json`），同一句不重复翻

## 参考音频与情绪

`tts.refAudios[]`：`{ id, file, note, lang, moods[], voices[] }`，moods 取值
`calm / happy / sad / angry / shy / surprised`；`voices` 可空，填了就只给这几个音色用
（不同模型串用同一条参考音频会跑调，瑞希那三条都写了 `["sovits-mzk"]`）。

挑参考音频的顺序（`selectRefAudio`）：先按 `voices` 过滤 → 同语言里挑 moods 对得上的 → 没有情绪标签的 → 该语言第一条 → 音色自带的 `refAudio`。

情绪从哪来：点名朗读用一句话里直接给的 `mood`；自动语音先按**原文**判（`guessVoiceMood` + `classifyMood`），再把 mood 传进合成层。
注意必须用原文判 —— 文本翻译成日语后中文情绪词就没了，以前就是这里断了，导致「按情绪挑参考音频」实际没生效。
上传走 `POST /api/tts/ref-audio`（base64，≤30MB），文件落在 `audio/tts/refs/`。

## 按会话覆盖

`tts.overrides` 的键是 `group:607400395` / `private:2492803440`，`*` 是所有会话的兜底档：

```json
{
  "group:607400395": { "enabled": true, "activeVoice": "sovits-ja", "auto": { "enabled": true, "probability": 0.8 } }
}
```

没写的字段跟随全局。

## 配置页

`http://127.0.0.1:3100/tts?token=<控制台令牌>`（令牌在 `state/console-token`），
和 B 站设置页 `/bili` 互相有跳转链接。保存即生效，不用重启桥接。

## 缓存与清理

生成的语音在 `audio/tts/`，文件名是参数 hash，同参数重复合成直接复用；翻译结果在 `state/tts-cache/`。
两处都由桥接**自动清理**，规则在 `config.json` 的 `tts.cleanup`：

```json
{ "enabled": true, "maxAgeDays": 7, "maxBytesMb": 500, "cacheMaxAgeDays": 7, "intervalMs": 3600000 }
```

- 超过 `maxAgeDays` 的语音删掉；剩下的总量仍超过 `maxBytesMb` 时，从最旧的开始删到上限以内。
- 翻译缓存按 `cacheMaxAgeDays` 清（文件很小，但会一直堆）。
- `audio/tts/refs/` 只删**没有任何音色引用**的旧文件；`tts.voices[].refAudio` 与 `tts.refAudios[].file` 指向的文件永远不碰。
- 桥接启动时跑一次，之后每 `intervalMs`（默认 1 小时）一次；也可以手动触发：

```
curl -X POST "http://127.0.0.1:3100/api/tts/cleanup?token=<控制台令牌>" -H "x-console-token: <令牌>"
```

`GET /api/tts/settings` 里的 `stats` 是当前文件数 / 总字节，`cleanup` 是生效中的规则，`cleanupLast` 是上一次清理删了多少。

## 接本地 GPT-SoVITS（D 盘整合包）

本机的 SoVITS 在 `<SoVITS_root>`（V4 整合包，自带 python 环境与 ffmpeg）。启动/守护脚本：

```
<workspace>\start-sovits.cmd
```

- 脚本做四件事：`cd` 到整合包目录、把 `bin`（ffmpeg）和 `env`（python）加进 PATH、`set USERPROFILE/HOME`（不然 matplotlib 报 “Could not determine home directory”）、`python api_v2.py -a 127.0.0.1 -p 9880` 循环重启。
- 首次加载模型约 60~100 秒，之后单句合成 10~30 秒（3060 Laptop，`is_half: true`）。
- 换模型改 `GPT_SoVITS\configs\tts_infer.yaml` 的 `custom` 段（`t2s_weights_path` 对 `GPT_weights_v2/*.ckpt`，`vits_weights_path` 对 `SoVITS_weights_v2/*.pth`，`version` 写 `v2`），然后重启服务。运行期也可以调 `/set_gpt_weights` 和 `/set_sovits_weights`，但桥接目前没接这两个接口。
- 参考音频要求 3~10 秒。`tts.refAudios` 的每一条除了 `file`、`lang`、`moods`，现在还支持 `promptText`（这条音频**自己的**转写）——不填就会拿音色的 `promptText` 顶上，音画对不上会跑调。
- 情绪挑参考音频的顺序：同语言里先找 `moods` 含当前情绪的，再退回 `moods` 空的那条，最后用音色自带的 `refAudio`。
- 音色记录例：`id: sovits-ja`、`engine: sovits`、`lang: ja`、`baseUrl: http://127.0.0.1:9880`、`apiFlavor: v2`。
## 瑞希的音色（mzk v2ProPlus）

工作区里那个 `mzk(v2pp).zip` 是拿瑞希训练出来的 **v2ProPlus** 模型，跑在第二个 SoVITS 实例上（端口 9881），音色 id 是 `sovits-mzk`。

- 权重：`<workspace>\models\mzk\mzk(v2pp)\mzk(v2pp).ckpt`（GPT/t2s）+ `mzk(v2pp).pth`（SoVITS）
- 代码：新版 GPT-SoVITS 在 `<workspace>\gsv`（D 盘那套整合包只认到 v4，装不了 v2ProPlus），用新代码 + 同一份 env 跑
- 配置：`gsv\GPT_SoVITS\configs\tts_infer-mzk.yaml`（version v2ProPlus、cuda、half）
- 启动脚本：`start-sovits-mzk.cmd`，自带 `:loop` 守护，进程崩了 5 秒后自己重开

**别动 .pth 的前两个字节。** v2ProPlus 的权重文件开头是两个字符的版本标记（`06`），不是 ZIP 的 `PK`——它确实"看起来"像个坏掉的 zip，但那是格式本身：

```
00 v1   01 v2   02 v3   03 v3lora   04 v4lora
05 v2Pro   06 v2ProPlus   07 v5dev-lora   08 v5turbo-lora
```

把 `06` 改成 `PK` 会让加载器退回"按大小猜版本"，猜成 v2，于是 `sv_emb` / `ge_to512` 这些 v2ProPlus 专属层被当成多余参数丢掉，模型能加载、能出声，但出来是 1 秒静音。

参考音频（都 4~6 秒，符合 3~10 秒的硬要求）：

| id | 音频 | 情绪 |
|---|---|---|
| mzk-teased | えななんのフリのせいで… | angry / surprised |
| mzk-happy | ふっふっふ、このまたのなおー… | happy / shy |
| mzk-calm | 桜が散るの見ると… | calm / sad |

自动语音没有调用方给情绪，桥接按字面猜一个（`guessVoiceMood`：笑/好累/气死/害羞/真的假的/算了 之类），挑对应情绪的参考音频。

## 服务自动拉起（tts.autostart）

本地 SoVITS 冷启动 40~100 秒，没人愿意每次手动开。桥接自己看护：

```json
"tts": {
  "autostart": {
    "enabled": true,
    "scripts": {
      "9880": "<workspace>\\start-sovits.cmd",
      "9881": "<workspace>\\start-sovits-mzk.cmd"
    },
    "intervalMs": 300000,
    "cooldownMs": 600000
  }
}
```

- 桥接启动时 + 每 5 分钟探一次 `http://127.0.0.1:<端口>/docs`，不通就用脚本拉起来（脚本自己带 :loop，崩了会重开）
- **只看看「当前真会用到的音色」**：生效音色 + 各会话覆盖里指定的音色。否则一个没在用的音色也常驻 2~3GB 显存，两个实例抢同一张 6GB 卡会让合成慢一倍
- 冷却 10 分钟，避免服务还在加载时被反复拉起

## 文字和语音的间隔

语音不能比文字早，所以间隔 = 合成耗时 - 文字发送耗时。做法是**把合成排在文字之前铺开**：

1. 模型回复一到，先做同步判断（`planAutoVoice`），中了就立刻起跑 `tts.synthesize()`
2. 文字照常发（burst 分条，几秒）
3. 文字发完再 `await` 那个已经跑了几秒的合成，把语音补上

配套的两个延迟来源：

- **翻译走 deepseek 官方**（`tts.translate.baseUrl` = `https://api.deepseek.com/v1`，1.9 秒）而不是 jsnu 网关（同一个句子 7.7 秒）。官方端点用 `x-dsh-auth-token` 头，密钥直接从 `~\.dsh\.credentials.yaml` 里按正则抠一行，不用抄进 config
- **翻译的 `reasoning_effort` 设 low**：默认档翻一句日常口语要 5~6 秒，low 档 2~3 秒
- 自动语音的字数上限压到 80（`tts.auto.maxChars`），太长的话合成的音频本身就十几秒

实测（RTX 3060 Laptop，v2ProPlus）：翻译 2 秒 + 合成 3~8 秒，端到端 4~10 秒；文字发完到语音到达通常 2~7 秒。

## 常见问题

- **没声音 / 报「没有可用音色」**：`tts.voices` 空了，或 `config.json` 的 `tts` 段没被 loadConfig 读到。
- **SoVITS 报连接失败**：服务没开，或 `baseUrl` 端口不对（默认 9880）。
- **日语出来还是中文音**：音色 `lang` 不是 `ja`，或翻译 Key 没找到（面板上会标红）。
- **qq_speak 不出现在工具列表**：MCP 由 DSH 以 stdio 启动，改完 `mcp-snowluma-safe.js` 要重启 DSH。
