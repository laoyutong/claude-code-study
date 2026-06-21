# Bash Tool 设计理念

## 总览

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Bash tool 的核心设计目标                                             │
├──────────────────────────────────────────────────────────────────────┤
│ 1. 把 shell 命令当作高风险副作用处理                                 │
│    command 不是直接执行，而是先经过校验、hooks、权限、sandbox 判断     │
│                                                                      │
│ 2. 把短命令和长任务分开管理                                          │
│    短命令直接返回，长命令可前台看进度，也可后台化并持续追踪           │
│                                                                      │
│ 3. 把进程输出当作可持久化资源                                        │
│    stdout/stderr 默认落盘，前台只展示摘要/尾部，大输出给文件路径      │
│                                                                      │
│ 4. 把 shell 状态变化显式建模                                         │
│    cwd、abort、background、timeout 都有明确语义，不隐式污染上下文     │
│                                                                      │
│ 5. 把通用工具框架和 Bash 专属逻辑解耦                                │
│    toolExecution 负责统一编排，BashTool 负责 shell 语义和风险控制     │
└──────────────────────────────────────────────────────────────────────┘
```

一句话总结：Bash tool 的设计重点不是“执行命令”，而是把 shell 命令当成一个高风险、长生命周期、强状态副作用的任务来治理。

---

## 1. 分层解耦

Bash tool 没有把调度、权限、执行、输出处理揉在一起，而是分成几层。

| 层次 | 代表文件 | 主要职责 |
|------|----------|----------|
| 通用工具编排 | `origin/src/services/tools/toolExecution.ts` | schema 校验、hooks、权限入口、调用 tool、封装 tool_result |
| Bash 语义层 | `origin/src/tools/BashTool/BashTool.tsx` | Bash 输入定义、前后台策略、结果解释、特殊路径处理 |
| Bash 权限层 | `origin/src/tools/BashTool/bashPermissions.ts` | 命令解析、规则匹配、路径/重定向约束、classifier 决策 |
| 进程执行层 | `origin/src/utils/Shell.ts`, `origin/src/utils/ShellCommand.ts` | shell provider、sandbox 包装、spawn、timeout、kill、background |
| 后台任务层 | `origin/src/tasks/LocalShellTask/LocalShellTask.tsx` | 后台任务注册、完成通知、stall watchdog、输出清理 |

这种分层的价值：

| 设计收益 | 说明 |
|----------|------|
| 通用能力复用 | hooks、权限、结果封装对所有工具一致 |
| Bash 风险可局部演进 | Bash 的安全规则可以单独复杂化，不污染通用工具框架 |
| 进程生命周期独立 | `ShellCommand` 专注 process 状态，不关心模型协议 |
| UI 和模型输出分离 | 同一执行结果可以分别服务 CLI 展示和 API tool_result |

---

## 2. 执行前多层拦截

Bash command 不是拿到就执行，而是经过多层关卡。

```text
command
  ├─ inputSchema.safeParse        // 参数类型和字段校验
  ├─ BashTool.validateInput       // Bash 自身轻量校验
  ├─ PreToolUse hooks             // 项目/用户 hook，可阻断或改 input
  ├─ bashToolHasPermission        // Bash 专属权限判断
  ├─ PermissionRequest hook       // 外部权限 hook 可 allow/deny
  ├─ classifier                   // 可自动审批一部分 ask 场景
  └─ interactive permission       // 需要时让用户确认
```

关键理念是 **fail closed**：当命令结构无法静态确认安全，或者解析结果太复杂时，倾向于 `ask`，而不是乐观执行。

| 风险场景 | 处理思路 |
|----------|----------|
| 命令解析失败或太复杂 | 返回 ask，避免误判为安全 |
| 有命令替换、进程替换、危险 shell 结构 | 进入安全检查或 ask |
| 复合命令含多个子命令 | 拆分检查，每个子命令都要可解释 |
| 原始命令存在重定向 | 对原始 command 单独检查路径约束 |
| `cd` 后执行 `git` | 特判 ask，防止进入恶意 repo 后触发 git 风险 |
| 明确 deny 规则命中 | deny 优先于 ask 和 allow |

这个策略适合 shell 工具，因为 shell 语法非常容易藏副作用。宁可多问一次，也不要把不确定命令当成安全命令执行。

---

## 3. 权限系统不是简单 allow-list

Bash 权限设计不是“命令在白名单就跑”。它支持多种决策来源，并把它们合并成最终 `allow` / `deny` / `ask`。

| 决策来源 | 作用 |
|----------|------|
| 精确命令规则 | 允许或拒绝完整 command |
| 前缀/通配规则 | 允许一类命令，例如某个测试命令前缀 |
| 路径权限 | 限制读写路径、重定向目标、跨目录访问 |
| permission mode | 不同模式下自动允许或拒绝部分行为 |
| Bash prompt classifier | 对自然语言规则描述做自动判断 |
| PermissionRequest hook | 外部 hook 可以统一接管权限 |
| 用户交互确认 | 用户可以允许一次、持久允许、拒绝并给反馈 |
| worker / swarm 转发 | 子任务场景可把权限请求转给 leader |

这套设计的好处是它能覆盖不同使用场景：

| 场景 | 需要的能力 |
|------|------------|
| 本地交互开发 | 用户确认、一次性批准、保存规则 |
| 自动化任务 | classifier 和规则减少反复打断 |
| 子 agent / worker | 权限请求可转发，不让子进程擅自扩大权限 |
| 团队/策略环境 | hook 和配置可以集中约束高风险命令 |

---

## 4. sandbox 是执行策略的一部分，不是唯一安全边界

Bash tool 会根据 `shouldUseSandbox(input)` 判断是否包 sandbox。

```text
shouldUseSandbox
  ├─ sandbox 总开关关闭 → 不 sandbox
  ├─ dangerouslyDisableSandbox 且策略允许 → 不 sandbox
  ├─ command 为空 → 不 sandbox
  ├─ 命中 excludedCommands → 不 sandbox
  └─ 其他情况 → sandbox
```

这里的设计重点是：sandbox 是防线之一，但不是全部防线。

| 防线 | 角色 |
|------|------|
| 权限规则 | 决定命令是否可以执行 |
| 路径/重定向校验 | 防止绕过读写边界 |
| sandbox | 限制进程实际能访问/修改的系统资源 |
| sandbox failure 注解 | 执行失败后把 sandbox 相关原因反馈给模型 |
| unsandboxed 策略 | 控制是否允许显式绕过 sandbox |

`excludedCommands` 更像用户体验配置，不应被当成安全边界。真正的安全控制仍在权限系统、路径校验和 sandbox 策略上。

---

## 5. 前台体验和后台生命周期分开

Bash 命令可能一瞬间结束，也可能跑很久。设计上没有让所有命令都阻塞主会话。

| 命令类型 | 行为 |
|----------|------|
| 短命令 | 2 秒内结束，直接返回结果 |
| 普通长命令 | 2 秒后展示进度和尾部输出 |
| 显式后台 | `run_in_background: true` 时立即返回后台任务 ID |
| 超时后台 | 命令允许 auto-background 时，timeout 转后台而不是直接 kill |
| assistant 自动后台 | 主 agent 长时间阻塞时转后台，保持对话响应 |
| 用户 Ctrl+B | 用户可把正在前台运行的任务手动放到后台 |

这个设计把“命令是否还在运行”和“主对话是否继续”拆开了。长命令不再天然等于阻塞对话。

后台任务由 `LocalShellTask` 管理：

```text
background task
  ├─ 持有 ShellCommand
  ├─ 输出继续写入 TaskOutput 文件
  ├─ 结束后更新 task state
  ├─ 发送 <task_notification>
  └─ 后续由模型按 output_file 读取完整输出
```

这种方式让长任务有稳定生命周期，而不是依赖某个前台 tool call 一直挂住。

---

## 6. 后台任务执行链路

后台任务不是重新起一个命令跑，而是把已经创建的 `ShellCommand` 切到后台，由 `LocalShellTask` 接管生命周期。

```text
BashTool.call
  └─ runShellCommand
      ├─ exec(...) 先 spawn 出 ShellCommand
      ├─ 触发后台条件
      │    ├─ run_in_background: true
      │    ├─ timeout auto-background
      │    ├─ assistant auto-background
      │    └─ Ctrl+B 手动后台
      └─ spawnShellTask / backgroundExistingForegroundTask
          └─ LocalShellTask 接管
```

具体步骤：

| 步骤 | 发生位置 | 说明 |
|------|----------|------|
| 1. 创建进程 | `runShellCommand → exec(...)` | 先真实 `spawn` 子进程，返回 `ShellCommand`；输出从一开始就写入 `TaskOutput` 文件 |
| 2. 触发后台化 | `runShellCommand` | 显式后台、超时后台、assistant 自动后台、Ctrl+B 都会走后台化路径 |
| 3. 注册后台任务 | `spawnShellTask(...)` | 使用 `shellCommand.taskOutput.taskId` 作为 taskId，写入 `AppState.tasks` |
| 4. ShellCommand 切后台 | `shellCommand.background(taskId)` | `status` 从 `running` 变成 `backgrounded`，进程继续跑 |
| 5. 原 tool call 返回 | `BashTool.mapToolResultToToolResultBlockParam` | 返回 `backgroundTaskId` 和输出文件路径，不等待命令结束 |
| 6. 后台完成通知 | `shellCommand.result.then(...)` | flush 输出、cleanup、更新任务状态、发送 `<task_notification>` |

显式后台和前台转后台略有区别：

| 场景 | 路径 | 差异 |
|------|------|------|
| `run_in_background: true` | `spawnShellTask(...)` | 命令刚创建就进入后台，原 tool call 立即返回 |
| timeout / assistant auto-background | `spawnShellTask(...)` 或 `backgroundExistingForegroundTask(...)` | 如果已注册 foreground task，会原地转后台，避免重复注册 |
| Ctrl+B 手动后台 | `backgroundAll(...) → backgroundTask(...)` | 用户把正在前台显示进度的任务转后台 |

后台任务完成后进入 pending notification 队列：

```xml
<task_notification>
  <task_id>...</task_id>
  <tool_use_id>...</tool_use_id>
  <output_file>...</output_file>
  <status>completed|failed|killed</status>
  <summary>Background command "..." completed</summary>
</task_notification>
```

这条通知会回到模型上下文。模型看到后台任务已完成后，可以根据 `output_file` 读取完整输出。

后台任务还有两类保护：

| 保护 | 位置 | 作用 |
|------|------|------|
| stall watchdog | `LocalShellTask.startStallWatchdog` | 输出长时间不增长且尾部像交互式 prompt 时，提醒模型命令可能卡住 |
| size watchdog | `ShellCommand.background` | 后台输出文件过大时 kill 进程，避免写满磁盘 |

---

## 7. 输出走文件，而不是全部塞进内存

Bash 默认把 stdout 和 stderr 写到同一个 `TaskOutput` 文件。

```text
stdio: ['pipe', outputFileFd, outputFileFd]
```

也就是：

| 设计 | 价值 |
|------|------|
| stdout/stderr 合并落盘 | 保留相对输出顺序，适合 shell 命令真实输出 |
| 前台进度轮询文件尾部 | 不需要 JS 长时间消费大流 |
| 大输出持久化 | tool_result 只返回预览和文件路径 |
| 后台任务复用同一输出文件 | 前台转后台不会丢输出 |
| 输出大小 watchdog | 防止后台命令无限写满磁盘 |

这对 `npm test`、`cargo build`、日志 tail、代码搜索这类输出量不可控的命令很重要。模型需要的是“可读摘要 + 必要时读完整文件”，不是把所有输出一次性塞回上下文。

---

## 8. shell 状态变化被显式建模

shell 命令的结果不只是 stdout。它还可能改变 cwd、持续运行、被中断、被后台化。

| 状态 | 设计处理 |
|------|----------|
| cwd 变化 | provider 写出最终 `pwd -P`，前台完成后更新会话 cwd |
| 子 agent cwd | `preventCwdChanges = true`，避免污染主会话 |
| 后台 cwd | 后台任务不更新主会话 cwd |
| 用户中断 | 区分 `interrupt` 和真正取消 |
| timeout | 可 kill，也可 auto-background |
| background | `ShellCommand.status` 切到 `backgrounded`，由任务系统接管 |

尤其是 cwd 处理很关键。没有显式建模时，一个 `cd` 命令会让后续命令在哪执行变得含糊；这里把 cwd 更新作为进程完成后的受控副作用处理。

---

## 9. 中断、取消和后台不是同一件事

`ShellCommand` 对 abort 的处理比较克制：

| 场景 | 行为 |
|------|------|
| `abortSignal.reason === 'interrupt'` | 不立刻 kill，给上层机会保留进程或输出 |
| 明确取消 / kill | 使用 `tree-kill` 结束进程树 |
| timeout 且可后台 | 不 kill，转后台 |
| Ctrl+B | 不 kill，转后台 |

这说明设计上区分了三类动作：

| 动作 | 含义 |
|------|------|
| interrupt | 当前对话流被打断，但命令不一定应该死 |
| cancel/kill | 用户或系统明确要停止进程 |
| background | 进程继续跑，只是不再阻塞当前 tool call |

对 CLI agent 来说，这个区分很重要。否则用户发新消息、命令超时、用户想放后台，都可能被粗暴处理成 kill。

---

## 10. 对真实风险做专项设计

文档里最值得注意的不是“有很多 if”，而是很多分支都对应真实 shell 风险。

| 机制 | 针对的问题 |
|------|------------|
| sed 预览后直接应用 `_simulatedSedEdit` | 避免预览 diff 和实际 sed 执行结果不一致 |
| AST 解析 + legacy 安全检查 | 减少 shell 字符串解析绕过 |
| 原始重定向路径检查 | 防止 split 子命令后丢失 `>` / `>>` 信息 |
| `cd + git` ask | 防止进入恶意 repo 后触发 git 配置/钩子风险 |
| sandbox failure 注解 | 让模型知道失败和 sandbox 相关，而不是盲目重试 |
| stall watchdog | 后台命令疑似等待交互输入时提醒模型 |
| output size watchdog | 防止后台无限输出写满磁盘 |
| `GIT_EDITOR=true` | 避免 git 命令打开交互式编辑器卡住 |

这些设计说明 Bash tool 是按“真实命令会出什么事故”来建模的，而不是只按 happy path 建模。

---

## 11. 可借鉴的工程原则

| 原则 | 在 Bash tool 中的体现 |
|------|----------------------|
| 高风险操作先治理再执行 | schema、hooks、权限、安全解析、sandbox 都在 spawn 前 |
| 不确定即升级确认 | 复杂 shell 结构倾向 ask |
| 长任务不阻塞主流程 | 前台进度、显式后台、自动后台、后台通知 |
| 大输出不要塞上下文 | 输出落盘，tool_result 只给预览和路径 |
| 状态副作用显式化 | cwd、background、timeout、abort 都有明确语义 |
| 通用流程和领域逻辑分离 | toolExecution 通用，BashTool 专属 |
| 用户体验和安全策略并重 | 支持一次允许、持久规则、classifier、hook、sandbox |

如果要给其他高风险 tool 复用这个设计，优先复用这几个思想：

1. **先把执行对象结构化**：不要直接执行原始字符串。
2. **把权限判断做成可组合决策**：规则、hook、用户、classifier 都能参与。
3. **把长生命周期任务从当前响应里拆出去**：用任务 ID 和通知承接后续状态。
4. **把大输出当作文件资源**：模型按需读取，而不是强塞上下文。
5. **把副作用写清楚**：工作目录、文件修改、进程状态都要有归属和边界。

---

## 关键源码索引

| 文件 | 看什么 |
|------|--------|
| `origin/src/services/tools/toolExecution.ts` | 通用工具编排、hooks、权限、结果封装 |
| `origin/src/hooks/useCanUseTool.tsx` | 权限决策如何合并静态规则、classifier、用户确认 |
| `origin/src/hooks/toolPermission/PermissionContext.ts` | 权限结果、持久化规则、取消和 hook 决策 |
| `origin/src/tools/BashTool/BashTool.tsx` | Bash 输入 schema、前后台策略、结果处理 |
| `origin/src/tools/BashTool/bashPermissions.ts` | Bash 安全解析、规则匹配、路径和子命令校验 |
| `origin/src/tools/BashTool/shouldUseSandbox.ts` | sandbox 是否启用的决策 |
| `origin/src/utils/Shell.ts` | shell provider、sandbox 包装、spawn、cwd 追踪 |
| `origin/src/utils/ShellCommand.ts` | timeout、kill、background、ExecResult |
| `origin/src/tasks/LocalShellTask/LocalShellTask.tsx` | 后台任务生命周期、通知、watchdog |
