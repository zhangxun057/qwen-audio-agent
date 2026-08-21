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

当前明确不进入目标版本的能力：

- 不通过 OpenClaw、ACP 或其他后台 Agent 执行 Spirit 任务。
- 不在本应用中承担定时任务和长时间后台工作。
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
  "userId": "2079698_hotel_10082",
  "displayName": "张洵",
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

现有 Mock 设计见 `docs/spirit-context-service-mock.zh.md`。待完成真实 Mock 客户端、会话开始
加载、会话中刷新、失败回退和 Token 预算检查。

### M5. Spirit 源头适配层

**目标**：忠实移植用户提供的 Skill / 插件 API 逻辑，作为稳定业务资产。

硬约束：

- 允许从 Python / TypeScript 改写为 JavaScript，但不擅自改变 API 路径、字段语义、状态机、
  默认值、校验和结果判断。
- API 适配层与模型工具层分开。模型工具可以简化入口，但不能删除底层能力。
- 专用接口如 `start`、`complete`、`ai-update-status` 不用通用 `update` 猜测性替代。
- 当前可核对的源头是 DSH 插件 `task-api.ts` 和 `task-tools.ts`。用户提到的 Python Skill
  在当前附件中尚未定位；恢复该文件后，需要再做一次逐项差异审计。

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

待确认：通知是否默认随任务创建触发、是否允许独立通知、通知模板、重试和幂等规则、
接收人关闭通知时的产品表达。

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
| `spirit_task_update` | `POST /task/update` | 已简化接通 | 恢复完整更新语义；模型侧用于改描述和转派。 |
| `spirit_task_start` | `POST /task/start` | 已接并有契约测试 | 模型侧注册；执行者开始任务。 |
| `spirit_task_complete` | `POST /task/complete` | 已接并有契约测试 | 模型侧注册；支持完成备注。 |
| `spirit_task_update_status` | `POST /task/ai-update-status` | 已接并有契约测试 | 模型侧注册；保留专用状态流转。 |
| `spirit_task_add_comment` | `POST /task/execution-record` | 已接并有契约测试 | 模型侧注册；写现场情况和执行记录。正式登录前不伪造操作者身份。 |
| `spirit_task_workload` | `POST /task/today-workload` | 底层已接 | 目标首版暂不注册，负载派活阶段再启用。 |
| `spirit_task_update_plan_time` | `POST /task/plan-time` | 底层已接 | 目标首版不注册。 |
| `spirit_task_update_daily_summary` | `POST /task/daily-summary` | 底层已接 | 履职总结交给其他后台 Agent，首版不注册。 |
| `spirit_task_delete` | `POST /task/{taskId}` | 已接通 | 忠实移植；模型侧保留，并增加当前轮明确确认保护。 |

源头 `create` 中的 `users`、`subTasks`、`originalRequest`、`recommendedActions` 等字段不能从
API 适配层删除。模型侧是否直接填写这些字段，由后续工具封装决定。

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
spirit_task_update_plan_time
spirit_task_update_daily_summary
```

### 3.6 后续是否聚合工具的判断标准

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
8. 用户提到的 Python Skill 原文件尚未定位，无法完成逐行逻辑一致性审计。

## 5. 下一阶段执行顺序

1. 补齐创建、更新、列表参数的源头校验和边界契约测试。
2. 将固定人员、身份和派发规则迁出工具代码，接上下文 Mock API。
3. 规范 `notify_staff`，完成任务结果与通知结果的独立审计和幂等。
4. 增加 Usage、延迟、工具成功率和重连日志。
5. 固定客户端 WebSocket 协议，抽取客户端 SDK。
6. 完成 Windows 安装包、配置向导、健康检查和干净环境验收。

## 6. 决策记录

### 2026-08-21

- Gateway 作为当前主线，不重写全双工协议核心。
- 当前目标版本不依赖后台 Agent，不承担定时任务。
- Spirit API 采用 Gateway 直连，但必须忠实保留用户源头逻辑。
- 当前 7 个 Spirit 实验工具不代表最终业务边界。
- 不强制将 Spirit 工具压缩为四个；先完成源头适配和真实语音测试。
- `spirit_voice_notify` 是员工 App 工作通知能力，不是当前用户回复 TTS。
- 成本需要观测，但不以破坏自然全双工体验的方式优先优化。
- 已冻结成功保底版本：分支 `backup/voice-demo-success-20260821`，标签
  `voice-demo-success-20260821`，提交 `283c521`。
- 新版在 `feature/hotel-voice-v2` 开发，启用 `hotel-direct` 工具档案。
