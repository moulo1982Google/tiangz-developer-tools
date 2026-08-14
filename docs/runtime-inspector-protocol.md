# Runtime Inspector 协议草案

## 目的

Runtime Inspector 用来回答开发阶段的只读问题：

- 某个 `UnitId` 当前属于哪个 Process、Scene 和 `ActorLocation`；
- Scene、Actor mailbox 当前是否积压；
- 某个 Actor 是否有在途 RPC 或受限数量的定时器；
- Native handle 对应的实体类型、`Id`、`InstanceId` 和允许展示的诊断字段。

它不是 GM 接口、业务 RPC，也不是把 V8 `evaluate` 暴露给浏览器。Inspector 不能创建、销毁、改写 Entity，不能执行任意 JavaScript，不能读取密码、Token 或完整玩家持久化记录。

## 当前状态

当前主工程已经实现：

```text
GET /metrics
```

Developer Tools 可以通过“查看运行时指标”读取并展示 Process、Scene mailbox、pending RPC、Timer 和 Native Entity 汇总。它不执行实体查询。

下面是正式 Inspector 的冻结草案，等 Runtime 实现后才能把 Phase 5 的 UnitId 查询标为完成。

## 协议入口

正式接口使用已有 Process 观测端口，但只有显式启用 Inspector 配置时才注册：

```text
GET /inspect/v1/snapshot
```

请求必须带：

```http
X-TiangZ-Inspector-Version: 1
Authorization: Bearer <debug-token>
```

默认只绑定 `127.0.0.1`。远程访问必须显式启用、使用环境变量提供 Token，不能把 Token 写进 JSON、命令行或仓库。没有启用、版本不匹配或认证失败时，Runtime 返回 `404` 或 `401`，不泄漏是否存在目标实体。

## 查询范围

请求只允许使用固定字段，不接受脚本、表达式或任意路径：

```text
/inspect/v1/snapshot?scope=process
/inspect/v1/snapshot?scope=scene&scene=map_1
/inspect/v1/snapshot?scope=actor&unitId=1001
```

`scope` 只允许 `process`、`scene`、`actor`。`actor` 查询必须带十进制 `unitId`，并且可以返回：

```json
{
  "protocol": "tiangz.runtime-inspector",
  "version": 1,
  "process": "all",
  "scene": "map_1",
  "sceneType": "Map",
  "unitId": "1001",
  "instanceId": "1001",
  "actor": {
    "enabled": true,
    "mailboxDepth": 0,
    "pendingRpc": 0
  },
  "native": {
    "entityType": "Unit",
    "handle": "1001"
  }
}
```

这里的 `native.handle` 只用于诊断关联，不允许客户端拿它调用 Native FastOp。业务数据字段必须由 Component 明确登记为可观测字段，默认不返回任意实体内存。

## 性能和安全约束

Runtime 实现必须遵守这些硬限制：

| 约束 | 默认值 | 意图 |
| --- | ---: | --- |
| 单请求超时 | 200ms | 不能让 Inspector 阻塞业务 Tick |
| 每个来源地址速率 | 5 req/s | 防止误操作变成扫描器 |
| Process 在途查询 | 1 | 不把查询堆进 mailbox |
| 响应大小 | 64 KiB | 防止把玩家集合当调试响应返回 |
| 单次列表上限 | 100 | 不允许无界 Scene/Timer/Entity 扫描 |

查询应在 Rust Host 侧进行边界校验，再通过有界 control channel 投递到 TS Runtime。V8 只生成一份短生命周期快照；HTTP 线程不能直接访问 V8 或 Entity。查询超时后必须丢弃结果，不能继续持有旧闭包。

## 与现有能力的关系

```text
Prometheus /metrics
  -> 汇总趋势、CPU、RSS、队列、mailbox、Timer 数量

Runtime Inspector
  -> 单个 Process、Scene、Actor、Unit 的受限只读快照

V8 Inspector
  -> 开发者调试 TS 断点和调用栈
```

三者不互相替代：Prometheus 不查询实体，Runtime Inspector 不执行脚本，V8 Inspector 不承担线上管理接口。

## 验收顺序

1. Runtime 在未启用 Inspector 时，健康端口行为和性能不变。
2. `process` 与 `scene` 查询只返回固定字段，并能在 200ms 内完成或明确超时。
3. `actor` 查询能区分普通 `Unit`、`ActorUnit`、不存在和已销毁对象。
4. Token、版本、速率、响应大小和并发限制均有失败测试。
5. Developer Tools 只调用版本化协议，不回退到任意 V8 evaluate。
