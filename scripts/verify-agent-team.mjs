#!/usr/bin/env node
// Reports whether the official Agent Teams layer is loadable in the current
// profile and which tool rows the profile ends up with. Run it anywhere the
// `dsh` CLI and the profile are available:
//
//   npm run verify:agent-team
//
// Exit code 0 means the profile configuration is consistent; 1 means the flag
// and the installed packages disagree.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const PROFILE = process.env.DSH_TEAM_PROFILE?.trim() || 'team-bots'
const TEAM_PACKAGE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PACKAGE_FILE = join(PROFILE_DIR, 'package.json')

const ok = message => console.log(`  ok    ${message}`)
const warn = message => console.log(`  warn  ${message}`)
const bad = message => console.log(`  FAIL  ${message}`)

function readProfile() {
  if (!existsSync(PACKAGE_FILE)) {
    bad(`profile package.json not found: ${PACKAGE_FILE}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'))
  } catch (error) {
    bad(`profile package.json is not valid JSON: ${error.message}`)
    return null
  }
}

function dumpConfig() {
  try {
    return execFileSync('dsh', ['--profile', PROFILE, '--dump-config'], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    bad(`dsh --dump-config failed: ${error.message}`)
    return ''
  }
}

// Rows of interest: the base tool layers, the subagent controls the Team layer
// replaces, and the Team rows themselves.
const ROWS = [
  'tool-bash',
  'tool-fs',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'agent-team',
  'tool-agent-team',
  'ui-agent-team',
]

function rowStates(config, id) {
  const lines = config.split('\n')
  const counts = { enabled: 0, disabled: 0 }
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^\\s*-?\\s*id:\\s*${id}\\s*$`).test(lines[index])) continue
    let state = 'enabled'
    for (let cursor = index + 1; cursor < Math.min(index + 6, lines.length); cursor += 1) {
      if (/^\s*-?\s*id:/.test(lines[cursor])) break
      // `disabled: !!js <expr>` is conditional, so it still counts as enabled here.
      if (/disabled:\s*true\s*$/.test(lines[cursor])) state = 'disabled'
    }
    counts[state] += 1
  }
  if (counts.enabled === 0 && counts.disabled === 0) return 'absent'
  if (counts.enabled === 0) return `disabled (${counts.disabled} rows)`
  if (counts.disabled === 0) return `enabled (${counts.enabled} rows)`
  return `mixed (enabled ${counts.enabled}, disabled ${counts.disabled})`
}

// Preset rows decide what a session actually sees: `- id: preset-x` with `config.id: x`.
function listPresets(config) {
  const ids = []
  const lines = config.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-?\s*id:\s*preset-/.test(lines[index])) continue
    let nameLine = lines[index + 1] ?? ''
    if (!/@deepseek-ai\/dsh-agent-preset/.test(nameLine)) continue
    for (let cursor = index + 2; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = /^\s+id:\s*(\S+)\s*$/.exec(lines[cursor])
      if (match) {
        ids.push(match[1])
        break
      }
    }
  }
  return ids
}

console.log(`dsh-team: Agent Teams check — profile ${PROFILE}, home ${DSH_HOME}`)

const profile = readProfile()
if (!profile) process.exit(1)

const bundles = profile?.dsh?.profile?.bundles ?? []
const teamInBundles = bundles.includes(TEAM_PACKAGE)
const flag = process.env.DSH_TEAM_AGENT_TEAM
console.log(`\nbundles (${bundles.length}):`)
for (const bundle of bundles) console.log(`  - ${bundle}`)

console.log('\nswitch:')
console.log(`  env DSH_TEAM_AGENT_TEAM=${flag ?? '(unset)'}`)
let consistent = true
if (flag === undefined) {
  warn('env not set — the profile keeps whatever state it already has')
} else if ((flag === '1') === teamInBundles) {
  ok('env flag and profile bundles agree')
} else {
  bad('env flag and profile bundles disagree — restart the container so the entrypoint resyncs them')
  consistent = false
}

console.log('\ntool rows (from dsh --dump-config):')
const config = dumpConfig()
if (config) {
  for (const id of ROWS) console.log(`  ${id}: ${rowStates(config, id)}`)
  const presets = listPresets(config)
  console.log(`\nagent presets: ${presets.length === 0 ? '(none parsed)' : presets.join(', ')}`)
  if (presets.length > 0) {
    console.log('  point DSH_TEAM_ROUTER_PRESET / DSH_TEAM_WORKER_PRESET at one of these to give')
    console.log('  Router and Worker sessions different tool surfaces.')
  }
}

console.log('\nexpected state:')
console.log(`  agent-team / tool-agent-team / ui-agent-team: ${teamInBundles ? 'present' : 'absent'}`)
console.log('  tool-subagent / tool-subagent-fork / tool-subagent-control: disabled when the Team layer is on')

console.log('\nremaining manual probes:')
console.log('  1. Router tool surface — if no restricted preset is configured, ask a project group bot')
console.log('     to run `pwd`. A write to the workspace is caught by the read-only write audit instead.')
console.log('  2. Child usage — let a task session spawn one teammate, then check:')
console.log('     SELECT run_id, bot_id, SUM(input_tokens+output_tokens) FROM usage_events')
console.log('     WHERE run_id = (SELECT id FROM runs ORDER BY queued_at DESC LIMIT 1) GROUP BY run_id, bot_id;')
console.log('     The teammate turn must be attributed to the same run_id.')

process.exit(consistent ? 0 : 1)
