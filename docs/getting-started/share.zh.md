# 可分享版：酒店语音任务 Demo

这份说明用于把当前 `hotel-direct` 语音任务 Demo 交给另一位已经有 Agent 的使用者。
目标是让对方完成最少配置后即可启动：语音模型负责实时对话，Gateway 直接调用任务 API；
不要求安装 OpenClaw，也不要求先接入 DSH。

## 先说清楚：仓库不包含任何可用凭证

下面这些内容不能写进 README、代码、截图、提交记录或压缩包：

- 业务账号、密码和登录验证码；
- DashScope / Qwen API Key；
- Spirit 任务 API Token；
- Context Service Token；
- 通知服务、文件上传和其他第三方凭证。

接收方应通过私下渠道拿到自己的值，并只写入本机配置文件。当前仓库中的固定人员、
酒店和任务数据只是 Demo 目录，用于验证工具链路；正式使用前必须用接收方自己的酒店、
用户身份和每日上下文替换。

## 最短启动路径

### 1. 安装

```bash
npm install
npm run build
```

需要 Node.js 22.22.2+ 或更高版本，以及 npm 10+。

### 2. 建立本地配置

复制 `config/hotel-direct/config.env.example` 到 qwen-audio-agent 的用户配置文件：

```text
~/.config/qwaudio/config.env
```

Windows 通常是：

```text
%USERPROFILE%\.config\qwaudio\config.env
```

也可以先运行：

```bash
qwenaudio config
```

再把酒店 Demo 所需的变量补进去。配置文件只保存在本机，不要提交到 Git。

### 3. 最小配置项

```dotenv
# 实时语音模型
DASHSCOPE_API_KEY=<私下提供给接收方的实时模型 Key>
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus

# 直接调用任务 API；不经过 DSH，也不要求后台 Agent
AGENT_PROTOCOL=none
QWEN_AUDIO_AGENT_TOOL_PROFILE=hotel-direct

# 当前登录用户的业务身份。这里填接收方自己的值，不要让模型口述或猜测。
QWEN_AUDIO_CONTEXT_ID=<daily-context-id>
QWEN_AUDIO_CONTEXT_USER_ID=<business-user-id>

# 任务 API
SPIRIT_API_BASE_URL=<接收方任务 API 地址>
SPIRIT_BEARER_TOKEN=<接收方任务 API Token>
```

如果暂时没有 Context Service，可以先用本地 Mock：

```dotenv
QWEN_AUDIO_CONTEXT_MODE=mock
```

这只能用于演示。生产环境应改成：

```dotenv
QWEN_AUDIO_CONTEXT_MODE=http
QWEN_AUDIO_CONTEXT_SERVICE_URL=<接收方 Context API 地址>
QWEN_AUDIO_CONTEXT_SERVICE_TOKEN=<接收方 Context API Token>
QWEN_AUDIO_CONTEXT_FALLBACK_TO_MOCK=false
```

### 4. 启动

```bash
qwenaudio
```

浏览器打开：

```text
http://127.0.0.1:3101/
```

健康检查：

```text
http://127.0.0.1:3101/api/health
```

确认 `voiceToolProfile` 为 `hotel-direct`，并且 `contextService.status` 为 `ready` 后，
再进行任务查询、创建、修改和通知测试。

## 对方已有 Agent 时怎么处理

当前酒店 Demo 的任务工具是 Gateway 直连 API，后台 Agent 不是必需项。因此最小配置可以
使用：

```dotenv
AGENT_PROTOCOL=none
```

如果对方还希望保留后台 Agent 来处理通用复杂任务，只需把这一项改为对方已经配置好的
Agent，例如：

```dotenv
AGENT_PROTOCOL=<对方已有的 Agent>
```

不要把 OpenClaw、Kimi、Codex 等 Agent 的登录信息复制进本项目。Gateway 会按对方本机
已有的 Agent 配置连接；酒店任务仍然走 `hotel-direct` 的直接工具。

## 当前写死内容与替换边界

当前版本为了快速验证，仍有一部分 Demo 资产：

| 内容 | 当前用途 | 分享给新用户前的处理 |
| --- | --- | --- |
| `SPIRIT_DEMO_CHANNEL` | Demo 酒店的渠道、平台和角色参数 | 改成接收方业务系统要求的值 |
| `SPIRIT_DEMO_STAFF` | 按姓名、房号、楼层匹配执行人 | 接入真实人员 API 或替换为对方 Demo 人员 |
| `SPIRIT_DEMO_SELF_TEST_ACCOUNT` | 自测任务的虚拟执行人 | 仅保留自测，不用于真实通知 |
| `config/hotel-direct/context-mock/` | Context Service 的本地形状 Mock | 只做临时演示；正式环境切换到 HTTP Context API |
| `QWEN_AUDIO_CONTEXT_USER_ID` | 当前业务用户身份 | 每个使用者都应替换成自己的用户 ID |

这里的“写死”是 Demo 配置，不代表生产身份模型。真正的生产链路应当是：登录或 DSH
Host 提供可信身份，Gateway 再按身份查询 Context 和任务数据。

## Context API 之后如何替换

本项目已经预留了生产接口形态：

```http
GET /v1/voice-contexts/:contextId?userId=<trusted-user-id>
Authorization: Bearer <context-service-token>
```

接收方只需要把 `QWEN_AUDIO_CONTEXT_MODE` 改为 `http`，填写 Context Service 地址和
Token，并让 Context Service 返回以下结构：

```json
{
  "contextId": "daily-context-id",
  "version": "2026-08-21-01",
  "generatedAt": "2026-08-21T06:00:00+08:00",
  "expiresAt": "2026-08-22T06:00:00+08:00",
  "subject": {
    "userId": "business-user-id",
    "displayName": "当前用户",
    "hotelId": "hotel-id"
  },
  "prompt": "<hotel_operations_voice_context>...</hotel_operations_voice_context>",
  "estimatedTokens": 3000
}
```

Gateway 会校验 `contextId`、用户身份、时间有效期和上下文长度，再把结果注入全双工
Realtime Session。当前 Mock 只是这个接口的本地替身，不是最终知识库。

## 发布前检查

分享压缩包或代码地址前，逐项确认：

1. `.env`、`.env.local`、用户配置目录和日志没有被打包；
2. README、示例配置和截图中没有真实 Key、密码、Token 或个人账号；
3. `SPIRIT_BEARER_TOKEN`、`QWEN_AUDIO_CONTEXT_SERVICE_TOKEN` 仍是占位符；
4. Demo Context 和人员数据已替换为公共样例，或明确标注为不可用于生产；
5. 接收方可以在 `/api/health` 看到语音、工具和 Context 状态；
6. 任务 API 的查询先做只读测试，再开放创建、修改和通知；
7. 远程部署必须使用 HTTPS/WSS 和可信反向代理，不能直接把 3101 暴露到公网。

## 后续产品化工作

分享版完成后，剩余工作不再是重写语音模型，而是三件事：

1. 把当前固定 Demo 身份替换为独立登录或 DSH Host 身份；
2. 把静态 Context Mock 替换为每日生成的 Context API；
3. 把 `SPIRIT_DEMO_STAFF` 替换为人员/楼层查询接口。

这三项可以逐步替换，现有语音会话、工具注册和 WebSocket 链路不需要重做。
