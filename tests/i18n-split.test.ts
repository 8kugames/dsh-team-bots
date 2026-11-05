// DSHBOTS-233：i18n 词表按域拆分的结构守门。
// ① 每个切片（含聚合入口）≤800 行，防拆分回涨；② 聚合入口默认导出 = 各域切片键集之并，
// 且 zh/en 键集一致，防「拆了但聚合漏键」或「两语言键集漂移」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import zh from '../ui/i18n/zh.js'
import en from '../ui/i18n/en.js'
import zhCommon from '../ui/i18n/zh/common.js'
import zhNav from '../ui/i18n/zh/nav.js'
import zhChat from '../ui/i18n/zh/chat.js'
import zhTasks from '../ui/i18n/zh/tasks.js'
import zhUsage from '../ui/i18n/zh/usage.js'
import zhSettings from '../ui/i18n/zh/settings.js'
import zhWechat from '../ui/i18n/zh/wechat.js'
import enCommon from '../ui/i18n/en/common.js'
import enNav from '../ui/i18n/en/nav.js'
import enChat from '../ui/i18n/en/chat.js'
import enTasks from '../ui/i18n/en/tasks.js'
import enUsage from '../ui/i18n/en/usage.js'
import enSettings from '../ui/i18n/en/settings.js'
import enWechat from '../ui/i18n/en/wechat.js'

const I18N = join(fileURLToPath(new URL('..', import.meta.url)), 'ui', 'i18n')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

test('ui/i18n 每个切片 ≤800 行（800 行铁律）', () => {
  const files = tsFiles(I18N)
  assert.ok(files.length >= 14, `i18n 切片数量异常：${files.length}`)
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lines <= 800, `${file} ${lines} 行，超过 800 行铁律`)
  }
})

test('聚合入口键集 = 各域切片键集之并，且 zh/en 一致', () => {
  const groups: Array<[string, Record<string, string>, Record<string, string>[]]> = [
    ['zh', zh, [zhCommon, zhNav, zhChat, zhTasks, zhUsage, zhSettings, zhWechat]],
    ['en', en, [enCommon, enNav, enChat, enTasks, enUsage, enSettings, enWechat]],
  ]
  const sets: Record<string, string[]> = {}
  for (const [lang, agg, domains] of groups) {
    const union = new Set<string>()
    for (const dict of domains) {
      for (const key of Object.keys(dict)) {
        assert.ok(!union.has(key), `${lang} 域切片键重叠：${key}`)
        union.add(key)
      }
    }
    const aggKeys = Object.keys(agg)
    assert.deepEqual([...union].sort(), aggKeys.sort(), `${lang} 聚合入口键集与域切片并集不一致`)
    sets[lang] = aggKeys
  }
  assert.deepEqual(sets.zh.sort(), sets.en.sort(), 'zh/en 键集不一致')
  assert.ok(sets.zh.length >= 1000, `字典键数异常偏少：${sets.zh.length}`)
})
