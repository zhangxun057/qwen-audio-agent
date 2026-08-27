# 酒店事件原子 Mock

这是当前 `hotel-direct` 的 Mock 数据说明。正式环境由 MCP 原子服务提供相同的实体和事件接口。

## 1. 原子和事件

对象原子包括房间、住店、订单、住客、物品、任务和员工；事件原子记录一次已经发生或已经确认的事实。事件不是任务备注，任务也不是事件容器。

一条事件使用明确的 `entities` 映射，不使用“主对象 + 自由 relations”来掩盖对象：

```yaml
eventId: record:hotel-10082:20260811:0007
schemaVersion: hotel-event.v1
eventType: item_loaned
facts:
  itemId: item:hotel-10082:charger
  quantity: 2
  unit: 个
entities:
  - type: room
    id: room:hotel-10082:2615
    role: room
  - type: stay
    id: stay:hotel-10082:20260811-zhang
    role: stay
  - type: item
    id: item:hotel-10082:charger
    role: item
  - type: task
    id: task:hotel-10082:real-id
    role: source_task
actors:
  performedBy:
    id: employee:hotel-10082:li
source:
  trigger: task_transition
  taskId: task:hotel-10082:real-id
timing:
  occurredAt: 2026-08-11T19:30:00+08:00
  recordedAt: from-gateway
```

`recordedBy`、`relayedBy`、时间、酒店租户和幂等键由 Gateway 注入。`summary` 由 Gateway 根据 `eventType + facts + entities` 生成。

## 2. Mock 实体

```yaml
room:hotel-10082:2615:
  roomNumber: 2615
  currentStayId: stay:hotel-10082:20260811-zhang
room:hotel-10082:2015:
  roomNumber: 2015
stay:hotel-10082:20260811-zhang:
  guestId: guest:hotel-10082:zhang
  orderId: order:hotel-10082:20260811-zhang
item:hotel-10082:mineral-water:
  displayName: 矿泉水
  unit: 瓶
item:hotel-10082:charger:
  displayName: 充电器
  unit: 个
```

客人的黑色耳机不建立酒店物品原子或 `lostItemId`，直接在 `lost_found.facts.description` 记录。

## 3. 盘点 Mock

盘点任务本身只存在于任务系统：

```yaml
task:
  taskId: task:hotel-10082:count-001
  title: 盘点2615房矿泉水
```

任务完成后才写结果事件：

```yaml
eventType: inventory_verified
facts:
  itemId: item:hotel-10082:mineral-water
  countedQuantity: 3
  unit: 瓶
entities:
  - type: room
    id: room:hotel-10082:2615
    role: location
  - type: item
    id: item:hotel-10082:mineral-water
    role: item
  - type: task
    id: task:hotel-10082:count-001
    role: source_task
sourceTaskId: task:hotel-10082:count-001
```

如果盘点确认少了两瓶，另写 `item_consumed` 或 `inventory_adjusted`；不能把盘点动作本身写成 `inventory_counted`。

## 4. 旁路运行

PMS、库存系统和纸本交接可以继续运行。AI 事件账本只记录它收到且能确认的事实，并明确来源；没有外部确认时不伪造结账、房态或库存已同步。
