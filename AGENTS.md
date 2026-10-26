# pi-goal 维护指南

- README 仅保留用途和用户操作；技术约束写在此处。
- 小型扩展：state.ts 管清单/运行状态，index.ts 管工具、命令、Pi 事件。
- Pi 1.3.0，Node.js ≥22.19.0；npm test 构建并运行隔离的模拟 provider + 真实 SDK/codemode 测试。

## 清单与运行

- 持久化 pi-goal-state v2：goals + run。没有顶层目标；每个 goal 就是一项。
- setBy 固定 user/assistant，updatedBy 记录最近编辑者；工具来源 assistant，命令来源 user。禁止参数覆盖作者/ID。
- add/update/delete/show 始终只通过 codemode 暴露；没有 goal_set/goal_clear 独立工具。show 只读，包括 pending、暂停及软删除查询。
- 软删除留下 deletedAt，默认隐藏；分支上的每次状态快照就是变更历史，不另建审计框架。
- run.ids 是当前用户授权的执行范围。纯 CRUD 不启动、不扩大范围、不重置预算；重写文本撤销该 ID 的执行范围。
- 用户 resume 纳入当前 todo/doing，统一 20 轮；active 时重复 resume 无副作用。/goal <text> 是明确新增并执行的快捷命令，active 时只扩展范围不续预算。
- 预算按投递后 active turn_end 消耗，失败回合也计数。blocked/done/cancelled/deleted 不再推动本轮。最后 runnable 消失时 reconcile 暂停或完成。
- Agent 不可修改 cancelled/deleted；用户可重开 cancelled。语义授权、禁止重建取消项、删除用户项须确认依靠工具描述，不声称代码能验证同意。
- 旧单目标迁移为 legacy ID。旧预算字段只能证明 assistant 来源；无法判断的来源/时间保持缺失，不伪造。
- restore 只读当前分支，active -> paused，保留预算、累计用时，不计离线时间。

## 投递与边界

- 用户清单修改通过唯一 goalDelivery + steer 送达。匹配 message_start 前拒绝所有 Agent 写操作；读始终开放。idle 时 triggerTurn:false 落上下文但不启动。
- 暂停/取消不会中断当前工具、撤回已经投递或排队的提示。CRUD 仍可维护暂停的清单。
- agent_before_settle 是自动继续边界，尊重已有 event.continue / pending messages。
- compact 成功的 session_compact 发送一条简短 pi-goal custom message，triggerTurn:false。失败不注入。
- backtrack 成功 tool_result 设标记，整个工具批次 turn_end 追加摘要到 event.entries；不在工具未完成时发送。这样和 pi-backtrack 的零点 compaction 边界无关加载顺序，摘要留在新基线之后。失败不注入，同批最多一条。
- 摘要用真实 item 状态 todo/doing/blocked/done/cancelled，执行状态单列，不混用 active/pause/complete 作为 item 状态。摘要本身不续预算/启动/修改清单。
- /goal 状态使用通知，TUI/RPC/print 均可用，无后台 UI 定时器。

## 错误恢复

- 连续错误最多 10 次，指数退避 1–512 秒；耗尽暂停。
- 第一次重试追加提示，之后 context_edit 从请求上下文排除最近失败 assistant，原始历史不删。
- retryRequested 仅返回 continuation 时置 true，agent_start 清除；最终 settled 未启动重试则暂停。
- 用户暂停、编辑、清除、恢复、shutdown 取消等待；旧 controller finally 不得清除新 controller。

## 验证

- controls.test.mjs：CRUD、作者、只读、投递屏障、共享预算、软删除、状态、重试、摘要。
- state.test.mjs：来源/时间、快照隔离、旧版本迁移、持久化校验。
- goal.test.mjs：真实 SDK/codemode、20轮、steer、provider 重试、compact、backtrack 工具结果边界。
- 与真实 pi-backtrack 联测（两种加载顺序、零点基线）：
  PI_GOAL_BACKTRACK_TEST=file:///absolute/path/to/pi-backtrack/dist/index.js npm test
- 不访问用户会话、不请求在线模型。
