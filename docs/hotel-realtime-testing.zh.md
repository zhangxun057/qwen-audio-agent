# 酒店语音测试环境

## 已确认的两条链路

同事提供的 `realtime-voice-access-token-test.html` 是一个独立的实时语音测试页。它可以连接：

```text
wss://h5router.ymtcloud.com/hotelAi/dify/hotel/v2/ws/chat
```

页面把外部渠道令牌放在 `connection.open` 中提交，再用 `voice.audiochat.start` 启动语音会话。页面本身没有提示词输入项，也没有把本地 Markdown 提示词传给服务端的逻辑。因此，单纯把页面换到另一个端口，不能让生产语音链路使用本地提示词。

生产站首页 `https://h5router.ymtcloud.com/` 返回的是 Spirit-Agent 管理台，和语音 WebSocket 地址不是同一个页面入口。

## 本地隔离测试环境

仓库新增了一个独立启动入口：

```text
node scripts/start-hotel-test.mjs
```

默认地址为：

```text
http://127.0.0.1:3111/
```

它使用：

- 当前仓库的酒店语音前台和 Gateway；
- `hotel-10082-daily` 本地提示词；
- 独立的运行目录 `runtime/hotel-test-3111`；
- 独立的任务、记忆、原子记录和日志文件。

因此它不会与 3101 共用本地状态，也不会抢占 3101 的端口。需要换端口时可以这样启动：

```text
$env:HOTEL_TEST_PORT='3112'; node scripts/start-hotel-test.mjs
```

## 生产站测试的边界

要测试生产站自己的工具和账号链路，继续使用同事页面，把 WebSocket 地址改成上面的 `wss://` 地址，并在页面中填写包含 `uid`、`roleCode`、`platformId`、`channelType` 的外部渠道令牌。

要测试“本地提示词 + 本地 Gateway + 本地工具”，使用 3111。两者目前不能在同一条连接里合并：同事页面没有提示词注入协议，本地 Gateway 也不会把本地提示词转发到生产 WebSocket。

## 日志

3111 的日志写在独立运行目录下的 `logs/gateway.log`。实时语音每一轮会记录开始说话、停止说话、转写完成或失败、等待回复、回复开始/结束、工具调用和连接中断等节点，不记录完整语音内容。
