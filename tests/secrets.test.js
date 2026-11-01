import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SecretBox, maskSecrets, materializeEnvFile, normalizeSecretName, secretFingerprint } from '../src/secrets.js'

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

test('materializeEnvFile writes the comment-only file for empty entries', async () => {
  const root = await tempRoot()
  try {
    const path = await materializeEnvFile([], root)
    assert.equal(await readFile(path, 'utf8'), '# managed by dsh-team-bots\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeEnvFile values round-trip through POSIX shell source', async () => {
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
    if (existsSync('/bin/sh')) {
      const values = await shEnvValues(path, entries.map(entry => entry.name))
      for (let i = 0; i < entries.length; i++) assert.equal(values[i], entries[i].value)
      assert.equal(existsSync(join(root, 'pwned')), false)
    } else {
      const contents = await readFile(path, 'utf8')
      for (const { name, value } of entries) assert.ok(contents.includes(`${name}=`), name)
      assert.ok(contents.includes("'line-one\nline-two'"))
    }
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

test('maskSecrets replaces longest values first and skips short or empty ones', () => {
  const entries = [
    { name: 'SHORT_TOKEN', value: 'abcdefgh' },
    { name: 'TINY', value: 'abc' },
    { name: 'LONG_TOKEN', value: 'abcdefgh-123456' },
    { name: 'EMPTY', value: '' },
  ]
  const text = 'prefix abcdefgh-123456 middle abcdefgh suffix abc tail'
  assert.equal(maskSecrets(text, entries), 'prefix $DSH_SECRET_LONG_TOKEN middle $DSH_SECRET_SHORT_TOKEN suffix abc tail')
  assert.equal(maskSecrets('nothing to see', entries), 'nothing to see')
  assert.equal(maskSecrets('token abcdefgh here', [{ name: 'dsh_secret_api key', value: 'abcdefgh' }]), 'token $DSH_SECRET_API_KEY here')
})

test('secretFingerprint is a stable 8-hex prefix of sha256', () => {
  assert.equal(secretFingerprint('dsh-fingerprint-check'), '07e0ae79')
  assert.equal(secretFingerprint('dsh-fingerprint-check'), secretFingerprint('dsh-fingerprint-check'))
  assert.equal(secretFingerprint('another-secret-value'), 'c6a22635')
  assert.match(secretFingerprint('x'), /^[0-9a-f]{8}$/)
})
