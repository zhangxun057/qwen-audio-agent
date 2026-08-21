# 酒店全双工语音工作台产品化开发日志

> 状态：主线开发文档  
> 建立日期：2026-08-21  
> 当前版本基线：`qwen-audio-agent` 1.10.1 + 本地 Spirit 直连实验  
> 当前目标：形成可安装、可登录、可运行、可诊断的 PC 应用，并保留未来 App 通过 WebSocket 连接同一 Gateway 的能力。

## 1. 产品目标与当前边界

目标产品是一套面向酒店工作场景的全双工语音入口：

```text
PC / Web / App
  -> WebSocket / WSS
Voice Gateway
  -> Qwen Realtime 全双工模型
  -> 登录与上下文服务
  -> Spirit 任务 API
  -> 员工 App 通知链路
```

当前目标版本不依赖后台复杂 Agent。全双工模型负责自然听说、理解用户意图和选择工具；
Gateway 负责身份、上下文、工具执行、参数校验、结果回传和会话恢复；Spirit 是任务事实源。

模型只处理已登录用户完成的一轮输入。后台服务可以更新上下文和业务数据，但不把定时事件、
逾期状态或自动扫描结果伪装成用户输入来调用前台模型。

当前明确不进入目标版本的能力：

- 不通过 OpenClaw、ACP 或其他后台 Agent 执行 Spirit 任务。
- 不在本应用中承担定时任务和长时间后台工作。
- 不让前台模型执行到点催办、超时扫描或后台事件播报。
- 不承担复杂文件、代码、联网调查或多步 Agent 编排。
- 不用独立 TTS 替代全双工模型对当前用户的自然回复。
- 不把 DSH `27990` 作为正式运行依赖。

## 2. 产品化大模块

### M1. Gateway 运行核心

**目标**：保留开源 Gateway 的全双工会话核心，不重写协议栈。

职责：

- 维护客户端 WebSocket 和千问 Realtime WebSocket。
- 管理音频输入、音频输出、打断、播放确认和断线重连。
- 使用登录身份生成可信 `ownerId`，使用客户端 `sessionId` 区分会话。
- 注册当前产品档案允许的模型工具。
- 执行 Function Call，将真实结果返回当前 Realtime 会话。
- 保管模型 Key、Spirit 凭证和通知服务凭证。

当前状态：网页 Demo 已能连接、对话和调用 Spirit API。正式版仍需认证、配置隔离、日志、
健康检查和部署适配。

### M2. 身份与登录

**目标**：用户不口述 ID，模型也不生成 ID。身份始终来自登录系统。

独立应用：登录页取得用户身份，再由后端签发短期语音会话票据。  
DSH 插件：从 Host 已登录身份取得同等字段。  
两种入口最终统一为 Gateway 可验证的身份对象：

```json
{
  "userId": "demo-user-hotel-10082",
  "displayName": "演示用户",
  "hotelId": "10082",
  "contextId": "hotel-10082-daily"
}
```

待完成：登录接口、短期票据、过期刷新、退出登录、凭证安全存储和多用户隔离测试。

### M3. 会话与记忆

**当前三层结构**：

1. 千问 Realtime 当前连接维护本次完整语音对话上下文。
2. Gateway 内存按 `ownerId + sessionId` 保存近期转写，用于断线后恢复少量近期对话。
3. `USER.md` 和 `MEMORY.md` 保存跨会话的用户偏好与长期事实。

目标版本保留开源会话恢复和 `memory` 能力，但需要明确：

- Gateway 近期会话记录不是正式持久化会话档案。
- 企业身份、排班和服务规则不写入个人 `MEMORY.md`。
- 业务上下文由独立上下文服务提供，并按版本替换。
- 是否启用会话结束自动记忆提取器由产品配置决定。

### M4. 企业上下文服务

**目标**：使用可信用户 ID 查询当日团队和个人上下文，并通过 `session.update.instructions`
注入全双工会话。

上下文建议分层：

```text
基础规则：语音角色、表达方式、安全边界
团队上下文：酒店规则、服务类型、公共派发规则
个人上下文：登录身份、当日岗位和必要个性化信息
临时上下文：当前问题命中的 SOP、任务详情或知识资料
```

约束：

- 团队共用内容使用统一 `contextId + version`。
- 个人段只放当前用户差异，不复制整份团队内容。
- 大型知识资料按需注入，不常驻会话。
- 新版本替换旧版本，不连续追加。
- 工具内部需要的 ID、鉴权和原始 API 数据不必全部注入模型。
- 会话开始注入当日团队和个人上下文。每轮提示词只补当前时间；候选任务、工作量、SOP 等
  业务数据在识别出对应意图后再提供，不与低延迟时间快照混在一起。
- 用户是否结束输入、写工具是否可以执行，由 Gateway 根据语音事件做硬闸门，不作为提示词
  变量交给模型判断。

现有 Mock 设计见 `docs/spirit-context-service-mock.zh.md`。待完成真实 Mock 客户端、会话开始
加载、会话中刷新、失败回退和 Token 预算检查。

#### 每轮时间注入的时序

时间不依赖语音转写。Gateway 收到 `input_audio_buffer.speech_started` 时即可取得本地时区的
时间，因此不会出现知识库那种“先听懂关键词，再查询资料”的主要延迟。

但 `response.create.instructions` 不能在说话开始时单独预存；发送 `response.create` 本身就会
请求模型回答。当前千问会话使用 `smart_turn` 自动产生回答，正式实现分两步：

1. 近期方案：在用户开始说话时刷新会话中的短时间快照，或每分钟刷新一次。日期、星期和
   时区仍放在会话上下文；对“半小时后”“下班前”等需要准确计算的操作调用
   `get_current_time`。该方案无需等待转写，正常语音指令基本能在回答前取得新时间。
   需要注意，`session.update.instructions` 是整体替换，不是只追加一行时间；Gateway 实际上
   会重建原会话提示词，只改变末尾的时间快照。时序开销预计很小，但 Token、缓存命中和
   Smart Turn 是否总能看到最新版本必须用真实 Usage 与事件日志验证。
2. 确定性方案：模型端支持关闭自动回答后，由 Gateway 在 `speech_started` 时记录时间，在
   用户说完后发送带 `<turn_runtime>` 的 `response.create`。这样本轮提示词必定先于本轮回答，
   不需要取消和重答。

不采用“在 `speech_started` 时直接发送 `response.create`”的做法；那会请求模型立即回答，
可能打断用户。若继续使用 Smart Turn，又必须把动态资料作用于当前回答，则仍只能取消原回答
并重新创建，但时间信息本身没有必要走这条路径。

### M5. Spirit 源头适配层

**目标**：忠实移植用户提供的 Skill / 插件 API 逻辑，作为稳定业务资产。

硬约束：

- 允许从 Python / TypeScript 改写为 JavaScript，但不擅自改变 API 路径、字段语义、状态机、
  默认值、校验和结果判断。
- API 适配层与模型工具层分开。模型工具可以简化入口，但不能删除底层能力。
- 专用接口如 `start`、`complete`、`ai-update-status` 不用通用 `update` 猜测性替代。
- Python Skill 已恢复在
  `.codex_tmp/hotel-task-management-source-20260821/hotel-task-management/`，作为业务判断、
  字段语义、派发、异常和提醒规则的主要核对基线；DSH 插件 `task-api.ts` 和 `task-tools.ts`
  继续作为当前 API 路径和调用方式的核对来源。

当前 `spirit-task-direct.mjs` 是实验性简化实现，不作为最终源头适配层验收基线。

### M6. 模型工具层

**目标**：只向全双工模型注册当前场景必要的工具；工具来源、参数和业务边界可审计。

工具数量暂不强行压缩为四个。第一阶段先按源头业务语义接通并测试，后续再依据真实语音
正确率、延迟和业务歧义决定是否聚合。详细安排见第 3 节。

### M7. 语音工作通知

**目标**：向任务执行人员的 App 发送工作语音通知，不替代当前全双工模型回复。

现有实验链路：

```text
确定接收人
  -> 查询通知开关
  -> Seed TTS 生成语音
  -> 上传语音文件
  -> 友盟推送员工 App
```

该能力来自用户明确提出的语音对讲/通知需求及相关业务配置，不是 Spirit 任务 API 的原生
任务工具。正式版必须分别记录和播报：

- 任务操作是否成功。
- 员工通知是否成功。

当前首版只保留三类通知：任务创建成功后的即时执行通知、重新分配成功后对新执行人的即时
通知，以及用户明确要求发送的独立通讯。
不发送到点催办或后台扫描通知。仍待完成通知模板、重试、幂等和接收人关闭通知时的产品表达。

### M8. 客户端与安装包

**目标**：提供对方可自行安装运行的 Windows PC 包，并为未来 App 复用同一协议。

PC 包需要：

- 不要求用户单独安装 Node.js。
- 安装后启动本地 Gateway 或连接配置的远程 Gateway。
- 登录、退出、连接状态、麦克风和扬声器检测。
- 自动重连、端口冲突处理、日志导出和版本升级。
- 密钥不写入前端静态资源。

客户端与 Gateway 的 WebSocket 事件协议需要先稳定，再抽取可供 Web 和 App 共用的客户端
SDK，避免分别重写录音、播放、打断和重连逻辑。

### M9. 可观测性、成本与质量

**目标**：先把真实行为记录下来，再进行成本和性能优化。

需要记录：

- 每个 Realtime `response.done.usage` 的输入/输出文本和音频 Token。
- 每次工具调用的名称、参数摘要、耗时、真实成功状态和错误码。
- 会话创建、重连、上下文版本、工具注册档案。
- Spirit 操作成功与通知成功的独立结果。

成本优化不是当前最高优先级。未经真实 Usage 证实，不改变自然全双工回复链路，也不使用
独立 TTS 替代模型对当前用户的回复。

### M10. 测试、文档与发布

目标验收包括：

- 查询、创建、转派、修改、开始、追加执行记录、完成、状态变更和删除。
- API 失败、登录过期、通知失败、重复调用和破坏性操作确认。
- 打断、断网重连、Gateway 重启和上下文更新。
- 在没有开发环境的干净 Windows 电脑上完成安装测试。

最终文档至少包括 README、部署说明、工具来源清单、上下文接口、故障排查和发布流程。

## 3. 目标版本工具安排

### 3.1 工具来源规则

每个工具必须标记为以下来源之一：

```text
OPEN_SOURCE       qwen-audio-agent 上游工具
SPIRIT_SOURCE     用户 Skill / DSH Spirit 插件中的源头工具
PRODUCT_EXTENSION 为酒店语音产品新增的扩展能力
```

任何 `PRODUCT_EXTENSION` 都不能伪装成 Spirit 原生能力。

### 3.2 开源工具取舍

| 工具 | 来源 | 目标版本 | 安排 |
|---|---|---|---|
| `get_current_time` | `OPEN_SOURCE` | 保留 | 提供可信日期、时间、星期和时区。 |
| `memory` | `OPEN_SOURCE` | 保留 | 管理个人长期偏好和事实；不保存企业排班或业务凭证。 |
| `enter_sleep` | `OPEN_SOURCE` | 条件保留 | 仅客户端声明支持休眠时注册。 |
| `spawn_thinking` | `OPEN_SOURCE` | 不注册 | 当前版本不接后台复杂 Agent。 |
| `respond_agent_permission` | `OPEN_SOURCE` | 不注册 | 没有后台 Agent 权限请求。 |
| `get_agent_task_status` | `OPEN_SOURCE` | 不注册 | 查询的是后台 Agent Work，不是 Spirit 业务任务。 |
| `cancel_agent_task` | `OPEN_SOURCE` | 不注册 | 当前版本不承担后台工作或定时任务。 |
| `schedule_reminder` | `OPEN_SOURCE` | 不注册 | 定时任务由其他后台 Agent 承载。 |
| `notes` | `OPEN_SOURCE` | 不注册 | 容易与正式 Spirit 任务混淆。 |

实现策略是“按 `hotel-direct` 产品档案不注册”，不立即删除上游代码，以便未来其他版本复用。

### 3.3 Spirit 源头工具登记

| 源头工具 | 源头 API | 当前 Gateway | 目标安排 |
|---|---|---|---|
| `spirit_task_list` | `GET /task/list` | 已简化接通 | 忠实恢复筛选、默认值与校验；模型侧保留。 |
| `spirit_task_detail` | `GET /task/detail` | 已接通 | 忠实移植；模型侧保留。 |
| `spirit_task_detail_by_conversation` | `GET /task/detailByConversationId` | 未接 | 忠实保留底层；独立应用首版不注册。 |
| `spirit_task_comments` | `GET /task/execution-record/list` | 已接通 | 忠实移植；模型侧保留，用于读取执行记录。 |
| `spirit_task_create` | `POST /task` | 已接但 Demo 化 | 重建忠实 API 适配；模型侧保留派活入口。 |
| `spirit_task_update` | `POST /task/update` + `/task/plan-time` | 已接通 | 一个用户意图工具覆盖状态、描述、转派和要求时间；Gateway 按字段选择底层接口。 |
| `spirit_task_start` | `POST /task/start` | 已接并有契约测试 | 模型侧注册；执行者开始任务。 |
| `spirit_task_complete` | `POST /task/complete` | 已接并有契约测试 | 模型侧注册；支持完成备注。 |
| `spirit_task_update_status` | `POST /task/ai-update-status` | 已接并有契约测试 | 模型侧注册；保留专用状态流转。 |
| `spirit_task_add_comment` | `POST /task/execution-record` | 已接并有契约测试 | 模型侧注册；写现场情况和执行记录。正式登录前不伪造操作者身份。 |
| `spirit_task_workload` | `POST /task/today-workload` | 底层已接 | 目标首版暂不注册，负载派活阶段再启用。 |
| `spirit_task_update_daily_summary` | `POST /task/daily-summary` | 底层已接 | 履职总结交给其他后台 Agent，首版不注册。 |
| `spirit_task_delete` | `POST /task/{taskId}` | 已接通 | 忠实移植；模型侧保留，并增加当前轮明确确认保护。 |

源头 `create` 中的 `users`、`subTasks`、`originalRequest`、`recommendedActions` 等字段不能从
API 适配层删除。模型侧是否直接填写这些字段，由后续工具封装决定。

### 3.3.1 Gateway 返回边界

直连客户端对原始 JSON 做通用安全限幅：字符串最多 12,000 字符，数组最多 100 项，嵌套超过
第 5 层的非核心内容标记为 `[truncated]`。这是传输保护，不代表上游任务 API 截断。语音工具
随后只向模型投影任务核心字段：任务标题、描述、开场要求、状态及中文状态、计划时间、完成备注、
创建时间、执行人、创建人和有限子任务；渠道、来源、文件包装、推荐按钮等接口字段不进入普通播报。

### 3.4 产品扩展工具

| 工具 | 来源 | 当前状态 | 目标安排 |
|---|---|---|---|
| `spirit_voice_notify` | `PRODUCT_EXTENSION` | 已完成实验链路 | 保留能力，但重新命名和定义边界时不得假装是 Spirit 原生任务工具。 |

建议后续模型侧名称评审为 `notify_staff`，内部仍可复用现有通知服务。正式定义至少支持：

- 指定员工或通过可信派发结果确定接收人。
- 自定义通知正文。
- 独立返回 `sent`、`skipped`、`failed`。
- 与任务创建结果分开记录。
- 防止重复推送。

### 3.5 目标版本模型可见工具

第一阶段建议注册以下工具，不做四工具强制聚合：

```text
get_current_time
memory

spirit_task_list
spirit_task_detail
spirit_task_comments
spirit_task_create
spirit_task_update
spirit_task_start
spirit_task_complete
spirit_task_update_status
spirit_task_add_comment
spirit_task_delete
notify_staff

enter_sleep  # 仅支持休眠的客户端
```

第一阶段不注册：

```text
spawn_thinking
respond_agent_permission
get_agent_task_status
cancel_agent_task
schedule_reminder
notes

spirit_task_detail_by_conversation
spirit_task_workload
spirit_task_update_daily_summary
```

### 3.6 人类意图与工具契约审计

| 用户表达 | 应调用工具 | 当前判断 |
|---|---|---|
| “我的任务”“今天有哪些任务” | `spirit_task_list` | 可闭合；`userId` 必须来自登录身份。 |
| “1601房那个任务具体是什么” | `spirit_task_list` → `spirit_task_detail` | 可闭合；先定位真实 `taskId`，重名时确认。 |
| “这个任务有什么执行记录” | `spirit_task_comments` | 可闭合；前提是已有真实 `taskId`。 |
| “给1601房送2瓶水” | `spirit_task_create` | 可闭合；开始时间和要求完成时间按语义写入计划字段，立即任务按标准动作时长推算完成期限。 |
| “改派给刘嘉豪”“把说明改成……”或“要求18点前完成” | `spirit_task_update` | 可闭合；一个工具承载描述、执行人和要求时间，Gateway 决定调用任务更新还是计划时间接口。 |
| “我开始做了”“我接手了” | `spirit_task_start` | 可闭合。 |
| “查房发现浴室漏水”“现在做到一半” | `spirit_task_add_comment` | 可闭合；不能误判为完成。 |
| “已经做完，浴室漏水已处理” | `spirit_task_complete` | 可闭合；现场结果写入 `completionRemark`，不必重复追加记录。 |
| “做不了了”“我放弃了” | `spirit_task_add_comment`；必要时另调 `spirit_task_create` | 原 Skill 要求保留旧任务状态并另建补救任务；不得映射为完成、删除或 `EXCEPTION`。后续处理不明确时先问。 |
| “删除1601房送水任务” | `spirit_task_delete` | 可闭合；本轮必须明确删除且任务唯一。 |
| “通知刘嘉豪先去1601房” | `notify_staff` | 目标名称；当前实现仍为 `spirit_voice_notify`。只通讯，不创建任务。 |

当前契约缺口：

1. `config/hotel-direct/context-mock/hotel-10082-daily.prompt.md` 已接入 Context Mock 运行时；
   `docs/daily-hotel-voice-context-demo.zh.md` 是可读的完整设计稿，修改它不会自动改变 Demo，
   需要同步到 Context Mock 文件并更新版本。
2. `spirit_task_create` 已由 Gateway 依据可信登录身份、人员映射和明确的计划时间创建；已知标准动作
   的时间由 Gateway 确定性补齐，未知动作不猜。协作人和动态工作量分配仍未开放。
3. `spirit_task_update` 与 `spirit_task_update_status` 都暴露状态修改，容易造成工具选择歧义。
   模型 Schema 中的通用 `update.status` 应删除，状态流转交给专用工具。
4. `spirit_task_workload` 未向模型注册。工作量不放进每轮时间提示词；可由 Gateway 在确认是
   派活意图后查询并确定性选人，或恢复专用工具。数据缺失时不猜。
5. `spirit_voice_notify` 的内部名称暂保留以兼容现有实现，模型描述已明确它是独立通讯工具，
   默认标题为“工作通知”；任务创建通知仍由创建结果单独返回。
6. `get_current_time` 的工具描述仍提到 `schedule_reminder`。虽然 `hotel-direct` 不注册提醒工具，
   仍应为该档案提供不含定时任务措辞的描述，避免无关提示影响工具选择。
7. 原 Skill 对异常的规则是“不改旧任务状态，必要时创建补救任务”，当前工具尚不能完整表达
   旧任务关联、5 分钟完成期限、监督人和后续动作。首版可记录异常并确认后续处理，不得把
   “做不了/放弃”解释为删除、完成或 `EXCEPTION`。
8. `spirit_task_list` 已改为暴露 `scope=MY|ALL`；“我的任务”由 Gateway 写入可信登录用户 ID，
   模型不再填写原始 `userId`。
9. “先查列表取得 taskId，再查详情、开始、修改或完成”依赖同一轮连续工具调用。当前已有
   单工具处理测试，但缺少全双工模型实际选择工具的端到端回归样本。
10. 创建工具把 `assigneeName` 定义为“用户明确点名”，但提示词还会根据时间、岗位、区域和
    工作量自主选人。Schema 必须允许传入模型按当日索引选出的姓名，并由 Gateway 再校验；
    否则模型不传姓名时，静态楼层映射会覆盖工作量判断。
11. 当前创建工具只有一个 `assigneeName`，不能表达原 Skill 的多执行人和监督人。正式创建
    Schema 需要 `executors[]`、`collaborators[]`，或由 Gateway 根据已选执行人确定性补齐。
12. 当日索引没有前台接待、前厅大副和工程人员。人员数据补齐前，涉及这些岗位的任务不得
    退化成按房号派给 RA。
13. `spirit_task_update.description` 是整段替换，不是增量修改。模型工具应改成 patch 语义，
    或强制先读详情、由 Gateway 合并后再提交，避免覆盖原描述。
14. `notify_staff` 的接收人必须来自可信人员索引；只给岗位名但没有对应人员时不得按房号
    猜成楼层员工。

### 3.7 后续是否聚合工具的判断标准

完成忠实源头适配后，再使用真实语音样本比较原子工具与聚合工具。只有同时满足以下条件
才进行聚合：

- 用户意图边界相同，不会掩盖不同业务状态机。
- 部分成功可以准确表达，例如任务成功但通知失败。
- 参数 Schema 没有因为合并变得更复杂。
- 工具选择和参数抽取正确率实际提升。
- 不需要模型承担 Gateway 应负责的多步业务编排。

因此 `query_tasks / dispatch_task / report_task / delete_task` 仍是候选设计，不是已定架构。

## 4. 当前技术债

1. Spirit 当前直连实现已覆盖目标源头 API 路径，但创建参数的全量源头校验尚未完成。
2. 创建人、人员、楼层、渠道和测试账号仍存在 Demo 写死逻辑。
3. `spirit_task_create` 当前混合了创建任务和通知员工两个结果。
4. 当前工具定义把产品扩展通知命名在 `spirit_*` 命名空间中，来源不够清晰。
5. 企业上下文仍通过本地补充文本注入，尚未接真实上下文服务。
6. 工具已按 `hotel-direct` 产品档案动态注册；企业上下文服务仍未接入。
7. 尚未完整落库 Realtime Usage，成本判断缺乏真实会话证据。
8. Python Skill 已定位，但当前 JavaScript Gateway 仍未完成逐字段、逐状态和逐错误结果的
   一致性测试。
9. 正式每日上下文和每轮瞬时上下文仍是设计文档，尚未替换运行时短版固定提示词。
10. 缺少“自然语言 → 工具选择 → 参数 → 真实结果”的端到端语音回归测试。
11. 当前尚未实现说话开始时的会话时钟刷新，也未验证当前千问 `smart_turn` 是否支持关闭
    自动回答并由 Gateway 接管每轮 `response.create`。
12. 写操作尚未形成统一的 Gateway 终态闸门。正式版应在输入仍处于 `speech_started` 状态时
    拒绝执行创建、修改、提交、完成、删除和通知，不依赖模型生成 `input_state=final`。

## 5. 下一阶段执行顺序

1. 补齐创建、更新、列表参数的源头校验，消除通用状态更新等工具选择歧义。
2. 把正式每日上下文接入会话指令，并实现说话开始时的短时间快照；验证 Smart Turn 下的
   生效顺序和班次边界。
3. 将固定人员、身份和派发规则迁出工具代码，接上下文 Mock API。
4. 用第 3.6 节样本完成“自然语言 → 工具 → 参数 → 结果”的端到端语音回归。
5. 规范 `notify_staff`，完成任务结果与通知结果的独立审计和幂等。
6. 增加 Usage、延迟、工具成功率和重连日志。
7. 固定客户端 WebSocket 协议，抽取客户端 SDK。
8. 完成 Windows 安装包、配置向导、健康检查和干净环境验收。

## 6. 决策记录

### 2026-08-21

- Gateway 作为当前主线，不重写全双工协议核心。
- 当前目标版本不依赖后台 Agent，不承担定时任务。
- 前台模型只由人完成的一轮输入触发；后台调度和到期催办不进入其提示词或输入事件。
- Spirit API 采用 Gateway 直连，但必须忠实保留用户源头逻辑。
- 当前语音产品有三项经用户确认的源头规则调整：不承接定时提醒；派发顺序采用
  “时间 → 岗位 → 区域 → 工作量”；歧义、异常和破坏性操作允许只确认一个必要问题。
- 当前模型可见的 10 个 Spirit 任务工具和 1 个通知扩展不代表最终业务边界。
- 不强制将 Spirit 工具压缩为四个；先完成源头适配和真实语音测试。
- `spirit_voice_notify` 是员工 App 工作通知能力，不是当前用户回复 TTS。
- 成本需要观测，但不以破坏自然全双工体验的方式优先优化。
- 已冻结成功保底版本：分支 `backup/voice-demo-success-20260821`，标签
  `voice-demo-success-20260821`，提交 `283c521`。
- 新版在 `feature/hotel-voice-v2` 开发，启用 `hotel-direct` 工具档案。
