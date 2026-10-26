# pi-goal 维护指南

## 约定

- README 只保留用途、操作和必要提醒；实现、测试及维护约束写在这里。
- 保持小型扩展：`src/state.ts` 管目标状态和计时，`src/index.ts` 管 Pi 事件、命令、工具和 UI。不要为少量状态转换添加框架。
- 开发依赖与当前宿主 Pi 1.3.0 对齐；Node.js ≥22.19.0。`npm test` 构建并运行单元测试及真实 SDK/codemode 集成测试。

## 生命周期与投递

- 未启用目标时，`goal_update` 为 hidden，不向模型添加目标提示。激活时通过 codemode 暴露，不增加独立模型工具声明。
- `goal_show({})` 始终以 codemode 暴露，包括无目标、待投递、暂停、完成及清除后；不增加独立模型工具声明。`goal_update` 的 status 仅接受 complete/pause，不兼容错误的 show 状态设计。
- `goal_show({})` 只读返回目标快照、设置时间、最近恢复时间（有才显示）、累计运行时间与待投递标记；时间以 ISO 8601 UTC 显示，`setAt`/`resumedAt` 随状态持久化，替换目标重置，旧记录不伪造时间；不落盘、不通知、不取消重试、不改变工具暴露策略。完成和暂停仍须通过 active 与投递屏障检查。
- 目标状态写入 `pi-goal-state` custom entry，不进入模型上下文。恢复只读当前分支；恢复 active 为 paused，不自动运行，不计离线时间。
- 设置与恢复共用投递路径，使用 steer 等待当前工具批次结束。唯一 `goalDelivery` 标记匹配 `message_start` 后才开放完成工具，避免旧回合完成未送达的新目标。
- 暂停、清除不能撤回已经投递或排队的提示，也不取消当前工具。它们关闭目标自动继续和完成入口。不要声称 sendMessage 返回就代表落盘或模型已看到消息。
- `agent_before_settle` 才是自动继续边界；尊重已有 `event.continue` 和待发送消息，避免重复提醒或抢占其他扩展的继续策略。
- 状态菜单只用于 `ctx.mode === "tui"`；RPC/print 使用通知报告状态。菜单等待期间目标被替换或恢复后，丢弃旧菜单操作。
- 定时器只在重试等待和打开菜单期间存在；取消、恢复及 shutdown 负责清理，不在扩展 factory 启动长期任务。

## 错误恢复

- 连续错误最多自动重试 10 次，退避为 1、2、4、8、16、32、64、128、256、512 秒，耗尽后暂停。成功边界或显式重新激活重置预算。
- 同一错误序列仅第一次追加 resumed 提示；之后通过 context_edit 从后续上下文排除对应失败 assistant 消息，保留原始历史、UI 和统计。
- 重试标记只在确实返回 continuation 时设置；若请求的重试没有启动而最终 settled，暂停目标，避免看似 active 却没有后续执行。
- 暂停、清除、替换、恢复和退出取消旧等待；旧 controller 的 finally 不得清除新 controller。

## 验证

- `test/controls.test.mjs`：状态、工具暴露、投递屏障、退避预算、取消、事件组合及菜单/RPC 行为。长退避使用 mock timers，不实际等待 512 秒。
- `test/goal.test.mjs`：计时与恢复验证、真实 SDK/codemode 完成及暂停、运行中工具后的 steer、主动中断和 provider 错误恢复。
- 使用隔离临时目录和模拟 provider，不访问用户会话，不请求在线模型。
