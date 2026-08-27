# 全双工酒店任务上下文服务 Mock

## 当前实现状态（2026-08-21）

新版 `hotel-direct` 已把接口形态接进真实语音链路：

```text
可信登录身份 / 本地 Demo 映射
  -> HotelContextService
  -> Static Provider（当前）或 HTTP Provider（生产）
  -> enterprise_context
  -> Realtime Session 初始 instructions
```

当前静态数据位于：

```text
config/hotel-direct/context-mock/hotel-10082-daily.json
```

本地 Mock 接口可直接验证：

```http
GET http://127.0.0.1:3101/v1/voice-contexts/hotel-10082-daily?userId=2079697_hotel_10082
```

若配置了 `QWEN_AUDIO_CONTEXT_SERVICE_TOKEN`，请求必须携带同值 Bearer Token；未配置时
仅适用于本机回环地址 Demo。`/api/health` 会展示 mode、version、用户 ID、prompt 字符数、
是否降级和最近错误，但不会返回 Token。

切换生产 Context Service 时只改配置，不改语音工具或 Realtime 代码：

```dotenv
QWEN_AUDIO_CONTEXT_MODE=http
QWEN_AUDIO_CONTEXT_ID=hotel-10082-daily
QWEN_AUDIO_CONTEXT_USER_ID=2079697_hotel_10082
QWEN_AUDIO_CONTEXT_SERVICE_URL=https://context.example.com
QWEN_AUDIO_CONTEXT_SERVICE_TOKEN=replace-with-service-token
QWEN_AUDIO_CONTEXT_FALLBACK_TO_MOCK=true
```

当前 JSON 中的 `prompt` 是从已经验证成功的 `hotel-direct` Demo 迁移而来的占位版本，
用于验证产品链路；它不是最终每日提示词模板。正式模板由独立上下文服务生成后可直接
替换响应正文。

## 1. 目标

全双工模型负责实时听说、理解意图和选择工具；业务系统负责登录身份、任务事实和
权限；上下文服务负责把排班、楼层、人员、服务标准等慢变化信息整理成适合语音模型
直接使用的提示词。

同一个用户在不同任务中可能是创建人、执行人或协作人，不为用户设置固定的
“派发者角色”或“执行者角色”。当前用户只由登录系统确定；用户在具体任务中的关系，
以任务 API 返回的 `CREATOR`、`EXECUTOR`、`COLLABORATOR` 为准。

## 2. 两种部署方式

### 2.1 独立应用

```text
浏览器登录页
  -> 语音应用后端 / Gateway
  -> 上下文服务
  -> 千问全双工模型
  -> Spirit 任务 API
```

登录成功后，语音应用后端从服务端登录态取得 `userId`、`hotelId` 等身份信息。浏览器
不需要让用户填写 ID，也不把业务令牌直接交给全双工模型。

### 2.2 DSH 插件

```text
DSH Host 登录态
  -> 全双工语音插件
  -> 共享的语音 Gateway 或插件内轻量适配器
  -> 上下文服务
  -> 千问全双工模型
  -> Spirit 任务 API
```

DSH 中已有认证插件时，语音插件从 Host 提供的身份接口取得 `userId`。上下文 API、
全双工模型和任务工具契约与独立应用保持一致，避免维护两套业务逻辑。

## 3. Gateway 的职责

Gateway 是语音网页与千问 Realtime WebSocket 之间的服务端运行层。它负责：

1. 建立和保持全双工模型连接。
2. 从可信登录态取得当前用户 ID。
3. 注册模型可调用的工具定义。
4. 接收模型的 function call，在本地执行 API 客户端或确定性脚本。
5. 把工具结果送回当前全双工会话。
6. 读取上下文服务，并通过 `session.update.instructions` 更新会话提示词。
7. 保管业务凭证、过滤模型参数、校验写操作结果。

网页只负责麦克风、音频播放、文本输入和结果展示，不直接持有业务 API 密钥。

## 4. 上下文查询接口

### 4.1 请求

```http
GET /v1/voice-contexts/hotel-10082-daily?userId=2079697_hotel_10082
Accept: application/json
Authorization: Bearer <gateway-service-token>
```

其中：

- `hotel-10082-daily` 是上下文 ID，由部署配置或酒店登录态确定。
- `userId` 由登录系统提供，不由用户口述，也不由模型生成。
- 上下文服务自行负责拼提示词，本语音项目不关心其内部是否由 Agent、RAG 或定时任务生成。

### 4.2 Mock 响应

```json
{
  "contextId": "hotel-10082-daily",
  "version": "2026-08-21-03",
  "generatedAt": "2026-08-21T06:00:00+08:00",
  "expiresAt": "2026-08-22T06:00:00+08:00",
  "subject": {
    "userId": "2079697_hotel_10082",
    "displayName": "张洵",
    "hotelId": "10082"
  },
  "sections": {
    "identity": "当前登录用户是张洵。查询‘我的任务’时使用当前登录用户 ID，不让用户提供 ID。不要把用户固定解释为派发者或执行者。",
    "operatingRules": "用户明确点名时优先按姓名派发；未点名时按房号和楼层路由。没有把握时只追问一个最必要的问题。",
    "staffRouting": "16楼刘嘉豪；17楼章栩媚；18楼汪桥；19楼吴镓松；20楼刘璇；21楼郭颖2；22楼刘至璇；23楼曲俊宇；24楼郭颖；25、26、28楼刘至璇；其他楼层当前由黄维维兜底。",
    "serviceKnowledge": "客房送物任务标题使用‘房号+动作+数量+物品’。查房结果、现场异常和完成说明写入执行记录，不覆盖原任务标题。",
    "exceptions": "员工、楼层或任务无法唯一确定时不得猜测。创建成功和通知成功分别判断。只有任务 API 返回成功才可声称任务已修改。",
    "examples": "用户说‘1601送两瓶水’，派刘嘉豪，标题为‘1601房送2瓶水’。用户说‘2301查完了，浴室漏水’，向对应任务追加执行记录；只有用户表达已经完成时才同时完成任务。"
  },
  "prompt": "<daily_hotel_context version=\"2026-08-21-03\">\n...服务端拼好的完整提示词...\n</daily_hotel_context>",
  "estimatedTokens": 7200,
  "contentHash": "sha256:mock-context-hash"
}
```

`sections` 便于审计和调试；`prompt` 是实际注入模型的完整文本。生产环境可以只返回
`prompt`，但保留结构化分段更容易定位错误和做差异更新。

## 5. 建议的提示词分段

### A. 身份事实，目标 200-500 token

- 当前用户姓名、用户 ID、酒店 ID。
- “我的任务”默认使用当前登录身份。
- 不设固定业务角色，具体任务关系以任务数据为准。

### B. 当日派发索引，目标 1,500-3,000 token

- 人员 ID、姓名和常见语音别名。
- 楼层、区域、服务类型与负责人。
- 当班安排、兜底人员和升级路径。
- 只保留派活需要的字段，不放员工履历和无关组织介绍。

### C. 高频服务规则，目标 1,500-3,000 token

- 送物、查房、维修、清洁等常见任务的标题和必要字段。
- 哪些信息缺失时必须追问。
- 哪些现场情况应追加记录、改异常状态或派生新任务。

### D. 异常和结果规则，目标 500-1,000 token

- API 失败、部分成功、通知失败如何表达。
- 不能猜造 taskId、员工 ID 或任务状态。
- 删除等破坏性操作的确认边界。

### E. 少量示例，目标 1,000-2,000 token

- 使用短而有区分度的真实工作句式。
- 示例覆盖派发、查询、追加记录、完成和异常。
- 不大量堆同类示例，避免挤占对话空间。

建议日常上下文目标为 6K-8K token，硬上限 10K token。超限时由上下文服务先压缩
示例和低频知识，不由 Gateway 截断到半句话。大型 SOP、产品卡片和历史资料按问题临时
检索，通过单轮上下文提供，不常驻全双工会话。

## 6. 上下文加载与刷新

### 6.1 会话开始

```text
1. 用户完成登录。
2. 后端取得可信 userId 和 contextId。
3. Gateway 请求上下文 API。
4. 校验 version、expiresAt、estimatedTokens 和 prompt。
5. 使用 session.update.instructions 注入完整提示词。
6. 收到 session.updated 后，页面才进入可正式对话状态。
```

如果上下文服务超时，可使用最近一次未过期缓存；没有缓存时仍允许基础任务查询，但
必须禁止依赖当日人员路由的自动派发，避免用旧排班派错人。

### 6.2 会话中更新

Gateway 可按以下任一方式检查新版本：

- 上下文服务通过事件或 WebSocket 推送 `contextId + version`。
- Gateway 每 5-15 分钟发送带 `If-None-Match` 的轻量检查。
- 管理端发布新版本后主动通知各 Gateway。

发现新版本时，等待当前模型输出结束，再发送新的 `session.update.instructions`。应用层
始终只保留一个当前日常上下文，不把每天的版本连续追加到会话中。

### 6.3 单轮补充

当用户问到大型 SOP 或低频资料时，Gateway 或检索服务取得小段资料，通过该轮
`response.create.instructions` 提供。它只服务当前回答，不扩大后续每一轮的常驻提示。

## 7. Mock 开发阶段验收

1. 使用不同 `userId` 请求同一 `contextId`，返回不同的身份段，但共享酒店派发规则。
2. 更新 `version` 后，已有语音会话不重连即可使用新派发规则。
3. 上下文 API 超时不导致全双工连接崩溃。
4. `estimatedTokens` 超过硬上限时拒绝发布，并记录明确错误。
5. 模型回答“我的任务”时不向用户追问 ID。
6. 同一登录人在一项任务中可作为创建人，在另一项任务中可作为执行人。
7. 更新上下文不重复追加旧版本，连续切换后提示词体积保持稳定。

## 8. 与任务工具的边界

上下文告诉模型“如何判断和选择”，工具负责“真正执行”。上下文中的员工 ID、楼层和
规则不能作为任务成功的证据；创建、修改、完成和追加记录必须以任务 API 返回为准。

建议对全双工模型暴露少量业务意图工具，Gateway 内部再调用原子 API：

```text
query_tasks   -> list / detail / execution-record/list
dispatch_task -> create + 可选通知
report_task   -> execution-record + 可选 start / complete / update-status
delete_task   -> delete，保留明确确认
```

模型只需选择业务动作和填写少量参数；身份注入、员工 ID 映射、API 路径、鉴权、调用顺序
和结果校验由 Gateway 的确定性代码负责。
