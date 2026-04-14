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

### 条件检查

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

## 相关导出函数

| 函数名 | 用途 |
|--------|------|
| `consumePendingCacheEdits()` | 获取并清除待处理的缓存编辑 |
| `getPinnedCacheEdits()` | 获取已固定的缓存编辑（需重新发送） |
| `pinCacheEdits()` | 固定新的 cache_edits 到特定位置 |
| `markToolsSentToAPIState()` | 标记工具已发送到 API |
| `resetMicrocompactState()` | 重置微压缩状态 |
| `estimateMessageTokens()` | 估算消息 token 数量 |

## 源码位置

`origin/src/services/compact/microCompact.ts`