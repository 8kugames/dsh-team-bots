import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHostRefs } from '../scripts/doctor.mjs'

const homePatch = `# Home-level dsh patch: applied above every profile.
# Skills live at /Users/someone/.agents/skills — comment, must be ignored.
- id: session-log-deepseek
  name: "@deepseek-ai/dsh-session-log-deepseek"
  config:
    enabled: false
- insert:
    - id: mcp-taptap-maker
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: taptap-maker
        transport: stdio
        command: node
        args:
          - /Users/someone/.taptap-maker/mcp-runtime/0.0.39/dist/maker.js
        env:
          TAPTAP_MCP_CLIENT_IDE: dsh
        toolCallTimeoutMs: 3600000
- id: mcp-other
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    command: /opt/tools/serve.js
    args: ["https://example.com/x", "/tmp/one", "/tmp/one"]
`

test('extractHostRefs finds absolute paths in values and list items', () => {
  assert.deepEqual(extractHostRefs(homePatch), [
    '/Users/someone/.taptap-maker/mcp-runtime/0.0.39/dist/maker.js',
    '/opt/tools/serve.js',
    '/tmp/one',
  ])
})

test('extractHostRefs ignores comments, package names, URLs and duplicates', () => {
  const refs = extractHostRefs(homePatch)
  assert.ok(!refs.some(ref => ref.includes('.agents/skills')))
  assert.ok(!refs.some(ref => ref.startsWith('@deepseek-ai')))
  assert.ok(!refs.some(ref => ref.includes('example.com')))
  assert.equal(refs.filter(ref => ref === '/tmp/one').length, 1)
})

test('extractHostRefs keeps order of first appearance and handles empty input', () => {
  assert.deepEqual(extractHostRefs(''), [])
  assert.deepEqual(extractHostRefs('# only comments\nnothing here\n'), [])
})

test('extractHostRefs does not match protocol-relative or single-segment paths', () => {
  const refs = extractHostRefs('see https://example.com//odd and /data but keep /bin/sh')
  assert.deepEqual(refs, ['/bin/sh'])
})
