# pi-goal

围绕用户设置的一个目标持续工作，直到完成、受阻或用户暂停。
没有任务列表、层级或任务 ID；Agent 不能创建、改写或删除目标。

## 使用

```text
/goal 修复登录功能并验证测试通过
```

| 命令 | 操作 |
| --- | --- |
| `/goal <目标>` | 设置或替换唯一目标 |
| `/goal` | 查看目标、状态和累计运行时间 |
| `/goal pause` 或 `/goal parse` | 暂停自动继续 |
| `/goal resume` | 恢复暂停或受阻的目标 |
| `/goal clear` | 结束当前目标，历史仍保留 |

暂停、清除不强制中断正在执行的工具，也不撤回已排队提示。
恢复受阻目标表示重试，不代表阻塞条件已解决或可以绕过权限确认。

Agent 仅通过 codemode 查看目标或报告结果：

```js
await tools.goal_show();
await tools.goal_update({status: "complete"}); // 目标达成
await tools.goal_update({status: "blocked"});  // 无法推进，停止自动继续
```

受阻后直接 `/goal resume` 即可重试；已完成或清除的目标不恢复，用 `/goal <目标>` 设置新目标。
`goal_show` 只展示目标正文和状态。仅 active 时显示状态栏，并在 backtrack/compact 后补一行：
`[pursuing goal (0h 43m 23s); codemode tools.goal_show() for detail]`，不启动执行。

## 自动继续保护

不限制模型总轮数。模块共享 10 次重复提醒预算：
- 目标变更或用户恢复执行时补满。
- 只在 goal 准备重复注入提醒的结束边界检查：无变更且与上次间隔小于 1 分钟，扣一次；首次只记时间。
- 连续运行满 10 分钟，在下一次检查时补满，优先于本次扣减。
- 耗尽后暂停，可由用户 resume。长间隔不扣、不补；普通工具回合、查询和摘要不计数。

这是简单启发式，快速正常工作也可能触发。错误另有最多 10 次自动重试，退避 1–512 秒。
重新打开会话或切换历史分支不会自动续跑。

旧列表版本仅恢复最近一个用户创建的顶层目标；其他条目留在原会话历史，不再作为活动清单。
旧列表的累计用时无法归属单个目标，迁移后从零计时。

## 本地运行

需要 Pi 1.3.0 的 codemode 和执行边界事件，Node.js ≥22.19.0。

```sh
npm ci --ignore-scripts
npm test
pi -e ./src/index.ts
```
