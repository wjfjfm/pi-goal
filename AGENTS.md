# pi-goal 维护指南

- 保持单目标扩展：state.ts 管一个目标和计时，index.ts 管命令、工具、投递及保护。
- Pi 1.3.0，Node.js ≥22.19.0；npm test 使用模拟 provider 和隔离目录，不访问用户会话或在线模型。
- README 面向用户。不要重新加入 task、清单、parentId、任务 ID、Agent 创建/编辑/删除目标等功能。

## 单目标契约

- 用户 /goal <text> 设置或替换唯一目标，setBy=user；/goal 查看；pause 暂停，resume/continue 恢复，clear/exit 关闭。show 为查看兼容别名。
- 只有一个状态：active / paused / blocked / complete / closed。无第二份 run 状态，无 task doing 与 goal paused 分离的问题。
- Agent 仅有 codemode-only goal_show() 和 goal_update({status:"complete"|"blocked"})。schema 拒绝额外参数。无 goal_set/add/delete、task_*，也没有 Agent resume。
- goal_update 必须 active、已送达且 signal 未取消。完成/阻塞都停止计时和自动继续；用户 resume 接受 paused/blocked，切回 active 并注入一次目标上下文；active 直接跳过，不恢复 complete/closed。
- goal_show 纯只读，模型正文包含 Goal/Status/Running time 和一行 goal_update 操作提示（无目标为 No goal set.）；更新回复只有 Goal complete/blocked。诊断 details 保留 goal 快照、pendingDelivery、continuationBudget，不向模型展开元数据。无 ID、父子关系或清单字段。
- set 重置累计用时和设置时间；resume 保留累计用时、记录 resumedAt；elapsed 不含暂停或离线时间。
- 设置/替换/恢复仅注入两行：Goal: <text> 和 Use codemode tools.goal_update({status:"complete"|"blocked"}) when done or blocked.，不重复计时、权限或恢复说明。目标提示 display:false；compact/backtrack 摘要格式 [pursuing goal (0h 43m 23s); codemode tools.goal_show() for detail]，display:true；仅 active 时显示摘要与状态栏，其他状态不显示；时间为累计 active 用时。手动查询仍可查看所有状态。/goal 使用通知，仅展示目标、状态和累计用时；TUI/RPC/print 通用。

## 持久化与迁移

- pi-goal-state v3：{version:3,goal:Goal|null}；每次快照记录历史，不清除旧 entries。
- restore 只读当前分支最新状态。active -> paused，blocked 保持 blocked，无自动运行。
- v2 列表仅选最后一个 setBy=user 且无 parentId 的根；不采用 assistant 子任务。最后根已取消/删除则 closed，不倒退选择更旧根。done -> complete，blocked 保留，其余 paused。
- v2 多任务用时无法归属单目标，迁移 elapsedMs=0；不伪造迁移的恢复时间。
- 旧单目标格式仍支持；agentTurnsRemaining 存在的旧 assistant-created 目标不自动采用。旧未知作者/时间不伪造。
- 仅序列化单目标字段，剥离旧 id/parentId/goals/run/turnsRemaining 等字段。

## 投递与边界

- 用户设置/恢复共用唯一 goalDelivery + steer、triggerTurn:true；目标为 paused/blocked 时恢复：Agent 空闲则启动，运行中则 steer；目标已 active 则直接跳过，不注入。匹配 message_start 才清除投递屏障，防止旧工具结果完成新目标。
- pause/clear 关闭写回与自动继续，不中断工具，不撤销已排队提示。resume 建立新的投递屏障。
- agent_before_settle 是自动继续边界，尊重 event.continue、pending messages 和投递屏障。自动继续只注入与 compact/backtrack 相同的一行 pursuing goal 摘要，display:false，不重复目标全文或操作说明。
- compact 成功且 active 时发送简短状态，triggerTurn:false。成功 backtrack tool_result 置标记，在整批工具 turn_end 清除标记，仅 active 时在 event.entries 后追加一次摘要。失败不注入，不更改目标或预算。
- restore/shutdown 取消重试；shutdown 将 active 保存为 paused。

## 模块重复提醒预算

- 当前模块实例共享10次，不是模型轮数限制；普通 turn_end 只保存累计用时。
- 仅成功、active、无 pending/其他 continuation、准备重复注入时检查。
- 首次/目标变更后首次只建基准；无变更且间隔 <60000ms 扣1，归零暂停。本次不返回 continuation；保留0便于诊断。
- >=60000ms 不扣也不补满。连续 active 满600000ms 在下次检查补满，本次不扣；无后台计时器。
- 用户替换 active 目标补满但不推迟连续周期；新运行/resume 重置预算及周期；active 时 resume 无副作用，不重置预算或注入上下文。
- Agent complete/blocked 或用户 pause/clear 属于目标状态变化，补满但不恢复执行；错误/保护机制暂停不补预算。
- 查询、摘要、pending、其他扩展继续和错误重试不计数；时钟倒退只重建基准，不赠送预算。预算不持久化。

## 错误恢复

- 连续错误最多10次，退避1–512秒，耗尽暂停。
- 每段连续错误的第一次只追加一行 pursuing goal 摘要，display:false；后续 context_edit 排除最近失败 assistant 的请求上下文，保留原始历史。
- retryRequested 仅在返回 continuation 时设置，agent_start 清除；最终 settled 未执行重试则暂停。
- pause/clear/replace/restore/shutdown 取消等待，旧 controller finally 不清除新 controller。

## 验证

- controls.test.mjs：两工具接口、用户控制、阻塞恢复、投递屏障、预算、取消、摘要；精确断言设置/恢复和重复提醒正文，防止上下文再次膨胀。
- state.test.mjs：单目标替换、计时、快照校验、v2/旧单目标迁移。
- goal.test.mjs：真实 SDK/codemode、运行中替换、阻塞恢复、长工具执行、错误恢复、compact。
- 真实 pi-backtrack 两种加载顺序联测：
  PI_GOAL_BACKTRACK_TEST=file:///absolute/path/to/pi-backtrack/dist/index.js npm test
