# 原子模型空间 MCP 快路径对接稿

本文定义酒店语音 Gateway 当前需要的原子模型空间能力。本地 `MockAtomicSpaceProvider` 与未来 MCP 使用同一组语义，替换 Provider 时不改变快模型工具。

## 1. 设计边界

- 快模型完成业务判断：派任务、写记录、查询、更正、通知或直接回答。
- Gateway 不用关键词重新判断业务含义，只做对象解析、系统信息补齐、校验、幂等和调用。
- 事件使用一个统一元模型，不为借出、归还、投诉、失物分别建立元模型。
- 新记录只分“物品、客人、酒店、其他”四类。
- `category + content` 是未知事项的通用最小写入；索引中已声明 `actionRules` 的动作必须满足相应最低要件。
- 语音快模型工具可以在 MCP 之外采用更严格的入口契约，当前要求 `category + factState + action + content`；`factState` 只用于任务/事实路由，不要求成为事件持久化字段。
- 无法映射房间外地点、特殊物品或动态实例时，先保存事实并保留待解析引用。

## 2. get_index

按租户读取并缓存：

1. 原子模型目录；
2. 静态实例及别名，如物品、员工；
3. 房间等实例的 ID 拼装规则；
4. 动态实例的查询入口；
5. 事件最小输入、四个类别、建议动作和建议事实字段。

事件规范直接包含在索引中，当前快路径不强制调用 `get_meta_model`。

```json
{
  "writeContracts": {
    "event": {
      "schemaVersion": "event.v2",
      "minimumInput": ["category", "content"],
      "categories": {
        "物品": {
          "suggestedActions": ["送出", "消耗", "借出", "归还", "售出", "库存核实", "库存调整", "拾获", "交存"]
        },
        "客人": {
          "suggestedActions": ["投诉", "要求", "报失", "偏好", "住店变化", "服务结果"]
        },
        "酒店": {
          "suggestedActions": ["异常报告", "故障核实", "运行变化", "交接", "恢复"]
        },
        "其他": {
          "allowEmptyFacts": true,
          "allowEmptyEntities": true
        }
      }
    }
  }
}
```

建议字段不是普遍必填字段。MCP 不应因为普通建议字段缺少而拒绝事实，但必须执行索引中的动作级最低要件。例如借出需要物品、数量，以及房间、住店记录、客人或员工之一；缺少时返回自然语言短问题，不写入半条记录。

## 3. search_instances

查询动态实例，主要用于：

- 房号查询当前或指定时间的住店记录；
- 住店记录查询订单、客人；
- 自然名称查询物品、员工等实例。

返回零条或多条时，Gateway 可以保留待解析引用。只有业务动作本身必须区分候选时，才向用户追问。

## 4. write_instance

### 请求

```json
{
  "modelType": "event",
  "input": {
    "category": "物品",
    "action": "借出",
    "content": "1015房本次住店已借出充电宝1个",
    "facts": {
      "itemName": "充电宝",
      "quantity": 1,
      "unit": "个"
    },
    "entities": [
      { "type": "room", "id": "1015房", "role": "room" },
      { "type": "stay", "id": "本次住店", "role": "stay" }
    ]
  },
  "context": {
    "tenantId": "hotel-10082",
    "actorId": "2079697_hotel_10082",
    "actorName": "张洵",
    "source": "voice"
  }
}
```

### MCP/Gateway 补齐

- 生成事件 ID；
- 把 `1015房` 解析为房间实例；
- 查询当前住店记录；
- 把 `充电宝` 解析为物品实例；
- 注入租户、录入人、发生/记录时间、来源、用户原话和幂等键。

### 返回

返回保存后的完整记录和展示摘要。内部解析结果可以返回给 Gateway，但不得直接朗读给员工。

## 5. query_instances

支持按类别、对象、关键词和时间查询：

```json
{
  "modelType": "event",
  "filters": {
    "category": "物品",
    "objectType": "room",
    "objectId": "1015",
    "keyword": "充电宝",
    "limit": 10
  }
}
```

## 6. correct_instance

支持：

- `update`：修改类别、动作、完整内容、结构化事实或关联对象；
- `rewrite`：用新的完整记录替换；
- `delete`：软删除并保留审计历史。

更正沿用原记录 ID，不通过新增一条记录冒充修改。

## 7. 三个调用例

### 已送两瓶水

快模型：

```json
{
  "category": "物品",
  "action": "送出",
  "content": "2015房本次住店已送入矿泉水2瓶",
  "facts": { "itemName": "矿泉水", "quantity": 2, "unit": "瓶" },
  "entities": [{ "type": "room", "id": "2015房" }]
}
```

Gateway 解析房间、矿泉水和当前住店记录后调用 `write_instance`。不再出现服务代码或细分事件类型冲突。

### 电梯门口捡到皮鞋

快模型：

```json
{
  "category": "物品",
  "action": "拾获",
  "content": "张洵在18楼电梯门口拾获一双皮鞋",
  "facts": { "objectName": "一双皮鞋", "location": "18楼电梯门口" }
}
```

Gateway 生成开放地点引用；不要求房号，不创建失物 ID。

### 无法稳定分类的临时事实

快模型：

```json
{
  "category": "其他",
  "content": "今日夜班交接时需留意一楼入口处的临时指示牌"
}
```

MCP 必须接受该最小输入。后续复杂模型可以补充结构，但不是写入成功的前置条件。
