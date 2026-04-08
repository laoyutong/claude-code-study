import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { constants as fsConstants } from 'fs'
import { mkdir, open } from 'fs/promises'
import { dirname, isAbsolute, join, normalize, sep as pathSep } from 'path'
import type { ToolUseContext } from '../Tool.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { getBundledSkillsRoot } from '../utils/permissions/filesystem.js'
import type { HooksSettings } from '../utils/settings/types.js'

/**
 * Definition for a bundled skill that ships with the CLI.
 * These are registered programmatically at startup.
 *
 * 中文：随 CLI 二进制内置的技能定义，启动时通过 `registerBundledSkill` 注册，不依赖用户磁盘上的 SKILL.md。
 */
export type BundledSkillDefinition = {
  /** 技能唯一标识名（命令名），与 Slash 命令、遥测与解压目录名等关联，应稳定且便于输入。 */
  name: string
  /** 面向模型与 UI 的简短说明，概括该技能做什么；会作为命令描述展示。 */
  description: string
  /** 可选别名列表，用户可用别名以同样方式唤起该技能，行为与主名称一致。 */
  aliases?: string[]
  /**
   * 可选的「何时使用」引导文案，用于向模型说明在什么场景下应优先选用本技能，帮助路由与工具选择。
   */
  whenToUse?: string
  /** 可选参数占位/用法提示（例如期望的命令行参数形状），向用户与模型提示如何调用。 */
  argumentHint?: string
  /**
   * 本技能执行时允许模型使用的工具名白名单（如读文件、执行命令等）；未列出的工具在该技能上下文中不可用。
   */
  allowedTools?: string[]
  /** 可选：仅在本技能会话中使用的模型标识；未设置则沿用全局或默认模型。 */
  model?: string
  /**
   * 若为 true，禁止模型在未经显式用户触发的情况下自动调用本技能（限制自主工具调用）。
   */
  disableModelInvocation?: boolean
  /**
   * 若为 false，技能对用户界面隐藏或不可由用户直接唤起；默认可用户调用。与 `isHidden` 派生一致。
   */
  userInvocable?: boolean
  /** 可选：动态判断是否启用该技能；返回 false 时技能在当前环境不可用（例如特性开关、平台条件）。 */
  isEnabled?: () => boolean
  /** 可选：附随本技能的 Hooks 配置（与项目级 hooks 相同语义，用于生命周期/扩展点）。 */
  hooks?: HooksSettings
  /**
   * 执行上下文：`inline` 在当前会话内串联执行；`fork` 在独立子上下文中运行，隔离主对话状态。
   */
  context?: 'inline' | 'fork'
  /** 可选：指定承接该技能任务的子 agent 或代理配置标识（与多代理编排相关）。 */
  agent?: string
  /**
   * 首次调用时需解压到磁盘的附加参考文件映射。键为相对路径（正斜杠、不含 `..`），值为文件正文。
   * 设置后会在技能提示前插入「本技能基目录」行，便于模型按需 Read/Grep，语义与基于磁盘的技能一致。
   */
  files?: Record<string, string>
  /**
   * 根据用户传入的参数与会话上下文异步生成发给模型的内容块（通常为 system/user 等块序列），是技能的核心载荷逻辑。
   */
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

// Internal registry for bundled skills
// 中文：进程内唯一表；`getBundledSkills` 返回拷贝以防外部误改。
const bundledSkills: Command[] = []

/**
 * Register a bundled skill that will be available to the model.
 * Call this at module initialization or in an init function.
 *
 * Bundled skills are compiled into the CLI binary and available to all users.
 * They follow the same pattern as registerPostSamplingHook() for internal features.
 *
 * 中文：若提供 `files`，首次调用时把参考文件解压到临时根目录，并在提示前加上「本技能基目录」前缀，语义与磁盘技能一致。
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition

  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    // Closure-local memoization: extract once per process.
    // Memoize the promise (not the result) so concurrent callers await
    // the same extraction instead of racing into separate writes.
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0, // Not applicable for bundled skills
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    skillRoot,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled,
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand,
  }
  bundledSkills.push(command)
}

/**
 * Get all registered bundled skills.
 * Returns a copy to prevent external mutation.
 *
 * 中文：获取当前已注册的全部内置技能快照。
 */
export function getBundledSkills(): Command[] {
  return [...bundledSkills]
}

/**
 * Clear bundled skills registry (for testing).
 *
 * 中文：测试用，清空内置技能注册表。
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

/**
 * Deterministic extraction directory for a bundled skill's reference files.
 *
 * 中文：给定技能名，返回其参考文件落盘目录（在 `getBundledSkillsRoot()` 之下，含进程级 nonce 防碰撞）。
 */
export function getBundledSkillExtractDir(skillName: string): string {
  return join(getBundledSkillsRoot(), skillName)
}

/**
 * Extract a bundled skill's reference files to disk so the model can
 * Read/Grep them on demand. Called lazily on first skill invocation.
 *
 * Returns the directory written to, or null if write failed (skill
 * continues to work, just without the base-directory prefix).
 *
 * 中文：解压失败时技能仍可用，只是模型收不到「基目录」提示（无法依赖那些参考文件的确定性路径）。
 */
async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const dir = getBundledSkillExtractDir(skillName)
  try {
    await writeSkillFiles(dir, files)
    return dir
  } catch (e) {
    logForDebugging(
      `Failed to extract bundled skill '${skillName}' to ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

async function writeSkillFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  // Group by parent dir so we mkdir each subtree once, then write.
  const byParent = new Map<string, [string, string][]>()
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolveSkillFilePath(dir, relPath)
    const parent = dirname(target)
    const entry: [string, string] = [target, content]
    const group = byParent.get(parent)
    if (group) group.push(entry)
    else byParent.set(parent, [entry])
  }
  await Promise.all(
    [...byParent].map(async ([parent, entries]) => {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await Promise.all(entries.map(([p, c]) => safeWriteFile(p, c)))
    }),
  )
}

// 中文：nonce 目录 + 严格权限与 O_EXCL 创建，降低预置符号链接/竞态带来的安全风险；不在 EEXIST 时 unlink 重试。
// The per-process nonce in getBundledSkillsRoot() is the primary defense
// against pre-created symlinks/dirs. Explicit 0o700/0o600 modes keep the
// nonce subtree owner-only even on umask=0, so an attacker who learns the
// nonce via inotify on the predictable parent still can't write into it.
// O_NOFOLLOW|O_EXCL is belt-and-suspenders (O_NOFOLLOW only protects the
// final component); we deliberately do NOT unlink+retry on EEXIST — unlink()
// follows intermediate symlinks too.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
// On Windows, use string flags — numeric O_EXCL can produce EINVAL through libuv.
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW

async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Normalize and validate a skill-relative path; throws on traversal.
 *
 * 中文：禁止 `..` 与绝对路径，防止解压路径穿越到技能根之外。
 */
function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath)
  if (
    isAbsolute(normalized) ||
    normalized.split(pathSep).includes('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`bundled skill file path escapes skill dir: ${relPath}`)
  }
  return join(baseDir, normalized)
}

function prependBaseDir(
  blocks: ContentBlockParam[],
  baseDir: string,
): ContentBlockParam[] {
  const prefix = `Base directory for this skill: ${baseDir}\n\n`
  if (blocks.length > 0 && blocks[0]!.type === 'text') {
    return [
      { type: 'text', text: prefix + blocks[0]!.text },
      ...blocks.slice(1),
    ]
  }
  return [{ type: 'text', text: prefix }, ...blocks]
}
