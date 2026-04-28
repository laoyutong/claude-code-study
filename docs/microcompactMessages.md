# microcompactMessages 方法实现逻辑

## 概述

`microcompactMessages` 是一个消息压缩方法，用于在 API 请求前清理对话中的工具结果，减少 token 使用。它有两种压缩路径，按优先级执行。

## 核心流程

```
microcompactMessages()
    │
    ├── 1. 清除压缩警告抑制标志 (clearCompactWarningSuppression)
    │
    ├── 2. 时间基础微压缩 (maybeTimeBasedMicrocompact)
    │      └── 如果成功，直接返回
    │
    ├── 3. 缓存微压缩 (cachedMicrocompactPath) - 如果启用
    │      └── 如果成功，返回结果
    │
    └── 4. 默认：返回原始消息（无压缩）
```

---

## 步骤 1：清除压缩警告抑制标志

### 概述

在微压缩流程开始时，首先调用 `clearCompactWarningSuppression()` 清除警告抑制状态，为新的压缩尝试做准备。

### 源码位置

`origin/src/services/compact/compactWarningState.ts`

### 核心代码

```typescript
// 状态存储 - 使用响应式 store 管理抑制状态
export const compactWarningStore = createStore<boolean>(false)

/** 抑制压缩警告。在成功压缩后调用。 */
export function suppressCompactWarning(): void {
  compactWarningStore.setState(() => true)
}

/** 清除压缩警告抑制。在新压缩尝试开始时调用。 */
export function clearCompactWarningSuppression(): void {
  compactWarningStore.setState(() => false)
}
```

### 设计原因

**问题**：压缩成功后，本地 token 计数不准确。

- 压缩操作删除了工具结果，但本地估算的 token 数是基于旧消息计算的
- 准确的 token 计数需要等待下次 API 响应（API 会返回实际使用的 token 数）
- 如果在压缩后立即显示"上下文即将触发自动压缩"的警告，会误导用户

**解决方案**：使用抑制机制控制警告显示。

### 两个方法对比

| 方法 | 作用 | 状态变化 | 调用时机 | 调用位置 |
|------|------|----------|----------|----------|
| `suppressCompactWarning()` | 抑制警告 | `false → true` | 压缩成功后 | 时间基础微压缩、缓存微压缩的后置处理 |
| `clearCompactWarningSuppression()` | 清除抑制 | `true → false` | 新压缩尝试开始时 | `microcompactMessages` 入口处 |

### 调用位置详解

#### 1. clearCompactWarningSuppression 的调用

```typescript
// microCompact.ts:259
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // ★ 步骤 1：清除抑制标志，开始新的压缩尝试
  clearCompactWarningSuppression()

  // 步骤 2：尝试时间基础微压缩
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // 步骤 3：尝试缓存微压缩
  // ...

  // 步骤 4：返回原始消息
  return { messages }
}
```

**为什么在入口处调用？**
- 每次新的压缩尝试都是独立的
- 需要重置状态，允许警告再次显示
- 确保压缩成功后才会抑制警告

#### 2. suppressCompactWarning 的调用

**位置 A：时间基础微压缩成功后**

```typescript
// microCompact.ts - maybeTimeBasedMicrocompact 函数末尾
function maybeTimeBasedMicrocompact(...): MicrocompactResult | null {
  // ... 清理逻辑

  // ★ 压缩成功，抑制警告
  suppressCompactWarning()

  // 重置缓存状态
  resetMicrocompactState()

  return { messages: result }
}
```

**位置 B：缓存微压缩成功后**

```typescript
// microCompact.ts - cachedMicrocompactPath 函数
async function cachedMicrocompactPath(...): Promise<MicrocompactResult> {
  // ... 清理逻辑

  if (toolsToDelete.length > 0) {
    // ... 创建 cache_edits

    // ★ 压缩成功，抑制警告
    suppressCompactWarning()

    // 通知缓存删除检测器
    notifyCacheDeletion(querySource ?? 'repl_main_thread')

    return { messages, compactionInfo }
  }

  return { messages }
}
```

### 状态流转图

```
┌─────────────────────────────────────────────────────────────────┐
│                        压缩警告状态流转                          │
└─────────────────────────────────────────────────────────────────┘

初始状态: false (允许显示警告)
    │
    │
    ▼
microcompactMessages() 入口
    │
    ├─► clearCompactWarningSuppression()
    │       └─► 状态: false (确保可以显示警告)
    │
    ▼
尝试压缩...
    │
    ├─► 压缩失败/未触发
    │       └─► 状态保持: false (警告可显示)
    │
    └─► 压缩成功
            │
            ├─► suppressCompactWarning()
            │       └─► 状态: true (抑制警告)
            │
            └─► 用户不会看到"上下文即将触发自动压缩"警告
                (因为刚压缩过，token 计数不准确)

下一次 microcompactMessages() 调用
    │
    └─► clearCompactWarningSuppression()
            └─► 状态恢复: false (警告恢复显示)
```

### 实际场景示例

```
场景 1：压缩成功后的警告抑制

时间线:
T1: 用户发送消息，上下文接近阈值
    └─► microcompactMessages() 开始
        └─► clearCompactWarningSuppression() → 状态 = false
        └─► 压缩成功，删除 5 个工具结果
        └─► suppressCompactWarning() → 状态 = true
    └─► 用户不会看到警告 ✓

T2: 用户继续发送消息
    └─► microcompactMessages() 开始
        └─► clearCompactWarningSuppression() → 状态 = false
        └─► 未达到压缩阈值，不压缩
    └─► 状态保持 false，警告可显示 ✓

---

场景 2：连续压缩尝试

时间线:
T1: 第一次压缩尝试
    └─► clearCompactWarningSuppression() → 状态 = false
    └─► 压缩成功
    └─► suppressCompactWarning() → 状态 = true

T2: 第二次压缩尝试（很快再次触发）
    └─► clearCompactWarningSuppression() → 状态 = false
    └─► 压缩成功
    └─► suppressCompactWarning() → 状态 = true

关键点：每次压缩尝试前都会清除抑制，确保状态正确
```

### 与其他机制的配合

`clearCompactWarningSuppression` 是微压缩流程的第一步，与后续步骤紧密配合：

```
microcompactMessages() 完整流程:

步骤 1: clearCompactWarningSuppression()  ← 重置警告状态
    │
    ▼
步骤 2: maybeTimeBasedMicrocompact()
    │       │
    │       ├─► 成功 → suppressCompactWarning()  ← 抑制警告
    │       └─► 失败 → 继续
    │
    ▼
步骤 3: cachedMicrocompactPath()
    │       │
    │       ├─► 成功 → suppressCompactWarning()  ← 抑制警告
    │       └─► 失败 → 继续
    │
    ▼
步骤 4: return { messages }  ← 状态保持 false，警告可显示
```

---

## 两种压缩路径对比

| 特性 | 时间基础微压缩 | 缓存微压缩 |
|------|---------------|-----------|
| **触发条件** | 距上次 assistant 消息超过阈值时间 | 工具结果数量超过配置阈值 |
| **操作方式** | 直接修改消息内容 | 使用 `cache_edits` API |
| **缓存影响** | 会使缓存失效 | 保持缓存前缀有效 |
| **适用场景** | 缓存已过期时 | 缓存仍有效时 |
| **代码位置** | `maybeTimeBasedMicrocompact()` | `cachedMicrocompactPath()` |

## 可压缩的工具类型

定义在 `COMPACTABLE_TOOLS` 集合中：

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,    // 文件读取
  ...SHELL_TOOL_NAMES,    // Shell 命令
  GREP_TOOL_NAME,         // 内容搜索
  GLOB_TOOL_NAME,         // 文件模式匹配
  WEB_SEARCH_TOOL_NAME,   // 网页搜索
  WEB_FETCH_TOOL_NAME,    // 网页获取
  FILE_EDIT_TOOL_NAME,    // 文件编辑
  FILE_WRITE_TOOL_NAME,   // 文件写入
])
```

### 工具可压缩性的判断依据

**核心原则：结果是否可重现或已持久化**

| 工具 | 判断依据 | 说明 |
|------|----------|------|
| `Read` | 可重现 | 文件内容可通过重新读取获得 |
| `Bash`/`PowerShell` | 可重现 | 命令结果可通过重新执行获得 |
| `Grep` | 可重现 | 搜索结果可通过重新搜索获得 |
| `Glob` | 可重现 | 文件列表可通过重新匹配获得 |
| `WebSearch` | 可重现 | 搜索结果可通过重新请求获得 |
| `WebFetch` | 可重现 | 网页内容可通过重新获取获得 |
| `Edit` | 已持久化 | 编辑操作已应用到文件，结果可推断 |
| `Write` | 已持久化 | 写入操作已完成，结果可推断 |

### 不可压缩的工具（被排除）

以下工具不在 `COMPACTABLE_TOOLS` 中，原因如下：

| 工具 | 排除原因 |
|------|----------|
| `Agent` | 子 agent 执行结果，涉及复杂决策过程，无法重现 |
| `AskUserQuestion` | 用户交互结果，是唯一的交互机会，无法重现 |
| `TaskCreate`/`TaskUpdate`/`TaskList` | 任务状态追踪，需要保留完整上下文 |
| `Skill` | skill 执行可能有外部副作用，结果不可预测 |
| `SendMessage` | 消息已发送到外部系统，无法撤销或重现 |
| `CronCreate` | 定时任务已创建，有持久化副作用 |
| MCP 工具 | 外部系统交互，可能有不可逆的副作用 |

### 设计决策详解

#### 1. 可重现的结果

适用于：`Read`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`Bash`、`PowerShell`

```
场景示例：
  T1: Read file.ts → 返回文件内容（500 tokens）
  T2: 压缩清理 → 内容替换为 '[Old tool result content cleared]'
  T3: 模型需要查看文件 → 重新调用 Read，获得相同内容

关键点：
  - 清理后不丢失信息，只是节省当前上下文空间
  - 模型如需详细信息，可重新调用工具获取
  - 重新调用的成本（API 请求、时间）通常低于保留大量历史结果
```

#### 2. 已持久化的操作

适用于：`Edit`、`Write`

```
场景示例：
  T1: Edit file.ts → 文件已修改，返回 "Successfully edited"
  T2: 压缩清理 → 内容替换为 '[Old tool result content cleared]'
  T3: 模型需要确认修改 → 调用 Read file.ts，查看当前状态

关键点：
  - 编辑/写入已应用到文件系统，实际状态已持久化
  - 工具结果只是确认信息，不包含关键数据
  - 清理后，模型可通过 Read 重新查看文件当前状态
```

#### 3. 不可重现的结果

适用于：`Agent`、`AskUserQuestion`、`Skill`、`SendMessage`、`CronCreate`、MCP 工具

```
场景示例（Agent）：
  T1: Agent(subagent_type="Explore") → 返回代码库分析结果
  T2: 压缩清理 → ❌ 不应清理！
  原因：
    - 子 agent 的探索过程和决策无法重现
    - 分析结果可能包含重要的上下文信息
    - 重新运行 agent 可能得到不同结果（代码库可能已变化）

场景示例（AskUserQuestion）：
  T1: AskUserQuestion("选择方案 A 还是 B？") → 用户选择 "A"
  T2: 压缩清理 → ❌ 不应清理！
  原因：
    - 用户的选择是唯一的交互机会
    - 无法"重新询问"获得相同答案
    - 清理会丢失关键决策信息

场景示例（SendMessage）：
  T1: SendMessage(to="slack", message="部署完成") → 消息已发送
  T2: 压缩清理 → ❌ 不应清理！
  原因：
    - 消息已发送到外部系统，产生实际影响
    - 清理结果会让模型误以为消息未发送
    - 可能导致重复发送或其他错误决策
```

### 判断流程图

```
工具是否可压缩？
    │
    ├─► 结果是否可重现？
    │       │
    │       ├─► 是 → 可压缩（Read、Grep、Glob、WebSearch、WebFetch、Bash）
    │       │
    │       └─► 否 → 继续检查
    │
    ├─► 操作是否已持久化到文件系统？
    │       │
    │       ├─► 是 → 可压缩（Edit、Write）
    │       │
    │       └─► 否 → 继续检查
    │
    ├─► 是否有不可逆的副作用？
    │       │
    │       ├─► 是 → 不可压缩（SendMessage、CronCreate、MCP 工具）
    │       │
    │       └─► 否 → 继续检查
    │
    └─► 结果是否包含关键上下文？
            │
            ├─► 是 → 不可压缩（Agent、AskUserQuestion、Task*）
            │
            └─► 否 → 可压缩
```

## 路径一：时间基础微压缩

### 设计理念

当用户长时间未交互（超过服务器缓存 TTL），服务端的 prompt cache 已经过期失效。
此时无论发送什么请求，服务器都会重新计算完整的 prompt prefix。

**核心思想**：既然缓存必然失效，不如在发送请求前主动清理旧的工具结果，减少需要重新计算的内容量。

### 配置参数 (`TimeBasedMCConfig`)

```typescript
type TimeBasedMCConfig = {
  // 主开关：是否启用时间基础微压缩
  enabled: boolean           // 默认: false
  
  // 触发阈值：距上次 assistant 消息超过此分钟数时触发
  gapThresholdMinutes: number  // 默认: 60（与服务器 1h 缓存 TTL 对齐）
  
  // 保留数量：保留最近 N 个可压缩的工具结果
  keepRecent: number           // 默认: 5
}
```

**为什么 gapThresholdMinutes 默认是 60？**
- 服务器 prompt cache 的 TTL 是 1 小时
- 超过 60 分钟，缓存必然已过期
- 不会造成本不会发生的缓存 miss

### 触发条件检查 (`evaluateTimeBasedTrigger`)

```typescript
function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  
  // 条件 1: 配置必须启用
  // 条件 2: 必须有明确的 querySource（排除 /context、/compact 等分析场景）
  // 条件 3: 必须是主线程来源（排除子 agent）
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  
  // 找到最后一条 assistant 消息
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  
  // 计算时间间隔（分钟）
  const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  
  // 条件 4: 时间间隔必须超过阈值
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  
  return { gapMinutes, config }
}
```

### 清理逻辑详解 (`maybeTimeBasedMicrocompact`)

#### 步骤 1：收集可压缩的工具 ID

```typescript
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    // 只处理 assistant 消息（工具调用在 assistant 消息中）
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        // 找出所有可压缩工具的 tool_use 块，记录其 ID
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids  // 按遇到顺序排列，即时间顺序
}
```

**示例**：
```
messages 中包含:
  - assistant: tool_use(id="tool_1", name="Read")     ← 可压缩
  - assistant: tool_use(id="tool_2", name="Edit")     ← 可压缩
  - assistant: tool_use(id="tool_3", name="Agent")    ← 不可压缩
  - assistant: tool_use(id="tool_4", name="Grep")     ← 可压缩

collectCompactableToolIds 返回: ["tool_1", "tool_2", "tool_4"]
```

#### 步骤 2：计算保留集合和清理集合

```typescript
// 至少保留 1 个，避免清空所有上下文
const keepRecent = Math.max(1, config.keepRecent)

// 保留最近 N 个（使用 slice(-N) 取末尾）
const keepSet = new Set(compactableIds.slice(-keepRecent))

// 其余的都需要清理
const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))
```

**示例**（keepRecent = 2）：
```
compactableIds = ["tool_1", "tool_2", "tool_3", "tool_4", "tool_5"]

keepSet = Set(["tool_4", "tool_5"])   // 最近 2 个
clearSet = Set(["tool_1", "tool_2", "tool_3"])  // 其余的
```

#### 步骤 3：执行内容替换

```typescript
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

let tokensSaved = 0
const result: Message[] = messages.map(message => {
  // 只处理 user 消息（工具结果在 user 消息中）
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return message
  }
  
  let touched = false
  const newContent = message.message.content.map(block => {
    // 找到需要清理的 tool_result 块
    if (
      block.type === 'tool_result' &&
      clearSet.has(block.tool_use_id) &&
      block.content !== TIME_BASED_MC_CLEARED_MESSAGE  // 避免重复处理
    ) {
      // 统计节省的 token 数
      tokensSaved += calculateToolResultTokens(block)
      touched = true
      // 替换内容为占位符
      return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
    }
    return block
  })
  
  if (!touched) return message
  return { ...message, message: { ...message.message, content: newContent } }
})
```

**替换前后对比**：
```
// 替换前
{
  type: 'tool_result',
  tool_use_id: 'tool_1',
  content: 'export function foo() { ... }'  // 实际文件内容
}

// 替换后
{
  type: 'tool_result',
  tool_use_id: 'tool_1',
  content: '[Old tool result content cleared]'  // 占位符
}
```

#### 步骤 4：后置处理

```typescript
// 1. 记录分析事件
logEvent('tengu_time_based_microcompact', {
  gapMinutes: Math.round(gapMinutes),
  gapThresholdMinutes: config.gapThresholdMinutes,
  toolsCleared: clearSet.size,
  toolsKept: keepSet.size,
  keepRecent: config.keepRecent,
  tokensSaved,
})

// 2. 抑制压缩警告（避免用户看到不必要的提示）
suppressCompactWarning()

// 3. 重置缓存微压缩状态（因为消息内容变了，缓存状态已失效）
resetMicrocompactState()

// 4. 通知缓存删除检测器（预期会有 cache read 下降，不是异常）
if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
  notifyCacheDeletion(querySource)
}
```

### 完整流程图

```
maybeTimeBasedMicrocompact(messages, querySource)
    │
    ├─► evaluateTimeBasedTrigger() ──► null? ──► return null (不触发)
    │         │
    │         └─► 检查: enabled + querySource + gapMinutes > threshold
    │
    ├─► collectCompactableToolIds(messages)
    │         └─► 遍历 assistant 消息，收集可压缩工具的 ID
    │
    ├─► 计算 keepSet 和 clearSet
    │         ├─► keepSet = 最近 N 个 ID
    │         └─► clearSet = 其余 ID
    │
    ├─► 遍历 user 消息，替换 tool_result 内容
    │         └─► content → '[Old tool result content cleared]'
    │
    ├─► 统计 tokensSaved
    │
    └─► 后置处理
              ├─► logEvent()
              ├─► suppressCompactWarning()
              ├─► resetMicrocompactState()
              └─► notifyCacheDeletion()
```

## 路径二：缓存微压缩

### 设计理念

当缓存仍然有效时，使用 Anthropic 的 **cache editing API** 来删除工具结果，而不是直接修改消息内容。

**核心优势**：
- 不修改本地消息内容
- 不破坏缓存前缀（prefix 仍然有效）
- 通过 API 层的 `cache_edits` 指令实现远程删除
- 后续请求可以继续利用缓存

### 与时间基础微压缩的区别

| 方面 | 时间基础微压缩 | 缓存微压缩 |
|------|---------------|-----------|
| **缓存状态** | 已过期（必然失效） | 仍有效 |
| **修改方式** | 直接修改消息内容 | 使用 cache_edits API |
| **本地消息** | 内容被替换为占位符 | 内容保持不变 |
| **缓存影响** | 缓存失效，需重建 | 缓存前缀保持有效 |
| **状态管理** | 重置缓存状态 | 维护全局注册状态 |

### 入口条件检查

```typescript
async function cachedMicrocompactPath(messages, querySource) {
  // 条件 1: feature flag 启用
  if (!feature('CACHED_MICROCOMPACT')) return { messages }
  
  const mod = await getCachedMCModule()
  const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
  
  // 条件 2: 功能启用（GrowthBook 配置）
  if (!mod.isCachedMicrocompactEnabled()) return { messages }
  
  // 条件 3: 模型支持缓存编辑（只有部分模型支持）
  if (!mod.isModelSupportedForCacheEditing(model)) return { messages }
  
  // 条件 4: 主线程来源（排除子 agent）
  if (!isMainThreadSource(querySource)) return { messages }
  
  // ... 执行压缩逻辑
}
```

#### 四个条件的原因

| 条件 | 检查内容 | 原因 |
|------|----------|------|
| `feature('CACHED_MICROCOMPACT')` | 代码层面的开关 | 外部构建可以禁用此功能，避免引入不必要的依赖 |
| `isCachedMicrocompactEnabled()` | GrowthBook 运行时配置 | 支持灰度发布、A/B 测试、动态开关 |
| `isModelSupportedForCacheEditing()` | 模型是否支持 cache_edit API | 只有部分模型支持 cache editing 功能 |
| `isMainThreadSource()` | 是否为主线程来源 | 防止子 agent 污染全局 `cachedMCState` |

**为什么主线程限制很重要？**

```
问题场景：
  主线程: toolOrder = ["t1", "t2", "t3"]
  子 agent A: toolOrder = ["a1", "a2"]
  子 agent B: toolOrder = ["b1", "b2"]

如果子 agent 也写入全局状态：
  全局 toolOrder = ["t1", "t2", "t3", "a1", "a2", "b1", "b2"]  // 混乱！

结果：
  主线程尝试删除 "a1"，但这个工具在主线程对话中不存在
  → cache_edit 失败
  → 或者错误删除了主线程的工具

解决方案：
  只允许主线程执行缓存微压缩，子 agent 的工具由各自的上下文管理
```

### 初始化步骤

```typescript
const mod = await getCachedMCModule()      // 懒加载模块
const state = ensureCachedMCState()        // 获取/创建状态对象
const config = mod.getCachedMCConfig()     // 获取 GrowthBook 配置
```

**为什么懒加载？**
- `cachedMicrocompact.js` 是 Antropic 内部模块
- 外部构建不需要此功能，懒加载可以避免构建错误
- 减少启动时的加载开销

### 全局状态结构 (`CachedMCState`)

```typescript
interface CachedMCState {
  // 已注册的工具 ID 集合（避免重复注册）
  registeredTools: Set<string>
  
  // 工具出现顺序（用于确定"最近"）
  toolOrder: string[]
  
  // 已删除的工具引用（用于追踪已删除的工具）
  deletedRefs: Set<string>
  
  // 按 user message 分组的工具 ID
  toolMessages: string[][]
  
  // 已固定的缓存编辑（需要重新发送）
  pinnedEdits: PinnedCacheEdits[]
}

// 模块级单例状态
let cachedMCState: CachedMCState | null = null
let pendingCacheEdits: CacheEditsBlock | null = null
```

### 清理逻辑详解

#### 步骤 1：收集可压缩工具 ID

```typescript
// 与时间基础微压缩相同
const compactableToolIds = new Set(collectCompactableToolIds(messages))
```

#### 步骤 2：注册工具结果（按出现顺序）

```typescript
for (const message of messages) {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    const groupIds: string[] = []  // 当前 user message 中的工具 ID
    
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        compactableToolIds.has(block.tool_use_id) &&  // 是可压缩工具
        !state.registeredTools.has(block.tool_use_id)  // 未注册过
      ) {
        // 注册单个工具结果
        mod.registerToolResult(state, block.tool_use_id)
        groupIds.push(block.tool_use_id)
      }
    }
    
    // 注册当前 user message 的工具组
    mod.registerToolMessage(state, groupIds)
  }
}
```

**注册函数的作用**：
```typescript
function registerToolResult(state: CachedMCState, toolId: string) {
  state.registeredTools.add(toolId)
  state.toolOrder.push(toolId)  // 记录出现顺序
}

function registerToolMessage(state: CachedMCState, groupIds: string[]) {
  if (groupIds.length > 0) {
    state.toolMessages.push(groupIds)  // 按消息分组
  }
}
```

**为什么要按消息分组？**

```
消息结构示例：
  user message 1: tool_result(tool_use_id="t1")
  user message 2: tool_result(tool_use_id="t2")
                  tool_result(tool_use_id="t3")
  user message 3: tool_result(tool_use_id="t4")

分组后：
  toolMessages = [["t1"], ["t2", "t3"], ["t4"]]

分组的作用：
  1. API 要求 cache_edits 与消息位置对应
  2. 可以按消息粒度管理 cache_edits
  3. 便于追踪哪些工具属于同一个 user message
  4. 后续处理时可以批量操作同一消息中的多个工具
```

**注册流程示例**：

```
消息处理顺序：
  assistant: tool_use(id="t1", name="Read")
  assistant: tool_use(id="t2", name="Grep")
  user: tool_result(tool_use_id="t1", content="...")     ← 第一个 user 消息
  assistant: tool_use(id="t3", name="Read")
  assistant: tool_use(id="t4", name="Edit")
  user: tool_result(tool_use_id="t2", content="...")
       tool_result(tool_use_id="t3", content="...")      ← 第二个 user 消息
  user: tool_result(tool_use_id="t4", content="...")     ← 第三个 user 消息

注册结果：
  toolOrder = ["t1", "t2", "t3", "t4"]
  registeredTools = Set(["t1", "t2", "t3", "t4"])
  toolMessages = [["t1"], ["t2", "t3"], ["t4"]]
```

#### 步骤 3：计算需要删除的工具 ID

```typescript
const toolsToDelete = mod.getToolResultsToDelete(state)
```

**计算逻辑**（基于 GrowthBook 配置）：
```typescript
function getToolResultsToDelete(state: CachedMCState): string[] {
  const config = getCachedMCConfig()
  
  // triggerThreshold: 触发阈值，工具数量超过此值才触发
  if (state.toolOrder.length <= config.triggerThreshold) {
    return []
  }
  
  // keepRecent: 保留最近 N 个
  const keepCount = config.keepRecent
  const deleteCount = state.toolOrder.length - keepCount
  
  // 返回需要删除的工具 ID（最早的那些）
  return state.toolOrder.slice(0, deleteCount)
    .filter(id => !state.deletedRefs.has(id))  // 排除已删除的
}
```

**配置示例**：
```typescript
// GrowthBook 配置
{
  triggerThreshold: 10,  // 超过 10 个工具结果时触发
  keepRecent: 5,         // 保留最近 5 个
}

// 状态
state.toolOrder = ["t1", "t2", "t3", ..., "t12"]  // 12 个工具

// 计算结果
toolsToDelete = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]  // 删除前 7 个
// 保留 ["t8", "t9", "t10", "t11", "t12"]
```

#### 步骤 4：创建 cache_edits 块

```typescript
if (toolsToDelete.length > 0) {
  // 创建 cache_edits 块
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  
  // 放入待处理队列（API 层会消费）
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits
  }
}
```

**cache_edits 块的结构**：
```typescript
interface CacheEditsBlock {
  type: 'cache_edits'
  edits: CacheEdit[]
}

interface CacheEdit {
  type: 'delete'
  // 要删除的 tool_result 的 tool_use_id
  tool_use_id: string
}
```

**创建逻辑**：
```typescript
function createCacheEditsBlock(
  state: CachedMCState,
  toolsToDelete: string[]
): CacheEditsBlock | null {
  if (toolsToDelete.length === 0) return null
  
  const edits: CacheEdit[] = toolsToDelete.map(toolId => ({
    type: 'delete' as const,
    tool_use_id: toolId,
  }))
  
  // 标记为已删除
  for (const id of toolsToDelete) {
    state.deletedRefs.add(id)
  }
  
  return { type: 'cache_edits', edits }
}
```

#### 步骤 5：返回结果（消息不变）

```typescript
// 获取基线 cache_deleted_input_tokens（用于计算 delta）
const lastAsst = messages.findLast(m => m.type === 'assistant')
const baseline = lastAsst?.message.usage?.cache_deleted_input_tokens ?? 0

return {
  messages,  // 原始消息不变！
  compactionInfo: {
    pendingCacheEdits: {
      trigger: 'auto',
      deletedToolIds: toolsToDelete,
      baselineCacheDeletedTokens: baseline,
    },
  },
}
```

**为什么消息不变？**

```
关键区别：
  时间基础微压缩：直接修改消息内容 → 缓存失效
  缓存微压缩：消息内容不变 → 缓存前缀保持有效

工作原理：
  1. 本地消息保持原样，包含所有工具结果
  2. cache_edits 块在 API 层添加到请求中
  3. 服务器收到请求后，根据 cache_edits 删除对应的缓存条目
  4. 服务器返回的响应中不包含已删除的工具结果

效果：
  - 客户端状态简单，不需要同步删除状态
  - 缓存前缀仍然有效，后续请求可以继续利用
  - 如果 API 调用失败，本地消息仍然完整
```

**baseline 的作用**：

```
cache_deleted_input_tokens 是累积值：
  - API 返回的是从对话开始到现在的总删除量
  - 不是本次请求删除的量

计算本次删除量的方法：
  本次删除量 = 响应中的 cache_deleted_input_tokens - baseline

示例：
  请求前: baseline = 1000 (之前已删除的 token)
  请求后: 响应显示 cache_deleted_input_tokens = 3500
  本次删除: 3500 - 1000 = 2500 tokens

用途：
  - 统计本次压缩节省的 token 数
  - 用于分析和日志记录
  - 帮助用户了解压缩效果
```

### API 层消费流程

```
API 请求构建时:
    │
    ├─► consumePendingCacheEdits() 获取待处理的 cache_edits
    │
    ├─► 将 cache_edits 块插入到请求体中
    │
    └─► 发送请求到 Anthropic API

API 响应后:
    │
    ├─► 从响应中获取实际删除的 token 数
    │
    ├─► 计算 delta = response.usage.cache_deleted_input_tokens - baseline
    │
    └─► pinCacheEdits() 固定编辑，后续请求需重新发送
```

### 后置处理

```typescript
// 1. 记录调试日志
logForDebugging(
  `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`
)

// 2. 记录分析事件
logEvent('tengu_cached_microcompact', {
  toolsDeleted: toolsToDelete.length,
  deletedToolIds: toolsToDelete.join(','),
  activeToolCount: state.toolOrder.length - state.deletedRefs.size,
  triggerType: 'auto',
  threshold: config.triggerThreshold,
  keepRecent: config.keepRecent,
})

// 3. 抑制压缩警告
suppressCompactWarning()

// 4. 通知缓存删除检测器
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  notifyCacheDeletion(querySource ?? 'repl_main_thread')
}
```

**为什么需要 notifyCacheDeletion？**

```
缓存删除检测器的作用：
  监控 API 响应中的 cache_read_input_tokens
  如果这个值突然下降，可能意味着缓存被破坏（prompt 内容变化导致缓存失效）

问题：
  cache_edits 会导致 cache_read_input_tokens 下降
  这是正常行为，不是缓存被破坏

解决方案：
  在执行 cache_edits 前，先调用 notifyCacheDeletion()
  告诉检测器"预期会有下降，不要误报"

工作流程：
  1. notifyCacheDeletion(querySource) 记录预期删除
  2. API 响应返回，cache_read_input_tokens 下降
  3. 检测器检查：是否有预期删除？
  4. 有 → 正常，不报警
  5. 无 → 缓存可能被破坏，记录警告
```

### 完整流程图

```
cachedMicrocompactPath(messages, querySource)
    │
    ├─► 条件检查
    │       ├─► feature('CACHED_MICROCOMPACT')
    │       ├─► isCachedMicrocompactEnabled()
    │       ├─► isModelSupportedForCacheEditing(model)
    │       └─► isMainThreadSource(querySource)
    │
    ├─► collectCompactableToolIds(messages)
    │
    ├─► 注册工具结果（遍历 user 消息）
    │       ├─► registerToolResult() ──► 添加到 registeredTools 和 toolOrder
    │       └─► registerToolMessage() ──► 添加到 toolMessages
    │
    ├─► getToolResultsToDelete(state)
    │       ├─► 检查 toolOrder.length > triggerThreshold
    │       ├─► 计算删除数量 = length - keepRecent
    │       └─► 返回最早的 N 个工具 ID
    │
    ├─► createCacheEditsBlock(state, toolsToDelete)
    │       ├─► 生成 delete 类型的 edits
    │       └─► 标记到 deletedRefs
    │
    ├─► pendingCacheEdits = cacheEdits
    │
    └─► return { messages, compactionInfo }
              └─► API 层消费 pendingCacheEdits
```

## 关键设计要点

### 1. 优先级顺序

```
时间基础微压缩 > 缓存微压缩 > 不压缩
```

原因：时间基础压缩意味着缓存已过期，此时必须先处理。

### 2. 缓存保护

- 时间基础压缩后会重置缓存状态，因为消息修改会使缓存失效
- 缓存微压缩不修改消息内容，通过 API 层的 `cache_edits` 实现

### 3. 主线程限制

```typescript
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}
```

只为 `repl_main_thread` 源执行，防止子 agent（如 session_memory、prompt_suggestion）干扰全局状态。

### 4. 最小保留

```typescript
const keepRecent = Math.max(1, config.keepRecent)
```

至少保留 1 个工具结果，避免清空所有上下文，保留模型的工作上下文。

### 5. 增量删除机制

```typescript
// 已删除的工具记录在 deletedRefs，避免重复删除
return state.toolOrder
  .slice(0, deleteCount)
  .filter(id => !state.deletedRefs.has(id))  // 排除已删除的
```

**为什么需要增量删除？**

```
时间线示例：

T1: 工具数量 = 12，触发删除
    toolOrder = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"]
    删除前 7 个: toolsToDelete = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]
    deletedRefs = Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])

T2: 工具数量 = 14，再次触发删除
    toolOrder = ["t1", ..., "t12", "t13", "t14"]
    删除候选 = 前 9 个 (14 - 5)
    但 t1-t7 已在 deletedRefs 中
    实际删除 = ["t8", "t9"]  (跳过 t1-t7)

关键点：
  - cache_edit 是幂等操作，重复删除同一个工具会导致错误
  - deletedRefs 确保每个工具只被删除一次
  - 跨多次请求追踪删除状态
```

### 6. 与 API 层的协作

```
缓存微压缩不是独立完成的，需要与 API 层协作：

┌─────────────────────────────────────────────────────────────┐
│                     microcompactMessages                     │
│                                                              │
│  1. 计算 toolsToDelete                                       │
│  2. 创建 cache_edits 块                                      │
│  3. pendingCacheEdits = cacheEdits                          │
│  4. 返回 { messages, compactionInfo }                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                        API 层                                │
│                                                              │
│  1. consumePendingCacheEdits() 获取 edits                   │
│  2. 将 cache_edits 添加到请求体                              │
│  3. 发送请求到 Anthropic API                                 │
│  4. 接收响应，获取 cache_deleted_input_tokens               │
│  5. 计算 delta = 响应值 - baseline                          │
│  6. pinCacheEdits() 固定编辑                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 完整状态流转示例

```
场景：用户连续交互，触发多次缓存微压缩

=== T1: 用户第一次交互 ===

操作:
  - Read file.ts → tool_use_id = "t1"
  - Grep "pattern" → tool_use_id = "t2"
  - Read another.ts → tool_use_id = "t3"

状态:
  toolOrder = ["t1", "t2", "t3"]
  registeredTools = Set(["t1", "t2", "t3"])
  deletedRefs = Set()

判断: 3 < 10 (triggerThreshold)，不触发删除

=== T2: 用户继续交互（累积到 12 个工具）===

操作:
  - ... (新增 9 个工具)
  - toolOrder = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"]

判断: 12 > 10，触发删除

计算:
  deleteCount = 12 - 5 = 7
  toolsToDelete = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]

状态变化:
  deletedRefs = Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])
  pendingCacheEdits = {
    type: 'cache_edits',
    edits: [
      { type: 'delete', tool_use_id: 't1' },
      { type: 'delete', tool_use_id: 't2' },
      ...
    ]
  }

API 层:
  - consumePendingCacheEdits() 获取 edits
  - pendingCacheEdits = null
  - 发送请求，响应 cache_deleted_input_tokens = 5000

=== T3: 用户继续交互（新增 2 个工具）===

操作:
  - Read new.ts → tool_use_id = "t13"
  - Edit file.ts → tool_use_id = "t14"

状态:
  toolOrder = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13", "t14"]
  registeredTools = Set(["t1", ..., "t14"])
  deletedRefs = Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])

判断: 14 > 10，触发删除

计算:
  deleteCount = 14 - 5 = 9
  候选 = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]
  过滤已删除: toolsToDelete = ["t8", "t9"]  (t1-t7 已在 deletedRefs)

状态变化:
  deletedRefs = Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"])
  pendingCacheEdits = {
    type: 'cache_edits',
    edits: [
      { type: 'delete', tool_use_id: 't8' },
      { type: 'delete', tool_use_id: 't9' }
    ]
  }

关键点：
  - 增量删除，只删除新的工具
  - 已删除的工具不会重复删除
  - 状态持续累积，直到 resetMicrocompactState() 被调用
```

## 相关导出函数

| 函数名 | 用途 |
|--------|------|
| `consumePendingCacheEdits()` | 获取并清除待处理的缓存编辑 |
| `getPinnedCacheEdits()` | 获取已固定的缓存编辑（需重新发送） |
| `pinCacheEdits()` | 固定新的 cache_edits 到特定位置 |
| `markToolsSentToAPIState()` | 标记工具已发送到 API |
| `resetMicrocompactState()` | 重置微压缩状态 |
| `estimateMessageTokens()` | 估算消息 token 数量 |
| `suppressCompactWarning()` | 抑制压缩警告 |
| `clearCompactWarningSuppression()` | 清除压缩警告抑制 |

## 源码位置

`origin/src/services/compact/microCompact.ts`