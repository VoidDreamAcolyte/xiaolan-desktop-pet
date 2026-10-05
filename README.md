# 小蓝桌宠（原名：蓝色大肥鱼）

> 桌宠「小蓝」——住在星空里的蓝发小姑娘，穿小鲸鱼围裙女仆裙。原项目名"蓝色大肥鱼"，形象已由用户自定义人物图替换（胖鱼成为历史）。

## 最新更新（2026-10-05）

- **形象全面小蓝化**：默认形象换成蓝发小姑娘（rembg 抠图），9 张表情（开心/生气/困/害羞/惊讶/说话/吃饭/努力/懒洋洋）按状态切换
- **懒洋洋默认表情**：平时待着、饿蔫时是半睁惺忪眼的懒洋洋样子，不再是大笑脸
- **跑步系统**：满地小碎步跑（前倾+挤压拉伸迈步+脚下扬尘+身后尾气），尾气方向 bug 已修
- **五区互动**：头/脸/手/肚子/脚分区点击，反应池轮换（连点同一部位换花样），三连击翻身、长按思考、8 秒摸头 3 次打招呼
- **互动台词**：每个反应配随机台词气泡，还有 2~5 分钟一条的自言自语
- **桌宠大小**：设置页可调 50%~200%
- **回复上限 30→60 字**，人设提示词引导更自然的口语回复
- 完整试用说明见《小蓝桌宠-试用说明书.html》

本项目位于 `D:\BlueFatFish`，目标运行环境为 Windows 11、Node.js 22+ 与 npm，图形与状态逻辑基于 Electron + HTML/CSS/原生 JavaScript。

- 完整需求规格见 `需求说明.md`，开发须遵守其中的分阶段工作方式与验收清单。
- 云端模型使用智谱开放平台。API Key 由用户在设置页填写或通过 `ZHIPU_API_KEY` 提供；不要把任何真实 Key 写入源码或提交到仓库。
- **当前状态：阶段 1–4 的代码与自动化逻辑测试已完成；阶段 4 尚未用真实麦克风、智谱 Key、云端 ASR/TTS 做端到端人工验收。项目整体需求尚未完成。**

## 重要隐私提示

1. 麦克风设置默认开启，应用启动后会尝试请求麦克风权限并本地监听。可用全局快捷键 `Ctrl+Shift+V`、右键菜单「语音对话」或设置页的麦克风开关关闭。
2. **目前没有唤醒词门控**。开麦时 VAD 会自动断句；若不希望持续监听，请关闭麦克风，不要把“没有 Key”当作麦克风关闭。
3. 配置智谱 Key 后，语音识别优先将断句音频发送至智谱 GLM-ASR；识别文本随后会用于智谱对话，回复也可能交给智谱 GLM-TTS 合成。云端服务会处理相应音频/文本。
4. 如果 GLM-TTS 不可用，`edge-tts` 是**在线**的 Microsoft Edge 语音服务，会把待合成文本发送给该服务；它不是离线语音。Windows SAPI 与 Chromium `speechSynthesis` 是本机后备方式。
5. 没有智谱 Key 时不会向云 ASR/聊天发送请求；应用可尝试本地 faster-whisper，但只有在安装了依赖和模型且检测到空闲显存严格大于 1536MB 时才运行。受设置及本地环境影响，缺依赖/模型/显存时语音识别可能不可用。

## 当前进度：阶段 4 —— 连续语音对话 ✅（自动化逻辑通过，真实语音待验收）

| 阶段 | 状态 | 范围 |
| --- | --- | --- |
| 阶段 1 | ✅ | Electron 透明置顶桌宠、托盘、单实例与窗口骨架 |
| 阶段 2 | ✅ | SVG 胖鱼、16 种动作状态、鼠标互动、喂饭/饱食度/游动 |
| 阶段 3 | ✅ | 智谱 Key 安全设置、safeStorage 加密、环境变量优先、主进程聊天客户端、小蓝人设 system 与 60 字回复上限 |
| 阶段 4 | ✅ 自动化逻辑；⚠️ 真实设备/API 待验收 | VAD 自动断句、ASR→对话→TTS 回合、麦克风权限、降级、设置项与临时音频清理 |
| 后续阶段 | ⏳ | 唤醒词/防误触发、游戏陪玩/战术指导/战场报点、桌面快捷方式/开机自启/安装器 |

### 阶段 4 已实现

- 默认免按键监听：轻量本地 VAD 发现人声后收集片段，默认连续约 800ms 静音时结束；30 秒无人说话后降低采样频率。浏览器录音会转换为 16kHz 单声道 WAV。
- 连续回合：GLM-ASR 或本地 faster-whisper 识别 → 主进程 GLM-4.7-Flash 对话 → GLM-TTS/edge-tts/SAPI/Chromium 语音合成。TTS 播放期间停止麦克风采集，播报结束后仅在麦克风仍启用时恢复。
- ASR 上传格式限制为 WAV/MP3，最大 25MB、30 秒。无 Key 时不调用云 ASR，任何本地识别文本也不会送到聊天模型。
- 可设置麦克风开关、VAD 灵敏度、静音判定时长、GLM-TTS 音色、音量与字幕模式。字幕默认关闭；开启后字幕内容与该轮语音回复一致。
- 云请求有 10 秒超时和至多一次重试；失败时通过鱼头顶轻提示，桌宠本体仍应保持运行。

### Key 配置与启动联网行为

设置页使用本地页面，不会因打开页面自动联网；只有用户点击「测试连接」时才发起连接测试。若应用已配置 Key，应用启动时还会发一次最小有效性检查；没有 Key 时启动检查不会发网络请求。语音 ASR、对话和 TTS 请求按实际回合发生。

Key 可通过两种方式设置，环境变量优先：

```powershell
# 当前 PowerShell 会话有效，不写入应用配置文件
$env:ZHIPU_API_KEY = '你的智谱Key'
# 或启动应用后：右键菜单 → 设置 → 输入Key → 保存
```

应用用 Electron `safeStorage` 加密保存 Key；对外状态只包含“是否配置/来源”等非敏感信息。配置文件位于动态的 `app.getPath('userData')` 目录下，不要假定所有机器都使用相同的 `%APPDATA%` 子目录。

### 本地 faster-whisper（可选，不自动下载）

本地 ASR 只做语音转文字，不运行本地聊天大模型。缺模型、Python 包或显存条件不足时会返回不可用并走轻提示，不会静默下载。模型目录为 `app.getPath('userData')/whisper-models/base`，当前默认档位是 base；子进程固定使用 CPU/int8，且只在 `nvidia-smi` 显示空闲显存严格大于 1536MB 时才启动。

如用户希望启用本地识别，可自行安装 `python-stt/requirements.txt` 中的依赖，并从可信来源手动下载模型。以下路径中的 userData 必须替换为本机应用实际 `app.getPath('userData')` 目录（启动日志中的 settings.json 所在目录）：

```powershell
cd D:\BlueFatFish
python -m pip install -r python-stt\requirements.txt
# 将目标路径改成本机 userData 下的 whisper-models\base 目录
python -c "from faster_whisper.utils import download_model; download_model('base', output_dir=r'C:\Users\你的用户名\AppData\Roaming\蓝色大肥鱼\whisper-models\base')"
```

该命令由用户手动执行，模型下载会访问 Hugging Face；应用本身不会自动下载。请在非游戏时段、确认来源可信后操作。可查阅 [faster-whisper 上游项目](https://github.com/SYSTRAN/faster-whisper)、[base 模型页](https://huggingface.co/Systran/faster-whisper-base) 与 [small 模型页](https://huggingface.co/Systran/faster-whisper-small)。

### 云端语音接口与在线降级说明

- [智谱语音转文本文档](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E8%AF%AD%E9%9F%B3%E8%BD%AC%E6%96%87%E6%9C%AC)：当前使用 `glm-asr-2512`，WAV/MP3，25MB/30秒上限。
- [智谱文本转语音 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E8%BD%AC%E8%AF%AD%E9%9F%B3) 与 [GLM-TTS 模型介绍](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts)：当前使用 `glm-tts`，WAV 输出，音色可在设置中选择。
- TTS 顺序为 GLM-TTS → edge-tts → Windows SAPI → Chromium `speechSynthesis`。edge-tts 需用户自行安装并确保 `edge-tts` 可从 PATH 启动；它使用在线 Microsoft Edge TTS 服务，不等于离线。代码依据 [edge-tts 上游](https://github.com/rany2/edge-tts) 的 [CLI 参数实现](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/util.py)，使用 `--file -` 从 stdin 收文本、`--write-media` 写输出文件。

### 当前未实现 / 未验收

- ⏳ 唤醒词列表与近音匹配、唤醒词门控、误触发冷却、陪玩时自动切换门控。
- ⏳ 屏幕理解、游戏陪玩点评、战术指导与战场报点；当前没有截屏、游戏内存读取、进程注入或游戏内叠加层功能。
- ⏳ 桌面快捷方式、HKCU 开机自启、安装器。
- ⚠️ 真实麦克风采集、真实智谱 Key/云端 ASR/TTS、edge-tts 实际合成、faster-whisper 实际推理、设置窗口与动态桌宠操作尚未端到端人工验收。

### 阶段 3 历史记录

以下历史章节保留了阶段 3 的安全设置与缺陷修复过程；其中“语音未接入”等文字只描述当时的阶段边界，不代表当前状态。

### 阶段 3 针对性缺陷修复（Codex 审查 A–G）

> 这一轮只做缺陷修复，不进入阶段 4；每一条都有"先复现 / 先能捕获，再修复，再回归"的断言。

| 缺陷 | 根因 | 修复 | 回归断言 |
| --- | --- | --- | --- |
| **A. 缺少 system 提示词** | `buildMessages()` 只拼 history + user，没有任何 system 消息；也没有回复长度上限 | 内置中文鱼设 `SYSTEM_PROMPT` 固定放 `messages[0]`（深海蓝 / 白米饭 / 傲娇撒娇 / 被夸害羞 / 失败先嘴硬后暖心不嘲讽 / 只输出正文）；历史里的 `system` 一律丢弃，裁剪只从下标 1 开始；`MAX_MESSAGES` = 6 历史 + system + user；总字符预算计入 system；新增 `MAX_REPLY_CHARS = 30` 与 `limitReply()` 按 code point 截断 | `tests/zhipu-client.test.js` 新增 35 项：system 是第一条且等于 `SYSTEM_PROMPT`、历史 system 无法覆盖、压缩历史时 system 保留、总字符 = 非 system 之和 + system 长度、超长回复截到 30 且 emoji 不劈开 |
| **B. 清除 Key 失效** | `renderer/settings.js` 发 `'\u0000CLEAR\u0000'`，但 preload 先做通用控制字符过滤，NUL 被丢掉，IPC 实际没有 clear | preload 里**先精确匹配哨兵**（`value === CLEAR_KEY_SENTINEL` → 原样透传），再做通用控制字符过滤；其它控制串（含哨兵多一个字符）仍然拒绝 | 新增 `tests/settings-preload.test.js`（VM + mock electron 真实执行 preload）：精确哨兵透传、`'\u0000CLEAR\u0000x'` 与含 NUL 的其它串被拒绝且不调用主进程 |
| **C. 非法输入静默 fallback** | preload 对非法非空 Key / 模型静默略过后仍调用主进程，主进程回落到旧 Key / 环境 Key，界面显示"保存成功 / 测试成功" | preload 用 `classifyApiKey` / `classifyModel` 归类：非空非法 → 本地直接返回 `invalid-api-key` / `invalid-model`，**不调用主进程、不联网**；主进程 `pickDraftKey` 同样把非空非法草稿判 invalid，绝不 fallback；错误只回简短中文、不回显输入 | `tests/settings-preload.test.js`：过短 / 超长 / 含换行 / 非精确哨兵的 Key 都不调用主进程、报错不回显；非法模型名返回 `invalid-model`；主进程侧 `pickDraftKey` 有对应断言 |
| **D. 越界的"接口自检"** | 设置页有自由文本输入 + 模型回复显示，和"无可见文字聊天面板、不把文本冒充语音"冲突 | 删除 `settings.html` 的 probe 区块、`settings.js` 的 `onProbe` 与绑定、preload 的 `chat`、`ipc-channels.js` 的 `settings:chat`、`main.js` 的该 handler；连接测试仍发固定「你好」，但只回 `ok / model / latencyMs / 安全错误`；`zhipu-client.chat` 留在主进程内部 | 烟测：设置页无 `probe-*` / `onProbe` / `api.chat`、通道恰好三条、主进程无 `settings:chat`、测试连接返回值不含 `content`；preload 行为测试断言 `api.chat === undefined` |
| **E. body read 不受超时保护** | 拿到 response headers 就 `clearTimeout`，`response.text()` 卡住时永远挂起 | 超时定时器覆盖**整个 fetch + body read**，只在 `finally` 里 `clearTimeout`；body read 被 abort 时同样归类 `timeout` 并按策略最多重试一次；不再吞 body read 异常 | `tests/zhipu-client.test.js` 新增假时钟用例：body read 卡住 → `timeout`、定时器被清理、`maxRetries:1` 时重试一次（2 次请求 / attempts=2）、成功与非 2xx 路径都清理定时器；用例带真实"安全网"定时器，实现被改坏时是断言失败而不是挂死 |
| **F. session-only 换 Key 复活旧密文** | 加密不可用时换 Key 只改内存，磁盘旧密文没被覆盖；下次重启（加密恢复）会悄悄加载旧 Key | `save()` 记录 `hadStoredCipher`；当新 Key 只能 session-only 且磁盘原有密文时，主动写一份**空 `keyEncrypted`** 原子覆盖旧密文；写盘失败时返回值明确提示"无法清除旧密文，重启后可能加载旧 Key"；写盘失败换 Key 也提示旧加密 Key 可能仍在；**绝不退回明文** | `tests/settings-store.test.js` 新增 18 项：换 session-only Key 后旧密文被空字段覆盖、第三次重启旧 Key 不复活、写盘失败明确提示、清除哨兵重启后不复活 |
| **G. 不泄密 / 重试策略** | 需要保证任何返回值 / 日志 / 错误都不含 Key，且 15 秒 + 最多一次重试只对网络 / timeout / 408 / 425 / 429 / 5xx | 保持既有实现，新增断言覆盖 body read 超时路径也不回显 Key 与正文 | 既有"不泄密"整组断言继续通过；新增 body read 超时不回显 Key / 正文 |

---


| 能力 | 说明 |
| --- | --- |
| 动作状态机 | `renderer/logic/state-machine.js`，纯 JS、无 DOM 依赖、可直接被 node 单元测试驱动。**持久模式**（idle / hungry / angry / sleep）+ **短暂动作**（12 个，到点自动回落）+ **按住状态**（dragged）三层 |
| 动作立即上报 | `startAction()` 改变可见状态后**立即 `emit()`**：首次 transient 动作（greet / poke / happy / eat …）马上触发 `onChange`，渲染层才能切到 `.state-*` 并刷新 reportState；同名重复触发发出 `restart:*` 原因让渲染层重播动画；动作到点回落再 emit 一次持久模式并调用 `onActionEnd` |
| 状态优先级与打断 | 随机动作绝不插队；`sleep` 是互斥模式（进入时打断正在播的动作，且 `setBase()` 在睡觉期间**只接受 `source:'user'`**，mood / random / system 一律拒绝 —— 只有用户直接交互能把鱼叫醒）；`eat` / `talking` 不可被打断（`force` 除外）；用户重复触发同一动作会重播动画并重置定时器 |
| 定时器清理 | 所有短暂动作的定时器统一由状态机管理，切换 / 取消 / 回落 / dispose 时一定清空（单元测试逐项断言"没有残留定时器"） |
| CSS 动画分层 | 底座层 `#fish-root` 只跑持久模式动画（漂浮 / 发蔫 / 生气抖动 / 睡觉呼吸），动作层 `#fish-action` 只跑短暂动作动画（弹跳 / 转圈 / 翻肚皮 / 挣扎 / 倾斜摆尾）。两层各管一个元素，**不会出现两条规则抢同一个 transform** |
| 随机眨眼 | 随机间隔 2.6~6.8 秒；睡觉 / 拖拽 / 正在播动作时自动跳过 |
| 随机小动作 | 每 45~110 秒随机一次：发呆（thinking）/ 翻肚皮（flip）/ 自己开心（happy） |
| 随机游动 | 每 3~6 分钟一次，**只在窗口可见、非 sleep、没有直接交互时**触发；跨屏移动由主进程完成 |
| 摸头 pet | 鼠标在鱼头范围**停留 700ms** 或**滑动累计超过 60px** 触发；眯眼 + 头顶冒爱心 + 腮红；带 2.6 秒冷却，且必须移出鱼头才重新计数 |
| 拖拽 dragged | 左键按住并移动 → `dragged`（挣扎扭动 + 瞪眼 + 汗滴）；松手回落到**当前情绪**（不会被改回 idle）；拖拽期间其它动作与随机动作全部被拒 |
| 单击 poke / 双击 greet | 单击（含长按不动）弹跳 + 冒汗 + 瞪眼；双击挥鱼鳍 + 腮红；应用启动与托盘唤出也会 greet |
| 喂饭闭环 | 菜单「喂饭」→ `pet:feed` 事件 → 饱食度重置到 100 → `eat` 约 3 秒（米粒逐粒消失 + 腮帮咀嚼 + 小白碗弹出 + 最后满足眯眼）→ 自动串到 `happy`（转圈 + 彩色泡泡） |
| 饱食度 | `renderer/logic/fullness.js`，纯 JS：初始 100、每分钟 -1、≤30 进入 `hungry`、低饱食持续 10 分钟进入 `angry`、喂饭回满；数值恒在 [0,100] |
| 饱食度持久化 | 写在 renderer 的 `localStorage`（键 `blueFatFish.fullness.v1`，只有数值 + 两个时间戳，**不含任何密钥**）；用时间戳补算离线下降；损坏 JSON / 缺字段 / 未来时间戳 / 越界值都有明确兜底；localStorage 不可用时静默降级为"仅本次会话" |
| 睡觉与叫醒 | 菜单「睡觉」先唤出窗口再切 `sleep`（不会睡在隐藏窗口里）；睡觉期间**随机动作一律被拒**，饱食度照常随真实时间下降，睡醒时底色 = 当前情绪（饿着醒来会继续 hungry / angry，而不是被 idle 顶掉） |
| 游动（swim） | 新增最小安全 IPC `pet:swim-request`：渲染层**只发请求、不带任何坐标**；主进程自己读窗口 bounds 与所在显示器 `workArea`，用纯函数 `main/swim-plan.js` 规划"游到工作区另一侧再游回来"的轨迹并逐帧限幅；完成 / 取消 / **渲染层状态切走 swim（被 poke / pet / sleep 打断）** / 窗口隐藏 / 窗口销毁 / 退出 / 动画异常时都清理定时器并复位位置 |
| 鼠标穿透联动 | 光标在鱼身图形上才拦截，透明区域把桌面操作让出去（沿袭阶段 1） |
| 安全架构 | 继续沿用 `sandbox: true` / `nodeIntegration: false` / `contextIsolation: true` / CSP / preload 白名单，**没有为了新功能放宽任何一条**；8 个桌宠 IPC 通道 + 3 个设置通道全部经过来源校验包装 |
| 自检脚本（阶段 2 当时数字） | `npm run smoke`：290 项静态 + 可执行检查；`npm run test:unit`：235 项纯逻辑单元测试（状态机 119 + 饱食度 71 + 游动 45）—— 阶段 3 缺陷修复后同一套脚本已扩展到 **1080 项**，见上文 |

### 阶段 2 针对性缺陷修复（本次）

> 这一轮只做缺陷修复，不进入阶段 3；四条问题都有**先复现、再修复、再回归**的证据。

| 缺陷 | 根因 | 修复 | 回归断言 |
| --- | --- | --- | --- |
| 首次 transient 动作不显示 | `state-machine.js` 的 `startAction()` 改完 `action` / 定时器后没有 `emit()`，渲染层 `onChange` 收不到事件，`.state-*` 类切不过去 | 改变 `visible` 后立即 `emit('action-start:<source>' / 'restart:<source>', previous)`；回落时仍 emit `action-end:*` 并调用 `onActionEnd` | `tests/state-machine.test.js` 新增 2B 节 15 项：首次 greet 必须 emit、greet→poke 两次且 previous/visible 正确、重复动作 reason 以 `restart` 开头、到点回落再 emit 一次；去掉 `emit` 后这组断言会失败 10 项 |
| 情绪变化导致"无声说话" | `renderer.js` 的 `announce(text,{mouthMs})` 在 hungry / angry 时请求 `talking`，但阶段 2 没有 TTS，鱼会无声张嘴 | `announce(text)` 只改不可见 `aria-live` 文本；情绪回调删除 `mouthMs`；`beginSpeech()/endSpeech()` 作为后续真实 TTS 接口保留，`talking` 只由它驱动 | `tests/smoke.test.js` 回归⑥ 5 项：`announce` 不触发任何动作、全文件无 `mouthMs`、`machine.request('talking')` 只出现在 `beginSpeech`；把 talking 放回 `announce` 后该组失败 |
| 游动中被动作打断后主进程继续移动窗体 | `requestSwim()` 先启动 6 秒窗口动画，poke / pet / sleep 打断 swim 后渲染层已无 swim 动画，主进程 interval 仍在 `setPosition` | `main.js` 的 `REPORT_STATE` 在 `PET_STATES` 校验通过后：`state !== 'swim'` 且存在 `swimAnimation` → `cancelSwim('state-changed')`（按起点复位）；报告 `swim` 自身不会自取消 | `tests/smoke.test.js` 回归⑦ 7 项：取消路径存在、条件必须是 `state !== 'swim'`、先白名单后取消、只收状态字符串不收坐标；把条件改成 `false` 后该组失败 2 项 |
| 睡觉可被 `system` 状态自动改掉 | `setBase()` 只在 `source === 'mood'` 时拒绝，`system` / `random` 仍能把 `sleep` 顶掉 | 收紧为 `base === 'sleep' && source !== 'user'` 一律拒绝 | `tests/state-machine.test.js` 第 4 节新增：`system` / `random` 改 sleep 被拒且可见状态仍是 sleep，`user` 显式操作仍可改；改回 `source === 'mood'` 后失败 3 项 |

### 16 个动作状态与触发方式

> "可触发"指**真的由事件 / 计时器 / 菜单驱动**，不是"CSS 里写了但永远用不到"的占位类。
> 静态检查会核对：状态白名单、渲染层状态类、CSS 规则三者必须逐项对齐。

| 状态 | 类型 | 触发方式 |
| --- | --- | --- |
| `idle` | 持久模式 | 默认底色；`wake` 结束、情绪恢复满值后回到它 |
| `blink` | 短暂（200ms） | 随机计时器（2.6~6.8 秒），睡觉 / 拖拽 / 忙时跳过 |
| `eat` | 短暂（3s） | 菜单「喂饭」→ 主进程 `pet:feed` 事件 |
| `happy` | 短暂（2.2s） | 吃完自动串场；随机小动作（转圈 + 彩色泡泡） |
| `hungry` | 持久模式 | 饱食度 ≤ 30 时由情绪驱动切底色（瘪嘴 + 饿纹 + 发蔫漂浮） |
| `sleep` | 持久模式（互斥） | 菜单「睡觉」；进入时打断正在播的动作 |
| `talking` | 短暂（2.6s） | **只由明确的 TTS 接口驱动**：`window.__bffDebug.say(ms)` / 后续接入的 `beginSpeech(ms)`；情绪变化**不会**自动请求 talking（否则就是"无声说话"，违反需求），本阶段不发声、不显示文字 |
| `thinking` | 短暂（2.4s） | 随机小动作（歪头 + 问号 + 旋转泡泡） |
| `dragged` | 按住状态 | 左键按住鱼身并移动（最高优先级，进入时清掉正在播的动作） |
| `poke` | 短暂（1.1s） | 单击鱼身（含长按不动） |
| `pet` | 短暂（1.7s） | 鼠标在鱼头停留 700ms 或滑动 60px |
| `swim` | 短暂（4.2s，主进程给时长） | 随机计时器（3~6 分钟）；`window.__bffDebug.swim()`；主进程同时动画窗口位置 |
| `flip` | 短暂（1.8s） | 随机小动作（翻肚皮再翻回来） |
| `greet` | 短暂（2.1s） | 应用启动、双击鱼身、托盘左键唤出 |
| `angry` | 持久模式 | 低饱食（≤30）持续满 10 分钟（鼓腮瞪眼 + 眉毛 + 怒火符号 + 高频抖动） |
| `wake` | 短暂（0.9s） | 菜单「叫醒」（底色切回当前情绪后播睁眼伸展） |

### 饱食度：设计写死，可被假时钟测试

| 规则 | 取值 |
| --- | --- |
| 初始值 | 100 |
| 下降速度 | 每分钟 1 点（= 每毫秒 1/60000 点，基于**时间戳差值**而不是定时器次数） |
| `hungry` 阈值 | ≤ 30 |
| `angry` 阈值 | 处于"低饱食（≤30）"状态连续满 10 分钟 |
| 喂饭 | 立刻回到 100，并清空低饱食计时 |
| 睡觉 | **不暂停下降**（刻意的设计：睡着的鱼也会饿，醒来就催饭） |
| 离线 | 用 `localStorage` 里的时间戳补算；窗口被节流、收进托盘、程序关闭一段时间都按真实时间补算 |
| 防御 | 越界值夹到 [0,100]；NaN / 缺字段 / JSON 损坏 → 重置为 100 并标记 corrupted；时间戳在未来 → 按"时长 0"处理（**不会回涨、不会倒扣出负值**） |
| 落盘 | 每 60 秒最多写一次；另外在页面隐藏 / 关闭前各写一次 |

渲染层每 15 秒 tick 一次（只影响显示延迟，不影响到数值计算）。

### 游动（swim）：为什么需要一条新 IPC

需求要求"从屏幕一侧游到另一侧再回来"，这必须移动**窗口**，只有主进程能做。为了不破坏
"渲染层不能碰任意能力"的架构，接口被刻意设计成最小：

```
renderer                          main
bridge.requestSwim()   ──────►    handleFromPetWindow(SWIM_REQUEST, () => requestSwim())
   （不带任何参数）                    ├─ petWindow.getBounds()
                                     ├─ screen.getDisplayMatching(bounds).workArea
                                     ├─ createSwimPlan(bounds, workArea)   ← 纯函数、可单元测试
                                     └─ setInterval(stepSwim, 16ms) → setPosition(positionAt(plan, t))
```

- 渲染层**永远不能指定屏幕坐标**，连目标方向都由主进程按"窗口中心 vs 工作区中心"判断；
- 逐帧坐标经过 `clamp`，**任何一帧都不会越出 workArea**（单元测试按 16ms 逐帧扫描验证）；
- 窗口被拖到屏幕外、或比工作区还大时都会先归位 / 退化处理，不会算出负范围；
- 完成、被新请求打断、开始拖拽、**渲染层状态切走 swim（poke / pet / sleep 打断）**、
  窗口隐藏、窗口销毁、应用退出、动画抛异常
  —— 以上路径都会 `clearInterval` 并把窗口复位回本次游动的起点；
- 渲染层只在游动期间加 `.state-swim` + `.swim-left/.swim-right` 类（身体倾斜 + 身后拖一串水泡），
  **不参与窗口移动**。

### 当前阶段盘点与后续任务

- ✅ **阶段 1–3**：桌宠骨架、交互/饱食度/游动、安全设置与云端对话基础已完成。
- ✅ **阶段 4（代码与自动化测试）**：连续语音回合、VAD、ASR、TTS、本地语音后备、麦克风权限收紧与设置项已实现；真实设备/API 仍待人工验收。
- ⏳ **阶段 5 · 唤醒词与防误触**：增加唤醒词/近音匹配、门控、误触发冷却，以及陪玩期间的门控策略。阶段 4 当前没有唤醒词；开麦时会持续本地监听并自动断句。
- ⏳ **阶段 6 · 游戏陪玩 / 战术思路**：按需求实现屏幕采集、压缩、点评、节流、语音优先与首次隐私告知；目前没有截屏功能。
- ⏳ **阶段 7 · 战场报点（可选）**：评估本地轻量人形检测与显存/CPU 回退。继续遵守禁止读取游戏内存、进程注入和游戏内叠加层的红线。
- ⏳ **最后 · 桌面入口与安装**：桌面快捷方式、开机自启、安装器及相关托盘状态。

以上是阶段盘点，不代表完整需求已经验收。菜单「语音对话」在阶段 4 已改为麦克风开关；更多操作见上文。

---

## 快速开始（Windows 11 + Node 22 + npm）

```powershell
# 1) 进入项目目录
cd D:\BlueFatFish

# 2) 安装依赖（只装 Electron；postinstall 会自动生成托盘图标）
npm install --no-audit --no-fund

# 3) 跑检查（推荐先跑，全绿再启动）
npm test              # 当前 2223 项：1684 项单元测试 + 539 项烟测/静态检查
# 也可以分开跑：
npm run test:unit     # 全部 16 个单元测试文件，当前合计 1684 项
npm run test:voice    # 10 个语音链路单元测试文件，当前合计 1028 项
npm run smoke         # 539 项静态 + 可执行检查

# 4) 启动桌宠
npm start

# 可选：重新生成托盘图标（改了图标设计后）
npm run icons
```

> 本机（开发会话）系统 PATH 里没有 npm，可以用仓库里引导好的那份 npm 直接跑，
> 效果与 `npm test` 完全一致：
>
> ```powershell
> node work\npm-bootstrap\package\bin\npm-cli.js test
> ```

**预期现象**：屏幕右下角出现一只深海蓝胖鱼，缓慢上下漂浮、尾巴轻摆，开局会打一次招呼；
之后会随机眨眼、偶尔发呆 / 翻肚皮 / 自己开心一下，每几分钟自己游到屏幕另一侧再游回来。
左键可拖动（挣扎扭动）；单击弹跳冒汗；双击打招呼；鼠标在鱼头上停留一会儿会被"摸头"；
右键（或托盘右键）弹出菜单；关闭窗口后鱼收进托盘，托盘左键唤回。

> 本机系统 PATH 里没有 npm：阶段 1 / 2 / 3 都是用 `work/npm-bootstrap` 里临时引导出来的
> npm 12.2.0 执行 `npm install` / `npm run` / `npm start` 的（阶段 3 的测试命令是
> `node work\npm-bootstrap\package\bin\npm-cli.js test`，退出码 0）。
> 若首次 `npm start` 下载 Electron 报 GitHub HTTP 错误，见文末「常见问题」里的镜像 + 远程校验设置。

---

## 目录结构

```
D:\BlueFatFish\
├─ package.json                    入口 main/main.js，只依赖 electron（devDependency）
├─ README.md                       本文件
├─ 需求说明.md                      完整需求规格（不要修改）
├─ main\                           主进程层
│  ├─ main.js                      窗口 / 托盘 / 菜单 / 单实例 / 拖拽 / 游动动画 / 设置窗口 / 导航拦截
│  ├─ preload.js                   桌宠窗口唯一桥梁：只 require('electron')，内部冻结定义通道常量，
│  │                               暴露 window.blueFatFish（dragStart/dragMove/dragEnd/showContextMenu/
│  │                               setIgnoreMouseEvents/requestSwim/reportState/reportSettingsState/
│  │                               onAction/onFeed）—— **没有任何 settings:* 通道**
│  ├─ settings-preload.js          设置窗口唯一桥梁：只暴露 window.blueFatFishSettings
│  │                               （getSettings/saveSettings/setVoiceSettings/testConnection/onSettingsChanged）
│  │                               —— **没有任何 pet:* 通道，也没有 chat 通道**；
│  │                               非空非法 Key / 模型名在本地直接报错，绝不静默 fallback
│  ├─ ipc-channels.js              IPC 通道、事件与白名单
│  ├─ settings-store.js            safeStorage 加密、环境变量优先、原子写入与损坏兜底
│  ├─ zhipu-client.js              智谱聊天客户端
│  ├─ asr-client.js / tts-client.js 智谱 ASR/TTS 客户端与 TTS 降级编排
│  ├─ net-retry.js                 云请求重试与超时
│  ├─ local-whisper.js             faster-whisper 子进程适配
│  ├─ native-speech.js             edge-tts 与 Windows SAPI 适配
│  ├─ voice-audio-payload.js       临时语音文件读取、大小限制与清理
│  ├─ voice-permission.js          麦克风权限决策
│  ├─ file-url.js                  file:// URL 归一化
│  └─ swim-plan.js                 游动路径规划与限幅
├─ renderer\                       渲染层（HTML/CSS/原生 JS）
│  ├─ index.html                   桌宠页面骨架 + CSP + 内联鱼 SVG + 三个本地脚本
│  ├─ styles.css                   透明背景、state-*/mode-* 类、全部 CSS keyframes 动画
│  ├─ renderer.js                  DOM 接线：交互、随机调度、饱食度持久化、穿透联动
│  ├─ settings.html                设置页骨架 + 严格 CSP（无远程资源引用）
│  ├─ settings.css                 设置页样式（浅色卡片 + 深色模式，无框架、无外部字体）
│  ├─ settings.js                  设置页逻辑：Key、模型与语音选项（无自由文本聊天）
│  └─ logic\                       纯逻辑模块（无 DOM 依赖，浏览器与 node 共用同一份代码）
│     ├─ state-machine.js          状态机：持久模式 / 短暂动作 / 按住 + 优先级与打断规则
│     ├─ fullness.js               饱食度：衰减、阈值、喂饭与离线补算
│     ├─ vad.js / wav.js            浏览器端 VAD 与 WAV 编码
│     └─ turn-taking.js             语音回合管理
├─ assets\
│  ├─ fish.svg                     鱼本体 + 全部情绪符号（唯一事实来源，纯矢量）
│  ├─ tray-icon.png                32×32 托盘图标（由 tools/make-icons.js 生成）
│  └─ tray-icon@2x.png             64×64 托盘图标（高分屏）
├─ tools\
│  ├─ build-renderer.js            把 assets/fish.svg 注入 renderer/index.html
│  ├─ make-icons.js                零依赖生成托盘 PNG（Node 内置 zlib 手写 PNG 编码）
│  └─ make-icons.ps1               等价的 PowerShell 实现（备用；文件带 UTF-8 BOM）
└─ tests\
   ├─ smoke.test.js                烟测与静态检查（539 项）
   ├─ state-machine.test.js        状态机单元测试
   ├─ fullness.test.js             饱食度单元测试
   ├─ swim-plan.test.js            游动路径单元测试
   ├─ settings-store.test.js       设置存储单元测试
   ├─ zhipu-client.test.js         智谱聊天客户端单元测试
   ├─ settings-preload.test.js     设置 preload 行为测试
   └─ 其余语音测试                VAD、WAV、回合、重试、ASR/TTS、权限、临时音频、原生语音与本地 Whisper
```

### 为什么 index.html 里有一份内联 SVG？

`assets/fish.svg` 是唯一事实来源（可以单独打开预览、单独编辑）。但 CSS 要驱动 SVG
**内部**元素（眼睛、鱼鳍、米粒、爱心、泡泡）的动画，就不能用 `<img>` 引用。所以由
`tools/build-renderer.js` 把 SVG 内联进 `index.html` 的两个标记注释之间：

```
<!-- FISH_SVG_START -->  …内联的 <svg id="fish-svg">…  <!-- FISH_SVG_END -->
```

**改完 `assets/fish.svg` 后请运行 `node tools/build-renderer.js` 重新注入**，
否则页面还是旧图形（`npm run smoke` 与 `node tools/build-renderer.js --check` 都会报错）。

### 为什么纯逻辑要单独成模块？

`renderer/logic/state-machine.js` 与 `renderer/logic/fullness.js` 用一段极小的 UMD 包装同时支持
两种加载方式：浏览器里 `<script>` 加载后挂到 `window.BFFLogic`，node 里 `require()` 直接导出。
这样单元测试跑的就是**渲染层真正使用的那份实现**，而不是测试文件里复制一份逻辑冒充。

---

## 交互说明（阶段 2 实际行为）

| 操作 | 行为 |
| --- | --- |
| 左键按住拖动 | `dragged` 状态（挣扎扭动 + 瞪眼 + 汗滴），窗口跟随移动；松手回落到当前情绪 |
| 左键单击 | `poke`：弹跳一下 + 冒汗 + 瞪眼 |
| 左键双击 | `greet`：挥鱼鳍 + 摆动 + 腮红 |
| 鼠标在鱼头上停留 ≥700ms | `pet`：眯眼 + 头顶爱心 + 腮红（带冷却，需移出鱼头才重新计数） |
| 鼠标在鱼头上滑动 ≥60px | 同上（滑动也能触发摸头） |
| 右键（鱼身或托盘） | 弹出同一份菜单 |
| 托盘左键 | 唤出并聚焦桌宠，同时触发一次打招呼 |
| 托盘提示 | 显示"蓝色大肥鱼 · 当前状态"（只读联动，不是台词） |
| 菜单「喂饭」 | 饱食度重置到 100 → `eat` 约 3 秒（米粒逐粒消失 + 咀嚼 + 小白碗）→ `happy` |
| 菜单「睡觉」 | `sleep`（闭眼 + Zzz + 缓慢呼吸）；会先把收进托盘的窗口唤出 |
| 菜单「叫醒」 | `wake`（睁眼 + 伸展），底色切回当前情绪（饿着醒来继续 hungry / angry） |
| 菜单「语音对话」 | 开关麦克风；默认开启。开启后会在本地监听并自动断句，当前没有唤醒词门控 |
| 菜单「设置」 | **打开独立的本地设置窗口**（阶段 3 起是真功能）：配置智谱 API Key、改对话模型、手动测试连接 |
| 设置窗口「保存设置」 | Key 经 preload 归类校验（非空非法直接本地报错）→ 主进程校验 → safeStorage 加密 → 原子写入 `settings.json`；保存后输入框清空，只显示「已配置」 |
| 设置窗口「测试连接」 | 用户点击后发**一次**最小对话请求（`你好`），就地显示成功/失败与耗时（**不显示生成正文**）；未配置 Key 时提示去 open.bigmodel.cn；草稿 Key 非法时本地直接失败、不联网 |
| 设置窗口「清除本机保存的 Key」 | 用精确哨兵命令清掉配置文件里的加密 Key（旧密文一并抹掉）；如果环境变量还在，它会继续生效（界面会说明） |
| 菜单「退出」 | 真正结束进程 |
| 关闭窗口（Alt+F4 / 系统关闭） | 只隐藏到托盘，进程继续运行（正在游动会被取消并复位） |
| 随机行为 | 眨眼 2.6~6.8 秒一次；发呆 / 翻肚皮 / 开心 45~110 秒一次；游动 3~6 分钟一次 |
| 鼠标在透明区域 | 不拦截桌面操作（鼠标穿透） |

**调试入口**（人工排查用，页面里 `window.__bffDebug`）：
`getState()` / `getSnapshot()` / `getFullness()` / `setState(name)` / `setBase(name)` /
`sleep()` / `wake()` / `feed()` / `swim()` / `say(ms)` / `endSpeech()` / `isOverFish(x,y)` / `isOverHead(x,y)`

---

## 安全设计说明

1. **渲染层绝不碰 Node**：`nodeIntegration=false` + `contextIsolation=true` + `sandbox=true`（阶段 2 没有放宽）。
2. **preload 最小暴露**：只暴露 `window.blueFatFish`（已 `Object.freeze`），方法都是"固定通道 + 参数校验"的
   窄接口，不暴露 `ipcRenderer` 本体，也不暴露 `require`/`process`/`fs`。`sandbox: true` 下
   沙箱 preload 的 `require` 无法加载本地相对模块，因此 `main/preload.js` 顶层**只** `require('electron')`；
   所需的 `IPC_CHANNELS` / `PET_EVENTS` / 动作白名单在文件内部以冻结常量定义副本，
   与 `main/ipc-channels.js` 的一致性由烟测**逐项比对**（漂移即失败）。
3. **IPC 来源校验**：每个 `ipcMain.handle` 都经过统一包装，只接受当前 `petWindow` 的**主 frame**、
   且 frame URL 必须等于本地 `ENTRY_HTML`；来源不合法直接返回 `false`，异常也只记日志并返回 `false`。
   阶段 2 新增的 `pet:swim-request` 同样走这条包装。
4. **游动不接受坐标**：`requestSwim()` 在 preload 与主进程两侧都**不接收任何参数**，
   目标位置完全由主进程按 `workArea` 计算并用纯函数限幅；渲染层无法把桌宠指到任意屏幕坐标。
5. **CSP**：`default-src 'none'`，只允许本地脚本/样式/图片；`connect-src 'none'` 意味着
   页面**无法发起任何网络请求**。
6. **导航、新窗口与权限**：`will-navigate`、`setWindowOpenHandler`、`will-attach-webview`
   全部拒绝；session 权限处理只允许桌宠本地页面主 frame 请求 `audio` 麦克风权限，其他来源/类型均拒绝。
   设置窗口同样禁止导航和新窗口（`hardenWebContents()` 两个窗口共用）。
7. **本地存储只有饱食度**：`localStorage` 里只写 `{version, value, savedAt, hungrySince}`，
   **不含任何 API Key / token / 隐私数据**；所有访问都包在 try/catch 里，失败只降级为"仅本次会话"。
8. **没有密钥**：源码中不含任何 API Key；`.gitignore` 已排除 `config.local.json` 与 `.env`。

### 阶段 3 新增的安全设计（为什么可以放心把 Key 交给它）

1. **两套通道、两个窗口、两份 preload**：桌宠窗口的 preload 里没有 `settings:*`，
   设置窗口的 preload 里没有 `pet:*`；主进程侧分别用 `isTrustedSender`（要求 `petWindow`
   的主 frame + `index.html` URL）与 `isTrustedSettingsSender`（要求 `settingsWindow`
   的主 frame + `settings.html` URL）校验。任何一侧被注入都拿不到另一侧的能力。
2. **Key 的生命周期**：`safeStorage.decryptString` → 只在主进程内存 → 拼进 `Authorization` 头。
   它不会被写进任何返回值、日志、错误信息或渲染层可读的位置。
   `getPublicSettings()` 的键集合被烟测与单元测试**逐项断言**，多一个字段就会失败。
3. **绝不明文落盘的实现细节**：`resolveSafeStorage()` 只在 `isEncryptionAvailable() === true`
   时才提供 `encrypt`；拿不到密文时 `keyEncrypted` 保持空字符串并标记
   `persistence: 'session-only'`；**没有任何"写入原始 Key"的分支**。
   单元测试用"把密文换成明文"的变异测试验证过这条断言真的会失败。
4. **原子写入 + 权限最小化**：先写 `<file>.tmp` 再 `rename`；目标文件 mode `0o600`、
   目录 mode `0o700`（Windows 上另有用户账户 ACL）；写失败只降级为"仅本次会话"。
5. **模型名不能变成请求地址**：`model` 只允许 `[A-Za-z0-9._:-]{1,64}`；
   `url` / `endpoint` 既不在 preload 的白名单里，也不在 `zhipu-client` 的参数里。
   请求地址只能是代码里写死的那一个（变异测试改域名会让单元测试失败）。
6. **只在用户点击时联网**：`chat()` / `testConnection()` 只由设置页按钮触发；
   启动流程（`bootstrap()` → `setupSettings()`）只读本地配置，不发任何请求。
   设置页 CSP 的 `connect-src 'none'` 让渲染层连 `fetch` 都被拦死。
7. **草稿 Key 不落盘**：允许"还没保存就先测试"，但这个 Key 只用于当次请求的客户端实例，
   不写盘、不进日志、不出现在返回值里。
8. **清除 / 非法输入 / 旧密文（缺陷修复 B / C / F）**：只有**精确匹配** `'\u0000CLEAR\u0000'`
   才当作清除命令（先判哨兵再做控制字符过滤）；非空但不合法的草稿 Key / 模型名在 preload
   与主进程两侧都直接报 `invalid-api-key` / `invalid-model`，**不联网、不回落旧 Key**；
   换 session-only Key 时主动用空 `keyEncrypted` 覆盖磁盘旧密文，避免重启后旧 Key"复活"，
   写盘失败时界面明确提示旧密文可能还在。
9. **没有文字聊天入口（缺陷修复 D）**：设置页已删除自由文本输入与回复展示，
   测试连接只回 `ok / model / latencyMs / 安全错误码`，**不回生成正文**；
   `settings:chat` 通道、preload 的 `chat`、`main.js` 的对应 handler 全部删除，
   烟测与 preload 行为测试逐项断言。

> 补充：菜单坐标不要自己换算。`Menu.popup` 省略 `x/y` 时默认在**当前鼠标指针位置**弹出；
> 托盘右键则用 Electron Tray 自身的 `tray.popUpContextMenu(...)`（窗口可能已被收进托盘，
> 把隐藏窗口当 owner 传给 `Menu.popup` 会让菜单弹不出来）。两种弹法共用同一份
> `Menu.buildFromTemplate(buildMenuTemplate())` 模板。

---

## 验证方式与已跑过的检查

### 当前自动化验证（阶段 4）

| 检查 | 当前结果 | 验证边界 |
| --- | --- | --- |
| `test:unit` 的 16 个测试文件 | **1684 / 1684 通过** | Node 单元/行为测试，含语音客户端、权限、原生语音与本地 Whisper 的 fake 覆盖 |
| `node tests/smoke.test.js` | **539 / 539 通过** | 静态与可执行检查，不等于真实设备验收 |
| `test:voice` 的 10 个语音测试文件 | **1028 / 1028 通过** | 语音链路子集，已包含在 1684 项中，不要重复相加 |
| 全部自动化 | **2223 / 2223 通过** | 1684 项单元/行为 + 539 项 smoke |
| `node --check` | **42 个 JavaScript 文件通过** | 仅语法检查，不会启动 Electron 或访问设备/网络 |

测试均未使用真实智谱 Key、真实网络请求、真实麦克风、真实 TTS 或真实 Whisper 模型。语音临时文件测试的 41 项断言全部通过，但当前环境因 `EPERM` 无法创建符号链接，因此额外的软链逃逸检查被跳过。npm 命令是给已安装 Node.js/npm 的用户使用；本次开发验证环境没有可用的 npm 命令行，因此测试通过逐个运行 Node 测试脚本复核，不能据此声称实际执行了 `npm test`。

### 阶段 3 历史执行记录与变异测试

以下数量只记录阶段 3 当时的状态；当前数量以本节上方阶段 4 结果为准。

| 历史检查 | 当时结果 |
| --- | --- |
| `node tests/smoke.test.js` | **424 项通过**（后续已增至 539 项） |
| 单元/行为测试 | **656 项通过**（后续已增至 1684 项） |
| 阶段 3 自动化合计 | **1080 项通过**（后续已增至 2223 项） |
| 变异测试 ①–⑰ | 下方保留阶段 3 的历史回归证据 |

| 历史变异测试 | 结果 |
| --- | --- |
| 变异测试 ①（让 `safeStorage` 返回明文冒充密文） | 预期并实际 **设置存储单元测试"磁盘上不含 Key 明文"失败**，改回后恢复 169 项通过 |
| 变异测试 ②（把配置文件里的 Key 改成优先于环境变量） | 预期并实际 **"环境变量存在时 getApiKey 返回环境变量"失败**，改回后恢复 |
| 变异测试 ③（让可重试判断永远返回 false，去掉重试） | 预期并实际 **客户端测试"重试一次（共 2 次请求）"多组失败**，改回后恢复 217 项通过 |
| 变异测试 ④（把 401 归到普通错误码） | 预期并实际 **"401 返回 auth-failed"失败**，改回后恢复 |
| 变异测试 ⑤（把 endpoint 换成另一个域名） | 预期并实际 **"请求 URL 是写死的智谱 endpoint"失败**，改回后恢复 |
| 变异测试 ⑥（把 Key 一起放进 `getPublicSettings()`） | 预期并实际 **"getPublicSettings 序列化后不含 Key 明文"失败**，改回后恢复 |
| 变异测试 ⑦（让桌宠 preload 也带一条 `settings:save`） | 预期并实际 **烟测"桌宠 preload 里没有 settings:* 通道"失败**，改回后恢复 424 项通过 |
| 变异测试 ⑧（设置通道不再做来源校验） | 预期并实际 **烟测"3 个设置通道全部通过来源校验包装注册"失败**，改回后恢复 |
| 变异测试 ⑨（把默认超时改成 15ms） | 预期并实际 **"默认超时是 15 秒"失败**，改回后恢复 |
| 变异测试 ⑩（设置页用 `innerHTML` 渲染云端返回） | 预期并实际 **烟测"设置页的结果输出用纯文本"失败**，改回后恢复 |
| 变异测试 ⑪（设置存储去掉 `rename`，不做原子写入） | 预期并实际 **"写入走临时文件 + rename"失败**，改回后恢复 |
| 变异测试 ⑫（把空正文也当成成功返回） | 预期并实际 **响应格式异常一组 `bad-response` 断言失败**，改回后恢复 |
| 变异测试 ⑬（缺陷 A：把 `messages` 改回 history + user，去掉 system） | 预期并实际 **客户端测试"system 在 messages[0]"一组失败**，改回后恢复 |
| 变异测试 ⑭（缺陷 B：preload 先做通用控制字符过滤再判哨兵） | 预期并实际 **preload 行为测试"精确哨兵被原样透传"失败**，改回后恢复 35 项通过 |
| 变异测试 ⑮（缺陷 C：preload 对非法草稿 Key 静默略过后仍调用主进程） | 预期并实际 **preload 行为测试"过短的草稿 Key 不调用主进程"失败**，改回后恢复 |
| 变异测试 ⑯（缺陷 E：fetch 一拿到 headers 就 `clearTimeout`） | 预期并实际 **客户端测试"body read 卡住会被归类为 timeout"失败**，改回后恢复 217 项通过 |
| 变异测试 ⑰（缺陷 F：去掉 `staleCipherToClear`，不覆盖旧密文） | 预期并实际 **设置存储测试"旧密文被空 keyEncrypted 覆盖清除 / 重启后旧 Key 不会复活"失败**，改回后恢复 169 项通过 |
| `node work/npm-bootstrap/package/bin/npm-cli.js start`（阶段 3 本地终端实测） | ✅ Electron 主窗启动成功；日志出现 `idle → greet → idle → blink`，safeStorage 显示可用（backend=`os-encryption`）；未点击设置页、未填 Key、未发网络请求 |

### 阶段 2 实际执行过的命令与结果（保留，未失效）

| 命令 | 结果 |
| --- | --- |
| `node tests/state-machine.test.js` | **119 项全部通过**（假时钟驱动真实状态转移；缺陷修复阶段新增 25 项） |
| `node tests/fullness.test.js` | **71 项全部通过**（假时钟 + 假存储，含离线 75 分钟 / 3 天） |
| `node tests/swim-plan.test.js` | **45 项全部通过**（16ms 逐帧扫描越界、屏幕外 / 超大窗口 / 负坐标副屏） |
| `node tests/smoke.test.js`（等价 `npm run smoke`） | 当时 **290 项全部通过，退出码 0**（阶段 3 缺陷修复后同一份脚本已扩展到 424 项） |
| `node work/npm-bootstrap/package/bin/npm-cli.js run test:unit` | 三个单元测试串行执行，当时 **235 项全部通过，退出码 0** |
| `node work/npm-bootstrap/package/bin/npm-cli.js run test` | 单元测试 + 烟测一次跑完，当时 **525 项全部通过，退出码 0** |
| 所有非 `node_modules` / `work/npm-bootstrap` 的 JS 文件 `node --check` | 全部通过（只编译不执行） |
| `node tools/build-renderer.js --check` | 通过：内联 SVG 与 `assets/fish.svg` 一致 |
| 变异测试 ①（放行 `random` 唤醒睡觉的鱼） | 预期并实际 **10 项状态机单元测试 + 2 项烟测失败**，改回后恢复全绿 |
| 变异测试 ②（把 `swim-plan.js` 的 `clamp` 改成直接返回原值） | 预期并实际 **13 项游动单元测试失败**，改回后恢复 45 项通过 |
| 变异测试 ③（从渲染层 `STATE_CLASSES` 里删掉 `state-swim`） | 预期并实际 **烟测"STATE_CLASSES 与 PET_STATES 逐项一致"失败**，改回后恢复 |
| 变异测试 ④（在 CSS 里加回 `#fish-svg #eyes-smile { opacity: 0 }` 这种 id 默认隐藏写法） | 预期并实际 **烟测"关掉了 id 默认隐藏写法"失败**，改回后恢复 |
| 变异测试 ⑤（去掉 `startAction()` 的 `emit`，复现原始缺陷） | 预期并实际 **10 项状态机单元测试失败（全部报 `changes=0`）**，改回后恢复 119 项通过 |
| 变异测试 ⑥（让 `announce()` 重新请求 `talking`，复现"无声说话"） | 预期并实际 **2 项烟测回归⑥失败**，改回后恢复 |
| 变异测试 ⑦（把 `state !== 'swim'` 改成 `false`，去掉游动取消） | 预期并实际 **2 项烟测回归⑦失败**，改回后恢复 |
| 变异测试 ⑧（把 `setBase` 睡觉保护改回 `source === 'mood'`） | 预期并实际 **3 项状态机单元测试失败**，改回后恢复 119 项通过 |

`npm run smoke` 的检查覆盖（阶段 3 增补后）：

- 启动所需文件齐全；所有 JS 通过解析检查（等价 `node --check`，只编译不执行）
- `package.json`：主入口、`npm start` / `smoke` / `test:unit` 脚本、依赖只有 `electron`、无额外运行时依赖
- `renderer/index.html` 的内联 SVG 与 `assets/fish.svg` **逐字节一致**
- SVG 规范：纯矢量、无位图引用、无 emoji、深海蓝配色、含身体/眼睛/鱼鳍/尾巴/小白碗与米饭、
  含阶段 2 的全部情绪符号（爱心 / 彩色泡泡 / 问号 / 怒火 / 饿纹 / 游动水泡 / 眯眼 / 眉毛 / 瘪嘴），
  且每个符号都靠 `opacity="0"` **表现属性**默认隐藏（不用 id 选择器，避免特异度压过状态类）；
  注释符合 XML 规范、标签嵌套正确
- SVG 分层：`#fish-root`（持久模式动画）与 `#fish-action`（短暂动作动画）存在且嵌套正确
- 状态机覆盖：`PET_STATES`（16 项）= preload 的 `ALLOWED_ACTIONS` = 渲染层 `STATE_CLASSES`
  = CSS 规则集合，任一处漂移即失败
- CSS：16 个状态类 / 4 个持久模式类都有规则，15 个非 idle 状态的关键帧确实驱动
  `animation` / `opacity` / `transform`（不是空占位类）
- 无可见文字气泡：`index.html` 没有 `#state-text`，渲染层没有台词文案，只保留 `.sr-only` 的 aria-live
- 主进程安全配置：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、
  透明/无边框/置顶/不占任务栏/`workArea` 定位/导航拦截/单实例/托盘/关闭到托盘
- **七项回归检查**（都是真实静态 / 可执行断言，故意改坏代码会立刻失败 —— 已用变异测试验证）：
  ① 沙箱 preload 顶层只 `require('electron')`、不含任何本地相对 `require`，
  且内部 `IPC_CHANNELS`/`PET_EVENTS` 与主进程逐项一致；
  ② 托盘右键绑定 `tray.popUpContextMenu(buildMenu())`，鱼身右键仍走 `menu.popup` 且省略 `x/y`，
  全文件只有一处 `Menu.buildFromTemplate(`，`screen.getCursorScreenPoint(` 仍只允许出现在初始定位处；
  ③ 「睡觉」菜单项先 `showPetWindow` 再 `sendAction('sleep')` 并用 `announce:false`，
  「喂饭」菜单项先唤出再 `sendFeed()`；
  ④ 8 个桌宠通道 + 3 个设置通道全部出现在来源校验包装函数内部，校验主 frame + 各自本地 URL；
  ⑤ 状态白名单三方一致（ipc-channels / preload / renderer）；
  ⑥ **没有 TTS 就不许"无声说话"**：`announce` 只改不可见 aria-live 文本、全文件无 `mouthMs`、
  `machine.request('talking')` 只出现在 `beginSpeech`（情绪变化不自动请求 talking）；
  ⑦ **游动被打断必须收手**：`REPORT_STATE` 先做 `PET_STATES` 白名单校验，再在
  `state !== 'swim'` 且存在 `swimAnimation` 时 `cancelSwim('state-changed')`；
  报告 `swim` 自身不会自取消，且渲染层仍只能上报状态字符串、不能传坐标
- 游动专项：通道已登记、走来源校验包装、`requestSwim()` 无参数、用 `getBounds` + `getDisplayMatching`
  + `workArea`、用纯函数规划、逐帧 `setPosition`、各条清理路径齐全（含渲染层状态切走 swim）、渲染层不传坐标
- **可执行单元检查**（烟测里现场 require 真实实现并驱动）：
  `normalizeFileUrl` 归一化；状态机真实状态转移（greet 回落 / 睡觉拒绝随机与系统动作 /
  用户戳醒 / 眨眼回落 / eat→happy 串场 / 拖拽拒绝其它动作 / dispose 清空定时器）；
  饱食度阈值（70 分钟 hungry、80 分钟 angry、500 分钟不为负、喂饭回满、损坏 JSON、未来时间戳、
  离线 75 分钟恢复为 25、离线后喂饭落盘）；游动限幅（16ms 逐帧不越界、游完回起点、屏幕外归位、
  超大窗口不产生负范围、非法参数返回 null）
- 只使用 Electron / Node 内置模块 / 本地文件（无第三方 require）
- 菜单六项齐全；「语音对话」只给"后续阶段"提示；提示里明确说明不会用文字气泡冒充语音
- **缺陷修复 A–F 的静态断言**：内置鱼设 system 提示词（白米饭 / 傲娇 / 哼 / 才不是 / 本鱼 /
  克制 / 不嘲讽）、system 固定 `messages[0]` 且裁剪只从下标 1、`MAX_REPLY_CHARS = 30` +
  `limitReply` 按 code point 截断、超时定时器只在 `finally` 清理、preload 先精确判哨兵再过滤控制字符、
  非空非法 Key / 模型本地报错、设置通道恰好三条（无 `settings:chat`）、设置页无 `probe-*` /
  `onProbe` / `api.chat`、测试连接返回值不含 `content`、settings-store 的 `staleCipherToClear`
- 源码中没有硬编码 API Key；`localStorage` 序列化字段里没有 key / token / secret
- `assets/tray-icon.png` 是合法 32×32 PNG，`tray-icon@2x.png` 是合法 64×64 PNG

### 阶段 1 的真实运行验证记录（保留，未失效）

| 命令 | 结果 |
| --- | --- |
| `npm install --no-audit --no-fund` | 成功：新增 13 个包，`postinstall` 重新生成了托盘图标 |
| `npm start`（本地 `npm-cli.js` 引导 npm） | 成功启动：Electron 44.5.1 下载完成，桌面进程正常运行 |
| 启动后渲染层日志 | 依次为 `idle` → `greet` → `idle`（会话日志，非交互测试） |
| `node tools/make-icons.js` | 成功，生成 32×32 与 64×64 托盘 PNG（已肉眼确认图形正确） |
| `powershell -File tools\make-icons.ps1` | 成功（Windows PowerShell 5.1 与 PowerShell 7 均验证通过） |

**关于 `npm start` 的准确说明：**

- 本机系统 PATH 里没有 npm，也没有全局安装 Electron。验证时是在 `D:/BlueFatFish/work/npm-bootstrap`
  临时引导 npm 12.2.0，再用它执行 `npm install` 与 `npm start`（`package.json` 里 Electron 为 `^44.5.1`）。
  该 bootstrap 目录只是本机的临时引导产物，不是项目运行依赖。
- 第一次 `npm start` 在下载 Electron 时从 GitHub 拿到 **HTTP 400**；按官方高级安装文档的说明设置
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `electron_use_remote_checksums=1`
  （走镜像 + 远程 SHA-256 校验）后，Electron 44.5.1 成功下载，桌面进程正常启动。

### 未能验证 / 证据有限的部分（必须说清楚，不能当作已验证）

- ⚠️ **DeepSeek Harness 在阶段 2 的子进程启动尝试失败**：两次尝试（普通启动、以及带 `--user-data-dir` 的干净启动）
  都在 Electron **自身的启动自检**阶段退出，输出为：
  ```
  FATAL:electron\shell\browser\win\install_dir_access.cc:52] Sandboxed processes cannot read
  D:\BlueFatFish\node_modules\electron\dist: its ACL has an entry for an AppContainer package SID
  but none for ALL APPLICATION PACKAGES, so Windows denies the sandbox token access.
  Grant it with: icacls "D:\BlueFatFish\node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX)
  ```

  也就是说：这个开发会话给工作区目录附加了一条会话 / AppContainer 形式的 ACL 条目
  （`icacls D:\BlueFatFish` 可见 `S-1-4-455317310-65231235`），而 Electron 的 AppContainer 沙箱子进程
  需要 `ALL APPLICATION PACKAGES` 的读取权限，两边对不上，Electron 在**加载任何应用代码之前**
  就 FATAL 退出。**这不是阶段 2 代码的问题**：同一个命令在带干净 `--user-data-dir` 的情况下
  仍然在同一处失败。
- ⚠️ **DeepSeek Harness 在阶段 2 缺陷修复任务中再次尝试 `npm start`，结果完全相同**（安全配置一字未改：
  `sandbox: true`、`electron .` 不带任何 `--no-sandbox` / `--disable-gpu-sandbox` 参数）：

  ```
  npm notice run blue-fat-fish@0.2.0 start
  npm notice run electron .
  ERROR:chrome\browser\process_singleton_win.cc:318] Lock file can not be created: 拒绝访问。 (0x5)
  FATAL:electron\shell\browser\win\install_dir_access.cc:52] Sandboxed processes cannot read
  D:\BlueFatFish\node_modules\electron\dist: ... Grant it with:
  icacls "D:\BlueFatFish\node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX)
  ```

  连"创建单实例锁文件"都被会话 ACL 拒绝，Electron 进程在初始化阶段就退出（退出码 1）。
  **本轮没有修改任何 ACL、没有关闭沙箱、没有使用 `--no-sandbox`** —— 只如实记录。
- ⚠️ **DeepSeek Harness 在阶段 3 的子进程启动探针仍遇到相同 ACL FATAL**（`sandbox: true`、
  设置窗口也是 `sandbox: true`，未使用 `--no-sandbox` / `--disable-gpu-sandbox`）。
  但 Codex 随后在本地终端直接运行 `node work/npm-bootstrap/package/bin/npm-cli.js start` **成功启动了 Electron 主窗**，
  日志为 `idle → greet → idle → blink`；配置日志显示 safeStorage 可用、backend=`os-encryption`。
  两种启动结果不同，保留 Harness 的错误作为环境差异记录，不把它当成本地终端的最终结果：

  ```
  ERROR:chrome\browser\process_singleton_win.cc:318] Lock file can not be created: 拒绝访问。 (0x5)
  FATAL:electron\shell\browser\win\install_dir_access.cc:52] Sandboxed processes cannot read
  D:\BlueFatFish\node_modules\electron\dist: its ACL has an entry for an AppContainer package SID
  but none for ALL APPLICATION PACKAGES, so Windows denies the sandbox token access.
  ```
- ⚠️ 该 FATAL 给出的修复命令 `icacls … /grant *S-1-15-2-1:(OI)(CI)(RX)` 在 DeepSeek Harness
  的子进程环境被拒绝（`Access is denied.`）；Codex 本地终端后续启动成功，因此没有必要改 ACL。
  整个过程**没有**用 `--no-sandbox` 绕过，也没有降低沙箱安全要求。
- ⚠️ **设置窗口在本会话里没有通过菜单实际打开过**：窗口尺寸/布局、表单交互、CSP 是否确实拦住外链，
  仍只有代码层 / 静态检查 / 纯逻辑单测的保证，**没有肉眼验证**。
  Electron 主窗启动时已实际观察到 safeStorage `可用=true`、backend=`os-encryption`；
  但没有录入真实 Key，所以 `encryptString` / `decryptString` 与配置文件落盘/重启读取仍未端到端验证。
  若其他机器显示 `可用=false`，
  程序会按设计降级为"仅本次会话"并在界面上明确提示（不会明文落盘）。
- ⚠️ **本轮缺陷修复的端到端效果未在真机验证**：内置鱼设 system 提示词 / 30 字回复上限、
  精确哨兵清除 Key、非法草稿 Key 本地拒绝、body read 超时、session-only 换 Key 清旧密文，
  全部只有**单元 / 行为测试 + 静态检查**的证据（用假 fetch、假 safeStorage、假 fs、VM mock
  electron）。真机上"模型是否听话只回 30 字以内""清除后配置文件里的密文是否真的没了"
  仍需按上面「请人工确认」第 12 条手动点一遍。测试连接**没有**任何真实网络请求。
- ✅ **本轮"能捕获缺陷"已用变异测试验证**：把 system 提示词去掉、把 preload 的哨兵判定放到
  控制字符过滤之后、让非法草稿 Key 静默 fallback、把超时改回"拿到 headers 就 clearTimeout"、
  去掉 `staleCipherToClear`，对应的 A–F 回归断言都会失败（见上文变异测试 ⑬–⑰）。
- ⚠️ **阶段 2/3 主窗虽已成功启动，但未做截图或逐项人工交互验收**：
  CSS 动画观感、SVG 符号、游动窗口动画是否顺滑，仍没有肉眼截图证据；菜单、拖拽等也未逐项手动操作。
- ❌ **本轮没有向智谱发起过任何真实请求**：所有对话 / 超时 / 重试 / 401 的验证都用注入的
  假 `fetch`，因为本会话**没有任何 API Key**，也不允许为了验证去申请或硬编码 Key。
  endpoint / headers / body 的构造有断言保证，但"真实云端能不能通"需要你自己配 Key 后
  点一次「测试连接」才能确认。
- ❌ **动态交互无法用自动化验证**：`SetCursorPos` 鼠标输入注入被系统拒绝，因此
  拖拽、双击、单击、摸头、右键菜单、托盘点击等**没有做过自动化验证**，
  菜单「喂饭 / 睡觉 / 叫醒 / 设置」也没有在真机上点过。
- ✅ **阶段 1 已验证（仅限以下范围）**：Electron 44.5.1 确实下载并启动，渲染层日志按
  `idle` → `greet` → `idle` 变化，且在 360×340 鱼窗预览里确认**鱼体显示正常**。
  注意：那是阶段 1 的美术与代码；阶段 2 重画了 SVG（新增情绪符号与两层结构），
  这份"显示正常"的证据**不能直接套用到阶段 2 的新图形上**。
- ⚠️ **只截取了窗口矩形预览，没有截取整屏**：确认鱼体显示的证据是那块 360×340 的鱼窗矩形，
  鱼在桌面上的实际位置、与其它窗口的层叠关系（置顶表现）没有截图证据。
- ❌ **仍未人工验证的项（不要当成已验证）**：窗口透明度/背景透明、拖拽移动、双击打招呼、
  单击被戳、摸头、右键菜单与托盘菜单、托盘点击唤回、菜单项「喂饭/睡觉/叫醒/设置」、
  随机眨眼 / 发呆 / 翻肚皮 / 游动、饱食度长时间下降与 hungry/angry 切换、
  单实例唤出、退出行为、设置窗口的保存与真实「测试连接」。

**请在装有 Node 22 + npm 的 Windows 机器上按下面步骤复现验证：**

```powershell
cd D:\BlueFatFish
npm install                 # 安装 electron
npm run test:unit           # 当前基线：1684 项全部通过
npm run test:voice          # 当前基线：1028 项全部通过（已包含在 test:unit 中）
npm run smoke               # 当前基线：539 项全部通过
npm test                    # 当前基线：2223 项全部通过，退出码 0
npm start                   # 期望：右下角出现漂浮的蓝色胖鱼
# 逐项手动确认：
#   1. 鱼是深蓝胖椭圆 + 大眼睛 + 小短鳍小尾巴，背景透明
#   2. 窗口始终置顶；拖动任务栏/其它窗口不会被盖住
#   3. 左键拖动鱼能移动窗口并进入"挣扎"姿态；双击打招呼；单击弹跳冒汗
#   4. 鼠标在鱼头上停留约 0.7 秒 → 眯眼 + 头顶爱心；移开后过一会儿再摸还能触发
#   5. 右键鱼身弹出菜单，紧贴鼠标光标位置
#   6. 点「喂饭」出现小白碗、米粒逐粒消失、咀嚼约 3 秒后转为转圈冒彩色泡泡
#   7. 点「睡觉」闭眼冒 Zzz；睡着的鱼不会被随机动作吵醒（观察至少 2 分钟）；
#      点「叫醒」睁眼，且如果一直没喂饭，醒来后仍是瘪嘴的 hungry 姿态
#   8. 关闭窗口 → 鱼消失但托盘图标仍在；托盘左键 → 鱼回来；
#      关闭后在托盘点「睡觉」→ 窗口自动唤出并看到鱼睡着
#   9. 观察 3~6 分钟一次的自发游动：从屏幕一侧游到另一侧再游回原位，
#      全程不出工作区；游动中拖动鱼会立刻停下并复位
#  10. 长时间不喂饭（或把系统时间往前调）→ 饱食度下降 → 瘪嘴 hungry →
#      再过 10 分钟鼓腮瞪眼 angry；喂饭立刻回满并转开心
#  11. 语音验收前先阅读隐私提示：阶段 4 没有唤醒词，麦克风默认开启；确认操作系统权限和输入设备
#      · 右键菜单「语音对话」与 Ctrl+Shift+V 均能切换麦克风；关闭后确认不再采集
#      · 配置有效 Key 后实际说一句话，观察 ASR → 聊天 → TTS 回合及鱼头轻提示
#      · 播报期间确认麦克风采集暂停，播报完成后只在麦克风仍开启时恢复
#      · 分别检查字幕开/关、音量、VAD 灵敏度、静音判定时长与音色设置
#  12. 点「设置」→ 打开本地设置窗口（普通窗口，能缩放/最小化，出现在任务栏）
#      · 设置页是本地内容且不能由 renderer 直接联网；配置了 Key 时启动会有一次最小有效性检查
#      · 不填 Key 直接点「测试连接」→ 应显示"还没有配置 API Key…"且不崩
#      · 粘贴一个真实 Key → 保存 → 输入框应被清空，状态变成"已配置（safeStorage 加密保存）"
#      · 去应用实际 app.getPath('userData') 目录下检查 settings.json：**看不到 Key 明文**，只有加密值
#      · 点「测试连接」→ 成功时只显示模型名与耗时（**不应出现模型生成的任何句子**）；
#        把 Key 改错再测 → 显示"API Key 无效或已过期"，且不会弹出成堆的错误框
#      · 输入一个明显非法的短 Key 再点「保存设置 / 测试连接」→ 应**本地立即提示格式不对**，
#        且不会"保存成功"或"连接成功"（更不会偷偷用上一个已保存的 Key）
#      · 设置页**没有**自由文本聊天框 / "发送一条"按钮；语音设置不代表提供文字聊天面板
#      · 设了环境变量 ZHIPU_API_KEY 时 → 状态显示"来源：环境变量"，且测试连接依然可用
#      · 设置窗口里按 F12 之外的任何"点链接/开新窗口"尝试都应该没有任何反应
#  13. 点「退出」→ 进程结束，托盘图标消失
```

---

## 常见问题

**Q：`npm` 不是内部或外部命令 / `electron` 找不到？**
A：正常用户请安装带 npm 的 Node.js（22.x）。本项目只把 Electron 放在 `devDependencies`，
执行 `npm install` 后 `npm start` 会自动使用本地 `node_modules/.bin/electron`。

本开发机只有 Node 24、系统 PATH 里没有 npm，验证时是在 `work/npm-bootstrap` 里临时引导
npm 12.2.0 来完成 `npm install` / `npm run` / `npm start` 的；那只是本机的临时引导，不是项目依赖。

**Q：`npm install` 成功，但第一次 `npm start` 下载 Electron 时 GitHub 返回 HTTP 错误（如 HTTP 400）？**
A：这是首次启动要从 GitHub 拉 Electron 二进制失败。可在**同一个 PowerShell 会话**里先设置
镜像与远程校验，再启动（Electron 官方高级安装文档说明了镜像与校验方式）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:electron_use_remote_checksums='1'
npm start
```

- 这两条只是**当前会话级**的环境变量，关闭这个 PowerShell 窗口即失效，不会写进系统或项目配置。
- `ELECTRON_MIRROR` 让下载走 npmmirror 镜像；`electron_use_remote_checksums=1` 让安装器从镜像
  下载 SHA-256 校验文件并校验产物完整性，而不是只信任本地校验和。
- 验证记录：设置这两项后 Electron 44.5.1 成功下载、桌面进程正常启动。

**Q：启动时报 `install_dir_access.cc` FATAL，说 `node_modules\electron\dist` 的 ACL 有问题？**
A：这是 Windows 的 AppContainer 权限问题：Electron 的沙箱子进程需要能读取自己所在的安装目录，
但该目录的 ACL 里缺少 `ALL APPLICATION PACKAGES`（`S-1-15-2-1`）的读取权限。
按报错提示在**一个普通（非受限）PowerShell 窗口**里执行一次即可：

```powershell
icacls "D:\BlueFatFish\node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX)
```

本开发会话的工作区被附加了会话级 ACL，且该命令被沙箱拒绝，因此阶段 2 里没有在本机启动成功
（详见上文「未能验证 / 证据有限」）。**不要用 `--no-sandbox` 绕过**：那会破坏桌宠的安全架构。

**Q：鱼是黑色的方块 / 背景不透明？**
A：透明窗口在部分远程桌面、虚拟机或关闭了桌面合成的环境下不支持。请确认是本地
Windows 11 会话，并检查系统「透明效果」是否被关闭。

**Q：鱼挡住了桌面图标点不到？**
A：设计上只有光标落在**鱼身图形上**才拦截鼠标，透明区域是穿透的。若某个区域仍挡住
操作，通常是那条路径/椭圆的绘制范围比看上去大，可在 `assets/fish.svg` 里微调。

**Q：改了 `assets/fish.svg` 但界面没变？**
A：需要重新注入：`node tools/build-renderer.js`（`npm run smoke` 会提示不一致）。

**Q：为什么鱼不说话、也没有文字气泡？**
A：阶段 4 已接入连续语音，但必须有可用输入设备与麦克风权限。若要使用智谱云端 ASR/聊天/TTS，
还需要配置有效 Key；若没有 Key，本地 faster-whisper（安装依赖、模型与满足显存条件时）只负责识别，
不会把本地识别文本发给云端聊天。字幕默认关闭，可在设置中开启。当前没有唤醒词，麦克风开启后
会持续本地监听并自动断句；不想持续监听时，请通过右键菜单「语音对话」、`Ctrl+Shift+V`
或设置页关闭麦克风。真实设备与 API 尚未人工验收，自动化测试通过不代表真实环境一定可用。

**Q：设置窗口里还有「发送一条」这种接口自检 / 聊天框吗？**
A：**已经删除了。** 阶段边界要求"无可见文字聊天面板、不把文本冒充语音"，所以这一轮把
设置页的自由文本输入、回复展示、`settings:chat` 通道与 preload 的 `chat` 全部移除。
设置页提供 Key、模型、「测试连接」及语音选项；测试连接只显示**连接成功 / 失败与耗时**，
不会显示模型生成的任何句子。语音回合的聊天接口仍由主进程调用，不提供自由文本聊天框。

**Q：我的 API Key 存在哪？会不会被别人看到？**
A：Key 只经过主进程：从设置页读入 → `safeStorage.encryptString()` 加密 →
写入 `app.getPath('userData')` 目录下 `settings.json` 的加密字段。不同机器/应用环境的 userData 路径可能不同，
不要假设一定是 `%APPDATA%\blue-fat-fish`。
它**不会**回到页面、不会进日志、不会出现在任何错误信息里（单元测试对这几条都有断言）。
Windows 上 `safeStorage` 走 DPAPI，密文绑定当前用户账户 —— **请照常保护好你的 Windows 登录密码**：
同一个账户下的其它程序（或以你的身份运行的程序）仍然可以解密使用。
想让应用彻底忘记这个 Key：在设置页点「清除本机保存的 Key」。

**Q：我设了 `ZHIPU_API_KEY`，为什么设置页说"来源：环境变量"？**
A：这是设计如此：**环境变量优先**，它会压过设置页里保存的 Key。这样你可以在 CI / 临时会话里
用环境变量覆盖本机配置，而不用去改配置文件。界面上只显示"来源"，**不会显示环境变量的值**。

**Q：点击「测试连接」需要等多久？会不会卡住界面？**
A：超时 15 秒，失败最多再重试一次（只对网络 / 超时 / 5xx / 限流重试），所以最长约 30 秒。
按钮在请求期间会置灰并显示"请求中…"，设置窗口本身不会卡死（请求在主进程里，界面照常响应）。
401（Key 无效）不会重试，会立刻返回并提示去 open.bigmodel.cn 重新申请。

**Q：设置页会不会偷偷联网？**
A：设置页的 CSP 里 `connect-src 'none'`，页面自己发不出任何网络请求；云端请求由主进程发起。
打开设置页本身不会联网；用户点击「测试连接」会发起测试，配置了 Key 时应用启动还会发一次最小有效性检查，
没有 Key 时启动检查不发请求。语音对话会按实际回合发起 ASR/聊天/TTS 请求；音频或文本可能发送给
相应云服务。`edge-tts` 是在线服务，不是离线后备。

**Q：鱼会自己动吗？会不会影响我干活？**
A：会：随机眨眼、偶尔发呆 / 翻肚皮 / 开心，每 3~6 分钟自己游一次（横跨当前显示器工作区再游回来）。
所有随机行为都只在**窗口可见、没有在睡觉、没有正在被拖拽 / 摸头 / 拖动**时发生；
鼠标停到鱼身上、或开始拖拽时，游动会立刻停止并复位。想让它安静就点菜单「睡觉」。

**Q：饱食度存在哪里？会不会存我的隐私？**
A：只存在渲染层的 `localStorage`，键名 `blueFatFish.fullness.v1`，
内容只有 `{version, value, savedAt, hungrySince}` 四项 —— 没有 API Key、没有聊天记录、没有任何隐私数据。
想重置就把这个键删掉（或换个 Electron 用户数据目录）。

**Q：托盘图标变成纯蓝色方块？**
A：说明 `assets/tray-icon.png` 缺失（代码里的兜底占位图）。运行 `npm run icons` 生成。

**Q：`npm run icons` 报 PowerShell 错误？**
A：默认的 `npm run icons` 已改用零依赖的 Node 脚本 `tools/make-icons.js`。
若你改用 `tools/make-icons.ps1`，注意该文件带 UTF-8 BOM（供 Windows PowerShell 5.1
正确识别中文），**编辑时不要去掉 BOM**。

**Q：怎么彻底退出？**
A：托盘右键 → 「退出」（或鱼身右键 → 「退出」）。关闭窗口 / Alt+F4 只是收进托盘。

---

## 下一阶段建议（按依赖顺序）

阶段 1–4 的代码与自动化逻辑已完成；下一步按依赖顺序建议：

1. **阶段 5 · 唤醒词与防误触**：实现唤醒词/近音匹配、监听门控、误触发冷却和陪玩期间门控。完成前，麦克风开启时会持续监听且没有唤醒词。
2. **阶段 6 · 游戏陪玩 / 战术思路**：依需求实现屏幕采集与缩放压缩、GLM-4.6V-Flash 点评、节流、语音优先和首次开启隐私告知；目前尚无截屏代码。
3. **阶段 7 · 战场报点（可选）**：评估本地轻量人形检测与显存检查/CPU 回退，严格禁止读取游戏内存、进程注入和游戏内叠加层。
4. **最后 · 启动入口与安装器**：桌面快捷方式、HKCU 开机自启、单实例联动及打包安装器。

阶段 4 的真实麦克风、真实云端 API、edge-tts 和 faster-whisper 仍需用户在目标 Windows 设备上人工验收。后续工作仍须按 `需求说明.md` 的「你的工作方式」逐阶段推进；当前不代表整体验收通过。
