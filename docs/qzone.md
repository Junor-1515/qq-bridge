# QQ 空间说说（纯文字）

想让它自己发一条说说，而不是只在群里说话。

## 现在能做什么

- **纯文字说说**，发到绑定的那个 QQ 的 QQ 空间。
- 内容**由模型按人格现写**：25 时的日常小事、做衣服/剪片子的进度、打工碎事、猫舌翻车、天台的天气、买到的碟……不是模板填空。
- **一天 1~2 条**（可配 0~12），只在活跃时段内发，两条之间随机隔一段时间。
- 配置页上有**手动发送**按钮，可以「先写一条看看」再决定发不发，也可以直接现场写一条发出去。

配置页：`http://127.0.0.1:<consolePort>/qzone?token=<令牌>`，和 `/bili`、`/tts` 互有链接。改完点保存立即生效，不用重启桥接。

## 要先填 cookie（这一步躲不掉）

OneBot 11 没有发说说的接口，SnowLuma 也没有，所以走的是 QQ 空间网页接口（`emotion_cgi_publish_v6`），必须有浏览器登录态的 cookie。

拿法：

1. 浏览器登录 <https://user.qzone.qq.com>（用要发说的那个 QQ）。
2. F12 → Application（应用）/ 存储 → Cookies → `https://user.qzone.qq.com`。
3. 全选那一整行复制（至少要含 `uin`、`skey`，有 `p_skey` 更好——g_tk 优先用 p_skey 算）。
4. 粘到配置页的「登录态（cookie）」里保存；或者存成文件（例 `state/qzone-cookie.txt`）再把路径填到「或者从文件读」。

cookie 会过期。发失败报「未登录 / code:-3000」就回浏览器重新复制一次。

桥接每 30 分钟自己探一次（拉一条自己的说说看 code），掉了会往 QQ 发一句提醒（默认发配置里第一个群），同一个状态 6 小时内只提醒一次。配置页「登录态（cookie）」下面有「立即检测」按钮。想看当前状态就 `GET /api/qzone/settings` 的 `auth` 字段，手动探一次是 `POST /api/qzone/auth-check`。

```json
"notify": { "enabled": true, "key": "group:607400395", "minGapMs": 21600000 }
```

## 配置项（config.json 的 qzone 段）

```json
{
  "enabled": true,
  "cookie": "",
  "cookieFile": "",
  "dailyMin": 1,
  "dailyMax": 2,
  "activeHours": "09:00-23:00",
  "minGapMs": 3600000,
  "maxChars": 200,
  "persona": "",
  "image": {
    "enabled": true,
    "probability": 1,
    "maxWidth": 800,
    "quality": 4,
    "stickersFile": "state/stickers.json",
    "ffmpegPath": ""
  },
  "writer": {
    "enabled": true,
    "baseUrl": "https://model.jsnu.edu.cn/v1",
    "model": "deepseek-v4-flash",
    "authHeader": "authorization",
    "authPrefix": "Bearer ",
    "apiKeyEnv": "JSNU_API_KEY",
    "apiKeyFile": "",
    "apiKeyLine": "",
    "reasoningEffort": "low",
    "temperature": 0.95,
    "maxTokens": 1200
  }
}
```

| 字段 | 作用 |
|---|---|
| `enabled` | 定时发送总开关。没配 cookie 时定时器会安静跳过，不会刷失败日志 |
| `dailyMin` / `dailyMax` | 每天发几条。每天第一次判断时在区间里抽一个数当当天目标 |
| `activeHours` | 允许发布的时段，跨零点也支持（例 `20:00-02:00`） |
| `minGapMs` | 两条之间的最小间隔，实际会再随机加最多半份 |
| `maxChars` | 单条上限，超了截断 |
| `persona` | 额外要求，拼在内置提示词前面（例「最近多提绘名」） |
| `image.*` | 附图。详见上面「附图」一节 |
| `reply.*` | 回复评论。详见上面「回复评论」一节 |
| `writer.*` | 现写用的 OpenAI 兼容接口。密钥解析顺序：`apiKey` → `apiKeyFile` + `apiKeyLine` → 环境变量 `apiKeyEnv` → `~/.dsh/.credentials.yaml` → `~/.dsh/.env` |

> 换网关时注意：`reasoningEffort` 有些网关不认 `off`（会 400），用 `low` 稳。`apiKeyLine` 配的是「从凭据文件里抠哪一行 token」，写的是正则字符串，注意别在 JSON 里多转义一层。

## 接口

都给控制台用，需要 `x-console-token`（或 `?token=`）：

- `GET /api/qzone/settings` → `{ ok, settings, status }`，status 里有 `cookieReady`、`writerKeyReady`、当天目标/已发/下次时间、最近 10 条记录。
- `POST /api/qzone/settings` → 改配置（只覆盖传上来的字段），回写 config.json。
- `POST /api/qzone/preview` → `{ hint? }` 只生成不发布，返回 `{ ok, text }`。
- `POST /api/qzone/post` → `{ text? , hint? }` 给 `text` 就发这段，不给就现场写一条再发。

## 文件

- 代码：`src/qzone.js`（cookie 解析 / g_tk / 发布 / 生成）+ `src/bridge.js`（路由、定时器）
- 页面：`public/qzone.html`
- 历史：`state/qzone-posts.json`（最近 300 条，成功失败都记）
- 当天状态：`state/qzone-runtime.json`（当天目标、已发数、下次时间、上次错误）

## 附图

每条说说可以带一张图，图从**收藏表情包**里挑（就是 QQ 收藏的那套，桥接自己维护在 `state/stickers.json`，21 张，每张有备注 `localNote` 和标签）。

流程是四步，全在 `src/qzone.js`：

1. 让写作模型看一遍表情库（编号 | 备注 | 说明 | 标签），挑一张最贴的，挑不到就回 none；
2. 下载那张表情（`p.qpic.cn`）→ ffmpeg 转成宽 `maxWidth`（默认 800）的 JPEG（动图取第一帧）；
3. 传到「说说相册」：`POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=<gtk>`，form 里 `picfile` 放 base64、`base64=1`、`albumtype=7`、`refer=shuoshuo`；
4. 发说说时带上 `richtype=1` + `richval`（`albumid,lloc,sloc,type,height,width`）+ `pic_bo`（从上传返回 url 里 `bo=` 抠出来的那串）。

配图任何一步失败都不影响发文：记一条日志，退回只发文字。

新增收藏表情不用改配置——表情库是每次现读的，QQ 那边新收藏了，这里下次就能挑到（`qq_collect_sticker` 存进同一个文件）。

### 配图配置

| 字段 | 作用 |
|---|---|
| `image.enabled` | 总开关，关了就只发文字 |
| `image.probability` | 附图的概率，默认 1（每条都带）。想「有时带」就调成 0.5 之类 |
| `image.maxWidth` | 转出来的图宽度，默认 800（竖图按比例缩） |
| `image.quality` | ffmpeg 的 JPEG 质量（1~31，越小越清晰越大） |
| `image.stickersFile` | 表情库文件，默认 `state/stickers.json`（相对 qq-bridge） |
| `image.ffmpegPath` | ffmpeg 路径，留空就找环境变量 `FFMPEG_PATH`，再不行用 `<SoVITS_root>\bin\ffmpeg.exe` |

注意两件事：图会进**说说相册**、占你的相册空间；同一张表情反复用会出现重复配图，目前没有做「同一张不连用」的限制。

## 回复评论

说说下面有人评论时，桥接每隔一阵去看一眼，按人格接一句。

判断「要不要回」只看两件事（都在 `threadNeedsReply` 里，纯函数）：

1. 这串对话**最后一句不是我说的**——我回完就不追着说，等对方再开口；
2. 我在这串里回过的次数 **< `reply.maxRounds`**——超过上限就再不接，哪怕对方继续说。

「一串」指一条评论 + 它下面的楼中楼，不按说说累加。所以同一条说说下，A 的评论和 B 的评论各自算一串。

### 什么时候去看

- 每 `checkEveryMin` 分钟看一次（默认 10），只在 `activeHours` 活跃时段里；
- 两次回复之间至少隔 `minGapMs`（默认 3 分钟），防止几条评论一起涌进来时刷屏；
- 每天最多 `maxPerDay` 条（默认 10），超了当天就不回了。

控制台 `/qzone` 的「回复评论」区有两个按钮：「看看有没有新评论」只列出来不回，「现在回一轮」立刻跑一轮（跳过间隔和时段，仍受每日上限约束）。

### 回复配置

| 字段 | 作用 |
|---|---|
| `reply.enabled` | 总开关，关了就完全不看评论 |
| `reply.maxRounds` | 同一串最多回几句，默认 2。0 = 一句都不回 |
| `reply.maxPerDay` | 每天最多回几条，默认 10 |
| `reply.checkEveryMin` | 每隔几分钟看一次，默认 10 |
| `reply.scanPosts` | 每次看最近几条说说的评论，默认 5 |
| `reply.maxChars` | 每条回复最多多少字，默认 120 |
| `reply.minGapMs` | 两次回复之间最小间隔，默认 180000（3 分钟） |
| `reply.replyOwn` | 要不要回**自己账号**发的评论（默认 true，方便自己测试；平时可以关） |

### 被挡了会怎样

回复接口会间歇性回 `code=-10049 使用人数过多，请稍后再试`——这是空间侧的限流，不是参数错了（同一个请求换个时间就过）。所以：

- 一轮里只要有一条失败，剩下的就**不再试**，避免整批一起撞墙；
- 记下失败次数，按 10 / 20 / 40 / 80 / 120 分钟退避再试，成功后清零；
- `state/qzone-reply-state.json` 里的 `lastError` 会留着最后一次的原始报错，控制台也显示。

另外两个坑：

- 空间接口回的是 HTML 包 JSONP（`frameElement.callback({...})`），**不能**用「砍掉第一个括号之前」的办法解析——前面 `catch(e){...}` 里还有括号。要用最后一个 `callback(` 往后配平花括号取对象。
- `commentUin` 填**被回复那条评论的作者**，不是自己；填错在部分情况下会退化成 -10049。

### 接口

发回复走 `POST emotion_cgi_addreply_ugc`（form-urlencoded）：

```
uin / hostUin      自己的 QQ
topicId            {自己的QQ}_{说说的tid}
commentId          被回复那条评论的 tid（评论楼里叫 tid，别和说说的 tid 混）
commentUin         回复者（自己）
content            回复正文
private=0 with_fwd=0 to_tweet=0 code_version=1 format=fs qzreferrer=...
```

看评论用 `emotion_cgi_msglist_v6`（参数 `replynum=20` 才会带评论）：说说的 `commentlist[]` 是评论，每条下面的 `list_3[]` 是楼中楼；评论/回复的 id 都在 `tid` 字段，时间在 `create_time`（秒）。

## 接口细节（踩过的坑）

- 端点：`POST https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=<g_tk>`
- 请求体是 form-urlencoded，**内容字段名是 `con`**，不是 `content`。写 `content` 会回 `{"code":-10005,"message":"您未输入内容，随便写点什么吧","subcode":-4004}`，放 query 里也一样不认（2026-11-01 实测）。
- `g_tk` 用 `p_skey`（没有才用 `skey`）按 djb2 算：`hash = 5381; hash += (hash<<5) + charCode`，最后 `& 0x7fffffff`。
- 成功返回 `{"code":0,...,"feedinfo":"..."}`；`code:-3000` 基本就是 cookie 失效。

## 已知限制

- **只有纯文字**。发图要两步：先 `up.qzone.qq.com` 上传拿 `lloc` / `sloc` / 尺寸，再在发布 body 里带 `pic_bo` 引用；上传接口对 `qzonetoken`、`referer`、`origin` 很敏感，少一个就 403，图还会进一个「说说相册」。需要再单独做。
- 接口是网页版用的那套，**风控比 OneBot 敏感**。它不保证不被判异常，账号安全自己评估；出验证码就停手等一等。
- cookie 过期没有自动续期；失效提醒见上面「要先填 cookie」那节的 notify（每 30 分钟探活 + QQ 提醒），但 **解决方式仍然是人工重新复制一次 cookie**，程序拿不到新登录态。
- 定时器不补发：错过的时间点不会在启动后立刻补，重新排下一次。
