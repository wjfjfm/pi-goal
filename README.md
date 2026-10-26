# pi-goal

人和 Agent 共用的 TODO 清单，支持独立的持续执行控制。

## 清单工具（仅 codemode）

```js
await tools.goal_add({text: "补充测试"});
await tools.goal_add({text: "补充集成测试", parentId: "父项 ID"});
await tools.goal_show({});
await tools.goal_show({id: "目标 ID"});
await tools.goal_update({id: "目标 ID", status: "doing"});
await tools.goal_update({id: "目标 ID", text: "补充集成测试"});
await tools.goal_delete({id: "目标 ID"});
```

状态：`todo / doing / blocked / done / cancelled`。每项记录不可变的
`setBy: "user" | "assistant"`、最近修改者 `updatedBy` 和时间。
删除为软删除，默认清单隐藏，但仍可按 ID 查看，会话历史保留历次快照。
旧记录无法确定的来源显示 unknown，不伪造作者。

新增、编辑、删除都**不启动执行**；实际变更会补满模块共享的重复提醒预算。设为 doing 也不代表授权。
Agent 不得扩大用户任务范围、绕过确认或重建已取消任务；删除用户创建或修改过的项应先征求同意。

## 多级列表

`goal_add` 的可选 `parentId` 指向父项；省略则创建顶层项，可继续嵌套多级。
`/goal` 按层级缩进展示；`goal_show({})` 返回深度优先排列的条目及 parentId，
按 ID 查询仍只返回指定项。没有 parentId 的旧记录视为顶层项。

父项必须存在、未删除且不是 done/cancelled。父子状态独立，不自动汇总或级联；
删除父项前须先删除其子项（即使子项已完成）。暂不支持移动父子关系。
子项单独记录 setBy，也不会因为父项正在执行而自动获得授权。

## 用户命令

| 命令 | 操作 |
| --- | --- |
| `/goal` 或 `/goal show` | 查看清单、来源和执行状态 |
| `/goal add <文本>` | 仅新增顶层项，来源为 user |
| `/goal add --parent <id> <文本>` | 新增子项，来源为 user |
| `/goal update <id> <状态>` | 修改状态 |
| `/goal update <id> text <文本>` | 修改内容 |
| `/goal delete <id>` | 软删除 |
| `/goal pause` | 暂停自动继续，不中断工具 |
| `/goal resume` | 纳入当前 todo/doing 项并恢复执行 |
| `/goal <文本>` | 新增并开始执行；运行中使用则纳入新项，并因新增 goal 补满重复提醒预算 |
| `/goal clear` | 兼容命令：暂停并取消未完成项，不删除历史 |

运行不设总轮数上限。运行中 add 的项不自动纳入执行范围，
重写文本也会撤销该项的执行范围；需要用户暂停后 resume。
运行中重复 resume 无副作用。blocked 项须先改回 todo/doing。
授权范围内无可执行项时，存在 blocked 则暂停，否则结束本轮。

用户修改通过 steer 在工具批次后送达，送达前拒绝 Agent 写回。
Agent 不能修改已取消或删除的项。暂停不阻止维护清单，也不会撤回已排队消息或中断工具。

backtrack/compact 完成后补一条简短状态消息，例如：

```text
[goal status: 5 todo, 1 doing, 3 blocked, 2 done, 0 cancelled; run: paused; use codemode tools.goal_show({}) for details]
```

摘要使用清单实际状态，执行状态单列；不恢复执行、不重置空转检测。

### 简单空转保护

整个 goal 模块共享 **10 次重复提醒预算**，不按任务或层级分别计数：

1. 任意 goal 实际新增、修改或删除，预算补满；重复提交相同内容/状态不算变更。
2. 只检查 **goal 准备重复注入提醒的结束边界**。无 goal 变更且距上次这样的边界小于 **1 分钟**，扣一次；首次或变更后首次只建立基准。
3. 连续运行每满 **10 分钟**，在下一次检查时补满，补满优先于本次扣减。goal 变更不推迟这个周期。
4. 预算耗尽暂停自动继续，不中断工具；用户 `/goal resume` 补满并开始新的连续运行周期。

间隔达到 1 分钟只是不扣，不会补满预算。普通工具 turn_end、只读查询、
backtrack/compact 摘要、待投递消息、其他扩展的继续都不消耗或补满预算。
错误重试独立处理，也不会补满预算。暂停时间不计入连续运行周期。

`goal_show({})` 的 `continuationBudget` 显示模块预算，`/goal` 也会显示剩余次数。
预算仅保存在当前模块实例中；重新加载后等待用户恢复执行。
这只是简单启发式，不判断实际进展；不得为续预算制造无意义的 goal 变更。

错误最多自动重试 10 次，退避 1–512 秒；中断或错误重试耗尽暂停。
重新打开会话、切换历史分支只恢复清单和累计用时，不自动运行。
旧记录的剩余轮数字段不再使用。

原 `goal_set` 已由 `goal_add` 替代；旧 `goal_update({status:"complete"|"pause"})`
改用带 ID 的 done/blocked 状态。执行暂停使用用户命令。

## 本地运行

需要 Pi 1.3.0 的 codemode、执行边界事件，Node.js ≥22.19.0。

```sh
npm ci --ignore-scripts
npm test
pi -e ./src/index.ts
```
