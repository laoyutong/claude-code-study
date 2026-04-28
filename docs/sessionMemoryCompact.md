# Session Memory Compact 实现逻辑

## 概述

Session Memory Compact 是一种**实验性对话压缩机制**，用已有的 Session Memory 替代传统 API 摘要压缩。不消耗 API 额度，纯本地操作。

```
传统压缩:  对话消息 → Claude API → 生成摘要 → 替换原消息
SM 压缩:   对话消息 → 读取 Session Memory → 作为摘要 → 保留最近消息
```

## 与其他压缩方式的对比

| 特性 | SM Compact | Microcompact | 传统 Compact |
|------|-----------|-------------|-------------|
| 压缩方式 | 保留最近消息 + SM | 清理工具结果 | API 生成摘要 |
| 需 API | 否 | 否 | 是 |
| 上下文保留 | 完整 SM 摘要 | 占位符 | API 摘要 |
| 触发条件 | `/compact` 或自动压缩 | API 请求前自动 | `/compact` |

---

## 核心流程

```
trySessionMemoryCompaction()
  ├─ 1. 检查 feature flags (tengu_session_memory + tengu_sm_compact)
  ├─ 2. waitForSessionMemoryExtraction() 等待 SM 提取完成
  ├─ 3. 获取 lastSummarizedMessageId 定位压缩边界
  ├─ 4. calculateMessagesToKeepIndex() 计算保留范围
  ├─ 5. createCompactionResultFromSessionMemory() 构建结果
  └─ 6. 返回 CompactionResult 或 null（回退到传统压缩）
```

---

## 配置参数

```typescript
type SessionMemoryCompactConfig = {
  minTokens: number           // 默认 10,000 — 压缩后最少保留
  minTextBlockMessages: number // 默认 5 — 最少文本消息数
  maxTokens: number           // 默认 40,000 — 硬性上限
}
```

配置可从 GrowthBook 远程获取（key: `tengu_sm_compact_config`），只采用正值，否则使用默认值。

---

## 启用条件

两个 feature flag 必须同时开启：`tengu_session_memory` + `tengu_sm_compact`

环境变量覆盖：
- `ENABLE_CLAUDE_CODE_SM_COMPACT` — 强制启用
- `DISABLE_CLAUDE_CODE_SM_COMPACT` — 强制禁用

---

## 消息保留算法

### calculateMessagesToKeepIndex

决定压缩后**保留哪些消息**，返回一个起始索引，该索引之后的所有消息都会被保留。

```
从 lastSummarizedIndex + 1 开始
  ├─ 够用？→ 直接返回
  └─ 不够 → 向前扩展，多吃几条，直到满足下限或碰到上一个 CompactBoundaryMessage
```

**步骤详解**：

1. **起始位置**：`lastSummarizedIndex + 1`（上次压缩后的下一条消息），索引位置之前的消息全部丢弃，由 SM 摘要覆盖。
2. **向后扫描**：从起始位置到末尾，累加 token 数和含文本块的消息数。
3. **上限判断**：若累加 token 已达 `maxTokens`（40K），直接返回，不再往前扩展——已经够多了，再多反而浪费上下文。
4. **下限判断**：若已满足 `minTokens`（10K）且 `minTextBlockMessages`（5 条），返回当前索引——当前片段已经能支撑接下来的对话。
5. **向前扩展**：不满足下限时，从起始位置向上一个 `CompactBoundaryMessage`（压缩边界标记）之间，逐条向前纳入更多消息，直到满足下限。
6. **不变式修复**：最后调用 `adjustIndexToPreserveAPIInvariants` 微调索引，确保不拆散 tool 配对和 thinking 块。

简单说：**从上次压缩点之后开始，保留尽可能少但又不低于下限的消息，不够就往前多吃几条。**

### 文本消息判定

assistant 消息包含 `type: 'text'` 的 content block，或 user 消息的 content 字符串/block 中有 text 类型。

---

## API 不变式保护

压缩可能破坏两项 API 约束，`adjustIndexToPreserveAPIInvariants` 负责修复：

### Tool 配对保护

**问题**：保留 `tool_result` 但丢弃对应的 `tool_use`，API 报 orphan tool_result 错误。

**修复**：扫描保留范围内所有 `tool_result` ID，向前查找缺失的 `tool_use` ID，扩展 startIndex 包含它们。

### Thinking 块合并保护

**问题**：同一 `message.id` 下，thinking 块和 tool_use 块被分割到压缩边界两侧，`normalizeMessagesForAPI` 无法合并。

**修复**：若保留范围包含同一 message.id 的部分 content blocks，向前扩展到包含全部相关块。

### 示例

```
压缩前:
  [N]   assistant id:X [thinking]
  [N+1] assistant id:X [tool_use: A]
  [N+2] assistant id:X [tool_use: B]
  [N+3] user           [tool_result: A, tool_result: B]

startIndex = N+2 → 错误: A 的 tool_use 被丢弃
→ 修复: startIndex = N+1，同时 thinking 修复 → startIndex = N
```

---

## 压缩结果构建

`createCompactionResultFromSessionMemory` 把 SM 内容做成摘要消息、打好边界标记、附上要保留的消息片段，组装成 `CompactionResult` 返回。

```
createCompactionResultFromSessionMemory()
  ├─ 1. 提取压缩前 token 数 (tokenCountFromLastAPIResponse)
  ├─ 2. 创建 CompactBoundaryMessage 边界标记 (同时记录 preCompactDiscoveredTools)
  ├─ 3. 截断 SM 段落 (truncateSessionMemoryForCompact) — 防止 SM 过长吃掉全部 token 预算
  ├─ 4. 生成摘要 user 消息 (isCompactSummary + isVisibleInTranscriptOnly)
  ├─ 5. 若截断 → 追加 "完整 SM 见 <路径>" 提示
  ├─ 6. 附加 Plan (若 agent 存在 Plan)
  └─ 7. 组装 CompactionResult 返回
```

**关键细节**：

- **preCompactTokenCount**：从上次 API 响应的 `usage` 字段取，不是估算值。
- **preCompactDiscoveredTools**：从压缩前的消息中提取已发现的工具名称，写入边界标记，供后续恢复使用。
- **truncateSessionMemoryForCompact**：SM 某些段落（如 transcript 摘要）可能非常长，不截断会挤占压缩后的全部上下文空间。
- **摘要消息标记**：`isCompactSummary: true` 标识这是压缩摘要；`isVisibleInTranscriptOnly: true` 表示只在 transcript 文件中展示，不拼入 API 请求。
- **token 估算一致**：`postCompactTokenCount` 和 `truePostCompactTokenCount` 值相同——SM 压缩没调 API，不存在真实值与估算值的差异。

---

## 压缩前后上下文对比

### 压缩前

```
[系统消息 / claude.md 等]
[历史消息 m1]
[历史消息 m2]
...
[CompactBoundaryMessage (上次压缩的边界标记)]  ← lastSummarizedIndex
[近期消息 m_k]
[近期消息 m_k+1]
...
[当前消息 m_n]                                 ← lastSummarizedMessageId (若安全)
```

所有消息按顺序排列，`lastSummarizedIndex` 标记了上一次压缩发生的位置，之前的消息都已在上次压缩时"覆盖"过。

### 压缩后

`buildPostCompactMessages` 按固定顺序拼装：

```
[系统消息 / claude.md 等]                       ← 不变，持续存在
[CompactBoundaryMessage (本次压缩边界标记)]       ← 类型 system/subtype compact_boundary
  compactMetadata:
    trigger: 'auto' | 'manual'
    preTokens: 压缩前 token 数
    preCompactDiscoveredTools: ['ToolA', 'ToolB', ...]
    preservedSegment:                           ← annotateBoundaryWithPreservedSegment 写入
      headUuid: 保留片段第一条消息的 uuid
      anchorUuid: 摘要消息的 uuid
      tailUuid: 保留片段最后一条消息的 uuid
[SM 摘要消息 (user 消息)]                        ← isCompactSummary + isVisibleInTranscriptOnly
  内容: "This session is being continued from a previous conversation..."
  + SM 截断后的内容
  + "Recent messages are preserved verbatim."
[消息 m_start ... m_n]                          ← messagesToKeep（保留的近期消息）
[Plan 附件]                                     ← 如果 agent 有 Plan
[Hook 结果消息]                                  ← session start hooks 的输出
```

### 关键变化

| 维度 | 压缩前 | 压缩后 |
|------|--------|--------|
| 旧历史消息 | 完整保留在上下文中 | **全部丢弃**，由 SM 摘要替代 |
| SM 摘要 | 不在上下文中 | 作为 user 消息插入，标记 `isVisibleInTranscriptOnly` |
| 边界标记 | 上一次的标记（如有） | 新的 `compact_boundary` system 消息 |
| 近期消息 | 普通排列 | 原样保留，片段的头尾 uuid 写入边界标记的 `preservedSegment` |
| Plan / Hooks | 可能分散在各处 | 统一挂在最后 |
| 对 API 可见 | 全部可见 | SM 摘要消息 `isVisibleInTranscriptOnly`，不拼入 API 请求体 |

**核心效果**：压缩前的旧消息被一条 SM 摘要替代，上下文窗口大幅缩减；近期消息原样保留，模型能直接引用；边界标记记录片段的 uuid 供 loader 恢复消息链。

### Transcript 中的呈现

压缩后的 transcript 文件中，旧消息被移除，user 看到的是：

```
# Summary of the conversation so far
The conversation is continued from a previous session...

[SM 内容：Current State / Task specification / Files and Functions / ...]

If you need specific details from before compaction, read the full transcript at: <路径>
Recent messages are preserved verbatim.

--- 以下为保留的近期消息 ---
user: ...
assistant: ...
```

---

## /compact 命令执行优先级

```
/compact
  ├─ 1. Session Memory Compact (优先)
  │     └─ 成功 → 清理缓存 + postCompactCleanup → 返回
  │     └─ 失败 → 继续
  ├─ 2. Reactive Compact (reactive-only 模式时)
  └─ 3. 传统 Compact (回退)
        ├─ microcompactMessages() 清理工具结果
        └─ compactConversation() 调用 API 生成摘要
```

注意：`customInstructions` 参数仅在传统压缩中生效，SM Compact 忽略它。

---

## Session Memory 生成机制

Session Memory 是压缩的数据源——先理解它怎么生成，才能理解压缩为什么能复用它。

### 更新时机

SM 通过 **post-sampling hook** 触发提取：每次 assistant 生成回复后，hook 检查是否需要更新 SM。

```
post-sampling hook 触发
  ├─ 非主线程 (querySource != 'repl_main_thread') → 跳过
  ├─ feature flag (tengu_session_memory) 未开启 → 跳过
  ├─ auto-compact 未开启 → 跳过（SM 服务于压缩，压缩关了就没意义）
  └─ shouldExtractMemory() 判断是否触发
```

**shouldExtractMemory 判断逻辑**：

```
首次提取:
  会话 token 总量 >= minimumMessageTokensToInit (默认 10,000)
  → 标记初始化完成，触发

后续提取:
  token 增长 >= minimumTokensBetweenUpdate (默认 5,000)  ← 硬条件，必须满足
    AND (
      工具调用次数 >= toolCallsBetweenUpdates (默认 3)   ← 阈值路径
      OR 上一轮 assistant 无工具调用                         ← 自然断点路径
    )
```

**关键约束**：
- token 增长阈值是**硬条件**，无论工具调了多少次，token 不涨够就不提取
- 自然断点路径确保即使在对话停顿、工具调用不够时也能及时更新
- `lastSummarizedMessageId` 只在上一轮无工具调用时更新——避免标记在有孤儿 tool_result 的位置
- 除自动触发外，`/summary` 命令可绕过阈值手动触发提取

### 生成逻辑

触发后，`extractSessionMemory` 启动一个 forked 子 agent 来更新 SM 文件：

```
extractSessionMemory()
  ├─ 1. markExtractionStarted() — 设置提取标记（供 waitForSessionMemoryExtraction 轮询）
  ├─ 2. setupSessionMemoryFile()
  │     ├─ 创建 ~/.claude/projects/<project>/memory/ 目录
  │     ├─ 文件不存在 → 写入模板（DEFAULT_SESSION_MEMORY_TEMPLATE）
  │     └─ 文件已存在 → 读取当前内容
  ├─ 3. buildSessionMemoryUpdatePrompt() — 组装更新 prompt
  │     ├─ 注入当前 SM 内容 + 文件路径
  │     ├─ analyzeSectionSizes() 粗估各 section 的 token 数
  │     └─ 超限 → 追加节流提醒
  ├─ 4. runForkedAgent() — 启动子 agent
  │     ├─ canUseTool: 只允许 Edit，且只能编辑 SM 文件路径
  │     └─ 子 agent 并行 Edit 各 section → 完成
  ├─ 5. recordExtractionTokenCount() — 记录提取时的 token 数（供下次阈值比较）
  ├─ 6. updateLastSummarizedMessageIdIfSafe() — 安全更新压缩边界
  └─ 7. markExtractionCompleted() — 清除提取标记
```

**模板结构**：SM 文件包含 9 个预设 section，每个 section 有固定的 header 和 _斜体描述行_（模板指令），子 agent 只能编辑描述行下方的实际内容，禁止改 header 和描述行：

| Section | 内容 |
|---------|------|
| Session Title | 5-10 词描述性标题 |
| Current State | 当前正在进行的工作、待办事项、下一步 |
| Task specification | 用户需求、设计决策、背景说明 |
| Files and Functions | 重要文件路径及其作用 |
| Workflow | 常用命令及运行顺序 |
| Errors & Corrections | 遇到的错误、修复方式、被否定的方案 |
| Codebase and System Documentation | 系统组件及相互关系 |
| Learnings | 经验教训、有效/无效的做法、应避免的事项 |
| Key results | 给用户生成的精确输出结果 |
| Worklog | 步骤级操作记录 |

**子 agent 的更新约束**：
- 只更新有实质变化的部分，无变化则跳过
- 禁止在内容中提及"note-taking"等元信息
- **大小限制**：每 section ≤ 2000 token，总文件 ≤ 12000 token
- 超限时 prompt 末尾追加提醒，优先保 Current State 和 Errors & Corrections 的准确性和详细度

**本质**：SM 内容**是模型生成的**——fork 一个子 Claude agent，把当前对话上下文 + 现有 SM 文件 + 更新指令喂给它，让它编辑更新。但与传统压缩不同：SM 生成是**后台异步、一次生成多次复用**，传统压缩是**每次压缩都同步调 API**。

---

## 分析事件

| 事件名 | 触发时机 |
|--------|----------|
| `tengu_sm_compact_no_session_memory` | SM 文件不存在 |
| `tengu_sm_compact_empty_template` | SM 是空模板 |
| `tengu_sm_compact_summarized_id_not_found` | lastSummarizedMessageId 找不到 |
| `tengu_sm_compact_resumed_session` | 恢复会话场景 |
| `tengu_sm_compact_threshold_exceeded` | 压缩后仍超过自动压缩阈值 |
| `tengu_sm_compact_error` | 压缩过程出错 |

---

## 优势与限制

**优势**：
- 零 API 成本，纯本地操作
- 无网络延迟，更快
- 基于 token/消息数的精确保留策略
- 自动修复 API 不变式（tool 配对、thinking 合并）

**限制**：
- 实验性功能，需 feature flag 启用
- 依赖 SM 文件存在且有内容（新会话首次压缩可能无效）
- 不支持自定义指令
- 恢复会话时 SM 边界可能不精确

---

## 源码位置

- `origin/src/services/compact/sessionMemoryCompact.ts` — 核心实现
- `origin/src/commands/compact/compact.ts` — 压缩命令入口
