# MiniMax 日语朗读

应用默认使用本机声音。启用 MiniMax 后，日语朗读会把文本发送到 MiniMax 生成 AI 语音，需要联网并按当前账户的语音服务规则计费；中文讲解仍使用本机声音。

## 配置与试听

1. 登录 [MiniMax 开放平台](https://platform.minimax.cn/)，在控制台确认账户的语音合成权限、可用额度与计费方式。Token Plan 用户可查看[套餐用量与积分](https://platform.minimax.cn/subscribe/token-plan)。
2. 在平台的 API 密钥管理中创建密钥，填入应用「设置 → 更自然的日语声音 → 云端 AI 声音 · MiniMax」。密钥只保存在本机后端，不会通过设置查询返回，也不包含在应用导出的学习备份中；无需发到聊天里。
3. 选择声音、质量和语速，点击「保存并试听」或「试听短对话」。试听会先保存当前选择，缓存未命中时会发起真实合成请求，可能计费。

「密钥已配置」只表示本机已保存密钥，不代表平台接受密钥、额度充足或已试听成功。云端失败时应用会显示原因，并尝试用本机声音读完剩余内容；听到了本机声音不能作为云端验证成功的依据。本机朗读需要安装对应的日语／中文语音包。

## 模型、音色与语速

云端默认模型为 `speech-2.8-hd`，也可选择 `speech-2.8-turbo`。两者均属于官方同步语音接口支持的模型；实际自然度需用自己的学习内容试听判断。[官方接口说明](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)

应用提供以下四个精确音色 ID，均列于[官方系统音色表](https://platform.minimax.cn/docs/faq/system-voice-id)：

| 界面名称 | 音色 ID | 默认用途 |
| --- | --- | --- |
| 温柔女声 | `Japanese_KindLady` | 主声音 |
| 知性前辈 | `Japanese_IntellectualSenior` | 对话第二声音 |
| 沉静女声 | `Japanese_CalmLady` | 可选 |
| 温和管家 | `Japanese_GentleButler` | 可选 |

双声对话默认开启，按对话句子交替使用主声音与第二声音；关闭后统一使用主声音。默认速度为 `1.0`，界面提供 `0.8×`、`1×`、`1.2×`。云端实际速度为设置中的 `speed` 乘以本次朗读的 `rate`，四舍五入至四位小数后限制在 `0.5–2`；速度参与缓存匹配。

## 本机缓存

合成结果保存为本机 PCM WAV（32 kHz、16 位、单声道），位于应用数据目录下的 `voice-cache`。缓存按文本、音色、模型和最终语速匹配，并包含提供商与缓存版本。相同组合命中有效缓存时不发外部请求，因此没有重复的提供商合成费用。

受管理缓存上限为 **100 MiB**，空间不足时优先淘汰较久未使用的片段；无效音频会被丢弃。设置中的「管理已生成的声音」可查看片段数量、大小并确认清理。清理保留声音设置和学习记录，之后重新朗读可能需要再次合成和计费。更换文本、音色、模型或语速也可能产生新的合成请求。

## 本地 API 契约

以下路径是应用本机后端接口。JSON 请求使用 `Content-Type: application/json`。

| 方法与路径 | 请求／响应 |
| --- | --- |
| `GET /api/voice/settings` | 返回 `provider`、`model`、`voice`、`secondaryVoice`、`alternateSpeakers`、`speed`、`hasApiKey`；不返回密钥。 |
| `PATCH /api/voice/settings` | 接受上述设置字段的部分更新（不接受 `hasApiKey`），另可传 `apiKey`。省略密钥保持原值，传空字符串删除密钥；响应为更新后的公开设置。 |
| `POST /api/voice/synthesize` | 请求 `{ "text": "こんにちは。", "rate": 1, "speaker": "primary" }`；成功返回 `audio/wav`，响应头 `X-Voice-Cache` 为 `hit` 或 `miss`。 |
| `GET /api/voice/cache` | 返回 `{ "clips": number, "bytes": number }`。 |
| `DELETE /api/voice/cache` | 清理受管理缓存，返回清理后的 `{ "clips": number, "bytes": number }`。 |

`provider` 为 `system` 或 `minimax`，默认 `system`；其余默认值见上文。设置 `speed` 接受 `0.8–1.2`。合成文本去掉首尾空白后须为 1–1500 个字符；`rate` 接受 `0.6–1.2`，默认 `1`；`speaker` 为 `primary` 或 `secondary`，默认 `primary`。关闭双声时 `secondary` 也使用主声音。合成接口要求已启用 MiniMax；缓存未命中时还要求已保存密钥。

后端调用 MiniMax 的 `POST https://api.minimax.cn/v1/t2a_v2`，使用 Bearer 密钥、非流式日语合成与十六进制 WAV 响应，并校验业务状态和音频格式。[官方接口说明](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)

## 额度错误与验证范围

真实接口合成已验证成功：本轮改用普通 API 密钥后，`POST /api/voice/synthesize` 使用 `speech-2.8-hd`、`Japanese_KindLady` 合成「こんにちは。駅はどこですか。」，单次请求耗时 707 ms，返回 175,780 字节的 32 kHz WAV，`X-Voice-Cache: miss`。

真实浏览器验证也已完成：在正式服务上使用真实 `HTMLAudio` 播放句子、重复句子的缓存命中、对话主／次声音及 `rate: 0.65` 慢速音频。共五段均从 `playing` 到 `ended`，未出现播放错误；同一句日语正常音频长 2.728 秒，慢速长 3.669 秒。结果记录在 `test-results/minimax-live-check.json`，设置截图为 `test-results/voice-settings.png`。这些验证确认真实合成、缓存与浏览器播放流程可用；日语自然度尚未进行人工评分。

MiniMax 即使返回 **HTTP 200**，响应内的 `base_resp.status_code` 仍可能表示失败。此前探测曾得到 **2056（额度失败）**，应用将其映射为 `VOICE_QUOTA_EXCEEDED`（HTTP 503）；本轮 Token Plan 相关探测仍得到 **2062（无有效订阅）**。普通 API 密钥请求成功与这些失败结果可能涉及密钥类型、账户或额度差异，不能推断所有 Token Plan 都不可用，也不能保证购买某项余额或套餐就能解决问题。

遇到额度提示，应登录自己的控制台核对实际语音额度、套餐适用范围、恢复时间或积分状态，必要时向 MiniMax 确认。不要仅凭已购套餐或已保存密钥判断可用性，也不要连续重试额度失败的请求。[套餐与额度入口](https://platform.minimax.cn/subscribe/token-plan)

普通浏览器验收使用临时数据库与模拟 WAV，不发起真实 MiniMax 合成调用：

```powershell
npm run build
node --import tsx scripts/check-cloud-voice.mjs
```

本轮模拟验收 **8/8 通过**，未发起真实 AI 请求或浏览器外部网络请求。该套件验证设置、请求、播放和缓存等应用流程；通过不代表真实账户可用，也不代表日语发音或自然度已通过人工试听。

真实浏览器检查脚本 `scripts/check-minimax-live.mjs` 必须显式传入 `--allow-paid` 才会执行。它使用实际服务和当前语音配置，缓存未命中时会调用 MiniMax，可能产生费用；不得作为普通验收自动运行。
