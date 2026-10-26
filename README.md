# pi-goal

让 Agent 围绕一个目标持续工作，直到完成或遇到阻塞。

## 使用

```text
/goal 修复测试失败，直到全部通过
```

目标未完成时，Agent 每次准备结束都会收到提醒并继续执行。完成或遇到阻塞时，由 Agent 通过 codemode 更新状态：

```js
await tools.goal_set({text: "完成用户已明确要求的多步任务"}); // 创建，不替换
await tools.goal_show({});     // 查看目标、状态、设置/恢复时间及累计运行时间
await tools.goal_update({status: "complete"}); // 完成
await tools.goal_update({status: "pause"});    // 阻塞或等待用户
```

这些工具仅通过 codemode 提供，不注册为模型的独立工具。Agent 只能为用户明确要求的多步任务创建目标，不能扩大范围或权限。已有运行中、暂停或清除的目标时，`goal_set` 拒绝设置，须由用户用 `/goal <目标>` 替换或 `/goal resume` 恢复；完成后可为用户的新任务创建目标。

Agent 创建的目标在提示送达后最多运行 20 个模型回合，耗尽即暂停目标自动继续，不强制中断工具或当前执行。`goal_show` 显示剩余预算；用户 `/goal resume` 补充 20 轮，用户直接设置的目标不受此限制。

| 命令 | 操作 |
| --- | --- |
| `/goal <目标>` | 设置或替换目标 |
| `/goal` | 查看目标、状态和累计运行时间 |
| `/goal pause` | 暂停自动继续，不中断当前执行 |
| `/goal resume` | 恢复目标并继续执行 |
| `/goal clear` | 停止追踪目标 |

状态栏显示运行、暂停或完成状态。错误后最多自动重试 10 次，等待时间逐次增加，仍失败则暂停。主动中断、暂停或清除会停止自动恢复；重新打开会话或切换历史分支后，运行中的目标恢复为暂停，由用户决定是否继续。

## 本地运行

需要 Pi 的 codemode 工具和 `agent_before_settle` 扩展事件，Node.js ≥22.19.0。

```sh
cd /path/to/pi-goal
npm ci --ignore-scripts
npm run build
pi -e ./src/index.ts
```
