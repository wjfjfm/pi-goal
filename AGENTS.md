# pi-goal 维护指南

- README 仅保留用途和用户操作；技术约束写在此处。
- 小型扩展：state.ts 管清单/运行状态，index.ts 管工具、命令、Pi 事件。
- Pi 1.3.0，Node.js ≥22.19.0；npm test 构建并运行隔离的模拟 provider + 真实 SDK/codemode 测试。

## 用户入口与 Agent 工具

- 用户只需 `/goal <text>`、`/goal`、`/goal pause`、`/goal resume`、`/goal clear`。不提供 add/update/delete/parent 参数管理入口；旧语法仅提示用自然语言，不能误作为新目标启动。原 show/parse/continue/exit 别名仍兼容但不宣传。
- `/goal` 的 summary 不显示 ID 或 Authorized IDs；模型注入使用 internal summary 保留这些信息，指令消息 display:false，不向用户展开内部操作说明。compact/backtrack 简短摘要仍 display:true；codemode 返回的数据结构不变。
- 用户通过自然语言让 Agent 调整计划；工具调用仍记录 assistant 来源，不伪装为用户直接修改。不为自然语言请求添加自动解析器。
- Agent 自主管理多级 TODO，仅通过 codemode：
  - `goal_add({text,parentId?})`：新增，省略 parentId 为根。
  - `goal_show({id?})`：查询全表或单项，含来源、父子关系、执行范围及模块预算。
  - `goal_update({id,text?,status?})`：状态为 todo/doing/blocked/done/cancelled。
  - `goal_delete({id})`：软删除；有未删除子项时拒绝。
- 工具 CRUD 不直接启动/恢复执行；setBy 固定 user/assistant，updatedBy 记录最近实际修改者。

## 清单与运行

- 持久化 pi-goal-state v2：goals + run。每个 goal 就是一项，可选 parentId 组织多级树；缺省是根。旧 v2 无需迁移。
- add 可指定已有、未删除、非 done/cancelled 父项；不支持 reparent，因此正常写入不会成环。restore 修复悬空、自引用、环及活项指向已删除父项的链接为根，不丢弃任务。
- outline 用迭代 DFS 保持同层创建顺序，用户展示缩进，goal_show 全表按 DFS 返回带 parentId 的平铺条目；单项查询不隐含子树。
- 父子状态独立，无级联；含未删除直接子项的父项禁止删除（含 done/cancelled 子项），逐层删除后仍保留 tombstone parentId。子项作者、执行范围不继承父项。
- setBy 固定 user/assistant，updatedBy 记录最近编辑者；工具来源 assistant，命令来源 user。禁止参数覆盖作者/ID。
- add/update/delete/show 始终只通过 codemode 暴露；没有 goal_set/goal_clear 独立工具。show 只读，包括 pending、暂停及软删除查询。
- 软删除留下 deletedAt，默认隐藏；分支上的每次状态快照就是变更历史，不另建审计框架。
- run.ids 是当前用户授权的执行范围。纯 CRUD 不启动、不扩大范围；实际 goal 变更会补满模块预算；重写文本撤销该 ID 的执行范围。
- 用户 resume/continue 显式重试：将所有未删除 blocked 项改为 todo（updatedBy=user，保留 setBy/父子关系），与已有 todo/doing 一起纳入执行；不重开 done/cancelled/deleted，无总轮数上限。active 时重复 resume 无副作用。普通 /goal <text> 启动不隐式解锁其他 blocked 项。恢复提示要求重新核实阻塞条件，不代表权限或确认被豁免。/goal <text> 是明确新增并执行的快捷命令，active 时扩展范围，并因新增 goal 补满预算，但不重置连续运行周期。
- turn_end 仅持久化累计用时及处理摘要，不做轮数限制。blocked/done/cancelled/deleted 不再推动本轮。最后 runnable 消失时 reconcile 暂停或完成。
- Agent 不可修改 cancelled/deleted；用户通过简单命令控制整体执行，不再通过 ID 重开单项。语义授权、禁止重建取消项、删除用户项须确认依靠工具描述，不声称代码能验证同意。
- 旧单目标迁移为 legacy ID。旧预算字段只能证明 assistant 来源；无法判断的来源/时间保持缺失，不伪造。
- restore 只读当前分支，active -> paused，保留累计用时，不计离线时间。

## 投递与边界

- 用户新增目标、恢复、clear 通过唯一 goalDelivery + steer 送达。匹配 message_start 前拒绝所有 Agent 写操作；读始终开放。idle 时 triggerTurn:false 落上下文但不启动。
- 暂停/取消不会中断当前工具、撤回已经投递或排队的提示。CRUD 仍可维护暂停的清单。
- agent_before_settle 是自动继续边界，尊重已有 event.continue / pending messages。
- compact 成功的 session_compact 发送一条简短 pi-goal custom message，triggerTurn:false。失败不注入。
- backtrack 成功 tool_result 设标记，整个工具批次 turn_end 追加摘要到 event.entries；不在工具未完成时发送。这样和 pi-backtrack 的零点 compaction 边界无关加载顺序，摘要留在新基线之后。失败不注入，同批最多一条。
- 摘要用真实 item 状态 todo/doing/blocked/done/cancelled，执行状态单列，不混用 active/pause/complete 作为 item 状态。摘要本身不重置空转检测/启动/修改清单。
- /goal 状态使用通知，TUI/RPC/print 均可用，无后台 UI 定时器。

## 重复提醒预算

- 预算在扩展 factory 内共享，容量10，不属于单个 goal、层级或 run.ids。goal_show 返回只读 continuationBudget，/goal 显示余量。
- 仅在 agent_before_settle 成功、active、无待投递/待发送消息且 event.continue 为假，准备重复注入 goal 提醒时检查；普通工具 turn_end 不检查。
- 无 goal 变更且距上次合格边界 <60000ms，扣一次，归零暂停、不返回 continuation。首次/变更后首次只记基准；>=60000ms 不扣也不补满。
- 任意实际新增/修改/删除补满10并清除上次注入基准，但不推迟10分钟周期。GoalState 的 goals 数组仅实际变更时换引用，save 检测引用统一处理用户命令和工具。no-op update 不改 updatedAt/updatedBy 或数组引用。
- active 连续运行满600000ms，在下次合格边界补满并重新开始周期，本次不再扣减。不加计时器；查询不触发补满。
- 用户启动/恢复执行重置整个预算和周期；active 重复 resume 无副作用。暂停/恢复不累计离线时间。恢复分支重置内存预算但不自动执行。
- 错误重试、查询、摘要、其他扩展继续、pending 边界均不消耗/补满预算，也不更新时间基准。时钟倒退仅重建计时基准，不赠送预算。
- 预算耗尽时保留0用于诊断；暂停期间的 goal 实际变更可补预算，但不能恢复执行。
- 无总轮数上限。旧 run.turnsRemaining 忽略，旧 agentTurnsRemaining 仅用于判断历史来源。预算仅存在当前模块实例，不持久化。
- 这是简单启发式，不声称判断实际进展；不允许为补预算制造无意义的 goal 变更。

## 错误恢复

- 连续错误最多 10 次，指数退避 1–512 秒；耗尽暂停。
- 第一次重试追加提示，之后 context_edit 从请求上下文排除最近失败 assistant，原始历史不删。
- retryRequested 仅返回 continuation 时置 true，agent_start 清除；最终 settled 未启动重试则暂停。
- 用户暂停、新增目标、清除、恢复、shutdown 取消等待；旧 controller finally 不得清除新 controller。

## 验证

- controls.test.mjs：CRUD、作者、只读、投递屏障、一分钟扣减阈值/实际变更补满/十分钟周期/排除条件、软删除、状态、重试、摘要。
- state.test.mjs：来源/时间、快照隔离、旧版本迁移、持久化校验。
- goal.test.mjs：真实 SDK/codemode、快速空转暂停/超过20轮的正常工具执行、steer、provider 重试、compact、backtrack 工具结果边界。
- 与真实 pi-backtrack 联测（两种加载顺序、零点基线）：
  PI_GOAL_BACKTRACK_TEST=file:///absolute/path/to/pi-backtrack/dist/index.js npm test
- 不访问用户会话、不请求在线模型。
