import { getGlobalConfig, saveGlobalConfig } from '../config.js'

const SKILL_USAGE_DEBOUNCE_MS = 60_000

/**
 * 中文：技能使用次数持久化到全局配置，供建议排序；本文件负责防抖与「频次 × 时间衰减」打分。
 */

// Process-lifetime debounce cache — avoids lock + read + parse on debounced
// calls. Same pattern as lastConfigStatTime / globalConfigWriteCount in config.ts.
const lastWriteBySkill = new Map<string, number>()

/**
 * Records a skill usage for ranking purposes.
 * Updates both usage count and last used timestamp.
 *
 * 中文：同一技能在短时间窗口内多次调用会合并为一次落盘，减少配置文件锁与 I/O。
 */
export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const lastWrite = lastWriteBySkill.get(skillName)
  // The ranking algorithm uses a 7-day half-life, so sub-minute granularity
  // is irrelevant. Bail out before saveGlobalConfig to avoid lock + file I/O.
  if (lastWrite !== undefined && now - lastWrite < SKILL_USAGE_DEBOUNCE_MS) {
    return
  }
  lastWriteBySkill.set(skillName, now)
  saveGlobalConfig(current => {
    const existing = current.skillUsage?.[skillName]
    return {
      ...current,
      skillUsage: {
        ...current.skillUsage,
        [skillName]: {
          usageCount: (existing?.usageCount ?? 0) + 1,
          lastUsedAt: now,
        },
      },
    }
  })
}

/**
 * Calculates a usage score for a skill based on frequency and recency.
 * Higher scores indicate more frequently and recently used skills.
 *
 * The score uses exponential decay with a half-life of 7 days,
 * meaning usage from 7 days ago is worth half as much as usage today.
 *
 * 中文：7 天半衰指数衰减；久远用法仍保留最低 10% 权重，避免「曾经常用」被完全遗忘。
 */
export function getSkillUsageScore(skillName: string): number {
  const config = getGlobalConfig()
  const usage = config.skillUsage?.[skillName]
  if (!usage) return 0

  // Recency decay: halve score every 7 days
  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24)
  const recencyFactor = Math.pow(0.5, daysSinceUse / 7)

  // Minimum recency factor of 0.1 to avoid completely dropping old but heavily used skills
  return usage.usageCount * Math.max(recencyFactor, 0.1)
}
