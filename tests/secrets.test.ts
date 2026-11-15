import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  SecretBox,
  enforceSecretKeyFilePermissions,
  isShellIdentifier,
  maskSecrets,
  materializeEnvFile,
  normalizeSecretName,
  secretFingerprint,
  secretKeyFingerprint,
} from '../src/secrets.js'

const shExec = promisify(execFile)

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-secrets-'))
}

// Source the env file exactly like the bot shell does, then print each named
// variable NUL-terminated so values with spaces, quotes or newlines survive.
async function shEnvValues(envFile, names) {
  const prints = names.map(name => `printf '%s\\0' "$${name}"`).join('; ')
  const { stdout } = await shExec('/bin/sh', ['-c', `set -a; . "$1"; ${prints}`, 'sh', envFile], { maxBuffer: 1 << 20 })
  return stdout.split('\0').slice(0, -1)
}

test('normalizeSecretName trims, strips prefixes, maps separators and uppercases', () => {
  assert.equal(normalizeSecretName('  github token '), 'GITHUB_TOKEN')
  assert.equal(normalizeSecretName('$env:DSH_SECRET_API_KEY'), 'API_KEY')
  assert.equal(normalizeSecretName('$DSH_SECRET_TOKEN'), 'TOKEN')
  assert.equal(normalizeSecretName('dsh_secret_db-pass'), 'DB_PASS')
  assert.equal(normalizeSecretName('openai   key'), 'OPENAI_KEY')
  assert.equal(normalizeSecretName('ALREADY_OK'), 'ALREADY_OK')
})

test('normalizeSecretName 把非法字符换成下划线并只产出合法 shell 标识符', () => {
  assert.equal(normalizeSecretName('FOO.BAR'), 'FOO_BAR')
  assert.equal(normalizeSecretName('A=B'), 'A_B')
  assert.equal(normalizeSecretName('X;ECHO_INJECTED'), 'X_ECHO_INJECTED')
  assert.equal(normalizeSecretName('A$(CMD)'), 'A_CMD_')
  assert.equal(normalizeSecretName('a--b'), 'A_B')
  assert.equal(normalizeSecretName('9lives'), '_9LIVES')
  assert.equal(normalizeSecretName('*'), '_')
  for (const raw of ['FOO.BAR', 'A=B', 'X;ECHO_INJECTED', 'A$(CMD)', '9lives', 'a--b', '  a  b  ']) {
    assert.ok(isShellIdentifier(normalizeSecretName(raw)), raw)
  }
})

test('normalizeSecretName 幂等：规范化结果再规范化保持不变', () => {
  for (const raw of ['github token', '$env:DSH_SECRET_API_KEY', 'FOO.BAR', 'A$(CMD)', '9lives', 'a--b']) {
    const once = normalizeSecretName(raw)
    assert.equal(normalizeSecretName(once), once, raw)
  }
})

test('isShellIdentifier 只接受 POSIX shell 标识符', () => {
  assert.equal(isShellIdentifier('GITHUB_TOKEN'), true)
  assert.equal(isShellIdentifier('_9LIVES'), true)
  assert.equal(isShellIdentifier('9LIVES'), false)
  assert.equal(isShellIdentifier('FOO.BAR'), false)
  assert.equal(isShellIdentifier('A-B'), false)
  assert.equal(isShellIdentifier(''), false)
})

test('normalizeSecretName throws when nothing is left', () => {
  assert.throws(() => normalizeSecretName(''), /密钥名称为空/)
  assert.throws(() => normalizeSecretName('   '), /密钥名称为空/)
  assert.throws(() => normalizeSecretName('DSH_SECRET_'), /密钥名称为空/)
  assert.throws(() => normalizeSecretName(null), /密钥名称为空/)
})

test('SecretBox round-trips a value and rejects a foreign key', () => {
  const box = new SecretBox({ keyHex: 'ab'.repeat(32) })
  const sealed = box.encrypt('pässwörd→中文')
  assert.equal(box.decrypt(sealed), 'pässwörd→中文')
  const again = box.encrypt('pässwörd→中文')
  assert.notEqual(again.valueIv, sealed.valueIv)
  assert.equal(box.decrypt(again), 'pässwörd→中文')
  const other = new SecretBox({ keyHex: 'cd'.repeat(32) })
  assert.throws(() => other.decrypt(sealed), /解密失败/)
})

test('SecretBox rejects a tampered tag or ciphertext', () => {
  const box = new SecretBox({ keyHex: 'ab'.repeat(32) })
  const sealed = box.encrypt('value-to-protect')
  assert.throws(() => box.decrypt({ ...sealed, valueTag: Buffer.from('tampered-tag!!').toString('base64') }), /解密失败/)
  const flipped = Buffer.from(sealed.valueEnc, 'base64')
  flipped[0] ^= 1
  assert.throws(() => box.decrypt({ ...sealed, valueEnc: flipped.toString('base64') }), /解密失败/)
  assert.throws(() => new SecretBox({ keyHex: 'abcd' }), /必须是 32 字节/)
  assert.throws(() => new SecretBox({ keyHex: 'zz' }), /必须是 32 字节/)
  assert.throws(() => new SecretBox({}), /必须提供/)
})

test('SecretBox 严格校验密钥十六进制：尾部垃圾不被接受', () => {
  assert.throws(() => new SecretBox({ keyHex: 'ab'.repeat(32) + 'GARBAGE!!' }), /必须是 32 字节/)
  assert.throws(() => new SecretBox({ keyHex: 'ab'.repeat(31) + 'zz' }), /必须是 32 字节/)
  assert.throws(() => new SecretBox({ keyHex: 'ab'.repeat(32) + 'ab' }), /必须是 32 字节/)
  // 十六进制大小写都接受
  const upper = new SecretBox({ keyHex: 'AB'.repeat(32) })
  assert.equal(upper.decrypt(upper.encrypt('upper-case-hex')), 'upper-case-hex')
})

test('SecretBox creates the key file with mode 0600 and reloads the same key', async () => {
  const root = await tempRoot()
  try {
    const keyFile = join(root, 'deep', 'nested', 'team.key')
    const first = new SecretBox({ keyFile })
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
    const second = new SecretBox({ keyFile })
    assert.equal(second.decrypt(first.encrypt('same-key-check')), 'same-key-check')
    await writeFile(join(root, 'bad.key'), 'not-hex', 'utf8')
    assert.throws(() => new SecretBox({ keyFile: join(root, 'bad.key') }), /必须是 32 字节/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SecretBox 读取已有密钥文件前把过宽权限收紧到 0600', async () => {
  const root = await tempRoot()
  try {
    const keyFile = join(root, 'loose.key')
    const seed = new SecretBox({ keyFile })
    const sealed = seed.encrypt('permission-check')
    chmodSync(keyFile, 0o644)
    assert.equal((await stat(keyFile)).mode & 0o777, 0o644)
    const reopened = new SecretBox({ keyFile })
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
    assert.equal(reopened.decrypt(sealed), 'permission-check')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enforceSecretKeyFilePermissions 收不紧时抛错', () => {
  const fake = { stat: () => ({ mode: 0o100644 }), chmod: () => {} }
  assert.throws(() => enforceSecretKeyFilePermissions('/tmp/whatever.key', fake), /密钥文件权限过宽/)
  const noopChmod = { stat: () => ({ mode: 0o100644 }), chmod: () => { throw new Error('EPERM') } }
  assert.throws(() => enforceSecretKeyFilePermissions('/tmp/whatever.key', noopChmod), /密钥文件权限过宽/)
  const safe = { stat: () => ({ mode: 0o100600 }), chmod: () => { throw new Error('不该被调用') } }
  assert.equal(enforceSecretKeyFilePermissions('/tmp/safe.key', safe), undefined)
})

test('SecretBox requireExisting 时缺密钥文件直接报错，不静默生成新密钥', async () => {
  const root = await tempRoot()
  try {
    const keyFile = join(root, 'missing', 'team.key')
    assert.throws(() => new SecretBox({ keyFile, requireExisting: true }), /密钥文件不存在/)
    assert.equal(existsSync(keyFile), false)
    // 默认行为不变：缺文件时仍会生成新密钥
    const created = new SecretBox({ keyFile })
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
    assert.equal(created.decrypt(created.encrypt('fresh')), 'fresh')
    // 文件存在时 requireExisting 走正常的权限校验与读取
    const reopened = new SecretBox({ keyFile, requireExisting: true })
    assert.equal(reopened.decrypt(created.encrypt('same')), 'same')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('secretKeyFingerprint 是密钥字节 sha256 的前 16 位十六进制', () => {
  assert.equal(secretKeyFingerprint('ab'.repeat(32)), '9a2db2e23f1504cd')
  assert.equal(secretKeyFingerprint(Buffer.from('ab'.repeat(32), 'hex')), '9a2db2e23f1504cd')
  assert.equal(secretKeyFingerprint('cd'.repeat(32)), '7969ec0fcb8b648d')
  assert.match(secretKeyFingerprint('ab'.repeat(32)), /^[0-9a-f]{16}$/)
  assert.equal(secretKeyFingerprint('ab'.repeat(32)), secretKeyFingerprint('ab'.repeat(32)))
  assert.notEqual(secretKeyFingerprint('ab'.repeat(32)), secretKeyFingerprint('cd'.repeat(32)))
})

test('materializeEnvFile writes 0600 file in 0700 .team and a 0644 .gitignore', async () => {
  const root = await tempRoot()
  try {
    const path = await materializeEnvFile([{ name: '$env:DSH_SECRET_lower-key', value: 'plain-value' }], root)
    assert.equal(path, join(root, '.team', 'secrets.env'))
    assert.equal((await stat(join(root, '.team'))).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(await readFile(path, 'utf8'), '# managed by dsh-team-bots\nLOWER_KEY=plain-value\n')
    assert.equal((await stat(join(root, '.gitignore'))).mode & 0o777, 0o644)
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '.team/\n')

    await materializeEnvFile([{ name: 'OTHER_KEY', value: 'other-value' }], root)
    assert.equal(await readFile(path, 'utf8'), '# managed by dsh-team-bots\nOTHER_KEY=other-value\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile 写出的变量名一定是合法 shell 标识符', async () => {
  const root = await tempRoot()
  try {
    const path = await materializeEnvFile([
      { name: 'FOO.BAR', value: 'value-one' },
      { name: 'X;ECHO_INJECTED', value: 'value-two' },
      { name: '9lives', value: 'value-three' },
    ], root)
    const contents = await readFile(path, 'utf8')
    assert.equal(contents, '# managed by dsh-team-bots\nFOO_BAR=value-one\nX_ECHO_INJECTED=value-two\n_9LIVES=value-three\n')
    for (const line of contents.trim().split('\n').slice(1)) {
      const name = line.slice(0, line.indexOf('='))
      assert.ok(isShellIdentifier(name), name)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile 先写 .gitignore 再写明文文件：中途失败不留明文', async () => {
  const root = await tempRoot()
  try {
    await assert.rejects(
      () => materializeEnvFile([{ name: '', value: 'value-one' }], root),
      /密钥名称为空/,
    )
    assert.equal(existsSync(join(root, '.gitignore')), true)
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '.team/\n')
    assert.equal(existsSync(join(root, '.team', 'secrets.env')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile writes the comment-only file for empty entries', async () => {
  const root = await tempRoot()
  try {
    const path = await materializeEnvFile([], root)
    assert.equal(await readFile(path, 'utf8'), '# managed by dsh-team-bots\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile values round-trip through POSIX shell source', async (t) => {
  const root = await tempRoot()
  try {
    const entries = [
      { name: 'GITHUB_TOKEN', value: 'ghp_1234567890abcdef' },
      { name: 'DB_URL', value: 'postgres://user:p@ss w0rd@db:5432/app' },
      { name: 'QUOTED', value: "it's a \"tricky\" $HOME #not-a-comment" },
      { name: 'MULTILINE', value: 'line-one\nline-two' },
      { name: 'DANGEROUS', value: `pre;touch ${join(root, 'pwned')} post` },
    ]
    const path = await materializeEnvFile(entries, root)
    if (!existsSync('/bin/sh')) {
      t.skip('环境里没有 /bin/sh，无法用真实 shell 验证取值')
      return
    }
    const values = await shEnvValues(path, entries.map(entry => entry.name))
    for (let i = 0; i < entries.length; i++) assert.equal(values[i], entries[i].value)
    assert.equal(existsSync(join(root, 'pwned')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile 非法变量名不会把注入写进 env 文件', async () => {
  const root = await tempRoot()
  try {
    const path = await materializeEnvFile([
      { name: 'X;ECHO_INJECTED', value: 'v3' },
      { name: 'A$(CMD)', value: 'v4' },
    ], root)
    const contents = await readFile(path, 'utf8')
    assert.equal(contents, '# managed by dsh-team-bots\nX_ECHO_INJECTED=v3\nA_CMD_=v4\n')
    assert.ok(!contents.includes(';'))
    assert.ok(!contents.includes('$('))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile appends .team/ to .gitignore exactly once', async () => {
  const root = await tempRoot()
  try {
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
    await materializeEnvFile([{ name: 'A_KEY', value: 'aaaa-value' }], root)
    await materializeEnvFile([{ name: 'A_KEY', value: 'aaaa-value' }], root)
    const text = await readFile(join(root, '.gitignore'), 'utf8')
    assert.equal(text.match(/^\.team\/$/gm).length, 1)
    assert.ok(text.startsWith('node_modules/\n'))

    const other = join(root, 'ws2')
    await mkdir(other)
    await writeFile(join(other, '.gitignore'), 'x\n.team/\ny\n', 'utf8')
    await materializeEnvFile([], other)
    assert.equal(await readFile(join(other, '.gitignore'), 'utf8'), 'x\n.team/\ny\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureGitignore 认得 .team/、.team、**/.team/ 三种写法且不重复追加', async () => {
  for (const [index, form] of ['.team/', '.team', '**/.team/'].entries()) {
    const root = await tempRoot()
    try {
      const dir = join(root, `ws${index}`)
      await mkdir(dir)
      await writeFile(join(dir, '.gitignore'), `x\n${form}\ny\n`, 'utf8')
      await materializeEnvFile([{ name: 'A_KEY', value: 'aaaa-value' }], dir)
      assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), `x\n${form}\ny\n`, form)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('maskSecrets 用 env 变量名做占位符并跳过短值或空值', () => {
  const entries = [
    { name: 'SHORT_TOKEN', value: 'abcdefgh' },
    { name: 'TINY', value: 'abc' },
    { name: 'LONG_TOKEN', value: 'abcdefgh-123456' },
    { name: 'EMPTY', value: '' },
  ]
  const text = 'prefix abcdefgh-123456 middle abcdefgh suffix abc tail'
  assert.equal(maskSecrets(text, entries), 'prefix $LONG_TOKEN middle $SHORT_TOKEN suffix abc tail')
  assert.equal(maskSecrets('nothing to see', entries), 'nothing to see')
  assert.equal(maskSecrets('token abcdefgh here', [{ name: 'dsh_secret_api key', value: 'abcdefgh' }]), 'token $API_KEY here')
})

test('maskSecrets 的占位符不会被后续替换二次碰撞', () => {
  const entries = [
    { name: 'A_KEY', value: '$B_KEY_VALUE' },
    { name: 'B_KEY', value: 'the-real-secret' },
  ]
  assert.equal(maskSecrets('the-real-secret and $B_KEY_VALUE', entries), '$B_KEY and $A_KEY')
})

test('maskSecrets 的占位符名与 env 文件里的变量名一致', async () => {
  const root = await tempRoot()
  try {
    const entries = [{ name: '$env:DSH_SECRET_lower-key', value: 'ghp_abcdefghijklmnop' }]
    const path = await materializeEnvFile(entries, root)
    const contents = await readFile(path, 'utf8')
    assert.ok(contents.includes('LOWER_KEY='), contents)
    assert.equal(maskSecrets('token ghp_abcdefghijklmnop', entries), 'token $LOWER_KEY')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('secretFingerprint is a stable 8-hex prefix of sha256', () => {
  assert.equal(secretFingerprint('dsh-fingerprint-check'), '07e0ae79')
  assert.equal(secretFingerprint('dsh-fingerprint-check'), secretFingerprint('dsh-fingerprint-check'))
  assert.equal(secretFingerprint('another-secret-value'), 'c6a22635')
  assert.match(secretFingerprint('x'), /^[0-9a-f]{8}$/)
})
