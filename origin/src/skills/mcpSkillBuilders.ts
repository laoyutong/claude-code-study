import type {
  createSkillCommand,
  parseSkillFrontmatterFields,
} from './loadSkillsDir.js'

/**
 * Write-once registry for the two loadSkillsDir functions that MCP skill
 * discovery needs. This module is a dependency-graph leaf: it imports nothing
 * but types, so both mcpSkills.ts and loadSkillsDir.ts can depend on it
 * without forming a cycle (client.ts → mcpSkills.ts → loadSkillsDir.ts → …
 * → client.ts).
 *
 * The non-literal dynamic-import approach ("await import(variable)") fails at
 * runtime in Bun-bundled binaries — the specifier is resolved against the
 * chunk's /$bunfs/root/… path, not the original source tree, yielding "Cannot
 * find module './loadSkillsDir.js'". A literal dynamic import works in bunfs
 * but dependency-cruiser tracks it, and because loadSkillsDir transitively
 * reaches almost everything, the single new edge fans out into many new cycle
 * violations in the diff check.
 *
 * Registration happens at loadSkillsDir.ts module init, which is eagerly
 * evaluated at startup via the static import from commands.ts — long before
 * any MCP server connects.
 *
 * 中文：MCP 技能发现只需要 `createSkillCommand` 与 `parseSkillFrontmatterFields`，但二者定义在
 * `loadSkillsDir`（依赖面极大）。本文件只做「只写一次的函数指针注册」且仅 `import type`，成为依赖图里的叶节点，
 * 从而既避免 `client ↔ loadSkillsDir` 循环，又避免 Bun 打包后非常量动态 import 找不到模块的问题。
 * 注册发生在 `loadSkillsDir` 顶层副作用里，早于任意 MCP 连接。
 */

export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

/** 中文：由 `loadSkillsDir` 在启动时写入；仅应调用一次。 */
export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

/** 中文：MCP 侧解析技能时取回已注册的构建函数；若尚未注册则抛错（说明 `loadSkillsDir` 未加载）。 */
export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP skill builders not registered — loadSkillsDir.ts has not been evaluated yet',
    )
  }
  return builders
}
