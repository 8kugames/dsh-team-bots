// DSHBOTS-79：微信扫码绑定报「服务端处理失败」——channel.js 抛裸 Error，http.js 的 errorResponse
// 只认 AppError，非 AppError 一律 500「服务端处理失败」。本文件锁服务边界包装：
// 守卫文案 → 409 原文透传；上游失败 → 502 可读原文 + logger.warn 记原始 stack。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wechatMethods } from '../src/services/wechat.js'
import { WechatIlinkError } from '../src/wechat/commands.js'
import { AppError } from '../src/errors.js'

/** 最小服务桩：wechatMethods 挂在 TeamService 原型上（见 src/service.js），绑定 this 即可驱动。 */
function serviceStub(channel) {
  const warns = []
  return {
    wechat: channel,
    logger: { warn: (...args) => warns.push(args) },
    initialize: async () => {},
    warns,
  }
}

test('wechat 服务边界：channel 抛「未启用」裸 Error → 409 conflict 原文案透传', async () => {
  const service = serviceStub({ async beginLogin() { throw new Error('微信通道未启用（DSH_TEAM_WECHAT=1）') } })
  await assert.rejects(
    () => wechatMethods.wechatBeginLogin.call(service),
    error => {
      assert.ok(error instanceof AppError, '必须是 AppError，否则 errorResponse 会吞成 500「服务端处理失败」')
      assert.equal(error.status, 409)
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.message, '微信通道未启用（DSH_TEAM_WECHAT=1）')
      return true
    },
  )
  assert.equal(service.warns.length, 0, '预期状态冲突不写告警日志')
})

test('wechat 服务边界：已登录再 beginLogin → 409「微信通道已登录…」，验证码守卫同样透传', async () => {
  const service = serviceStub({ async beginLogin() { throw new Error('微信通道已登录，如需换号请先退出') } })
  await assert.rejects(
    () => wechatMethods.wechatBeginLogin.call(service),
    error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 409)
      assert.equal(error.message, '微信通道已登录，如需换号请先退出')
      return true
    },
  )

  // submitCode 的守卫（无授权流程/格式不对）走同一包装：裸 Error → conflict 原文案
  const service2 = serviceStub({ submitVerificationCode() { throw new Error('当前没有等待验证码的授权流程') } })
  assert.throws(
    () => wechatMethods.wechatSubmitCode.call(service2, '123'),
    error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 409)
      assert.equal(error.message, '当前没有等待验证码的授权流程')
      return true
    },
  )
})

test('wechat 服务边界：上游抛裸 Error → 502 且 message 为可读原因，不再是「服务端处理失败」', async () => {
  // vendor 协议错误（WechatIlinkError）：code + 原文进响应
  const service = serviceStub({
    async beginLogin() { throw new WechatIlinkError('NETWORK_ERROR', 'The iLink request failed.', true) },
  })
  await assert.rejects(
    () => wechatMethods.wechatBeginLogin.call(service),
    error => {
      assert.ok(error instanceof AppError, '非 AppError 会被 errorResponse 吞成 500「服务端处理失败」')
      assert.equal(error.status, 502)
      assert.equal(error.code, 'WECHAT_UPSTREAM')
      assert.match(error.message, /微信服务请求失败：NETWORK_ERROR: The iLink request failed\./)
      return true
    },
  )
  assert.equal(service.warns.length, 1, '上游失败要写告警日志')
  assert.ok(String(service.warns[0][2]).includes('Error'), '原始 stack 进 logger.warn（响应不夹带）')

  // 普通裸 Error（如 fetch 抛的）：同样透传可读原因
  const service2 = serviceStub({ async beginLogin() { throw new Error('fetch failed') } })
  await assert.rejects(
    () => wechatMethods.wechatBeginLogin.call(service2),
    error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 502)
      assert.match(error.message, /fetch failed/)
      assert.notEqual(error.message, '服务端处理失败')
      return true
    },
  )

  // logout 也走同一包装，不吞原因
  const service3 = serviceStub({ async logout() { throw new Error('logout upstream boom') } })
  await assert.rejects(
    () => wechatMethods.wechatLogout.call(service3),
    error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 502)
      assert.match(error.message, /logout upstream boom/)
      return true
    },
  )
})
