export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
  }
}

export const badRequest = (message) => new AppError('BAD_REQUEST', message, 400)
export const notFound = (message) => new AppError('NOT_FOUND', message, 404)
export const conflict = (message) => new AppError('CONFLICT', message, 409)
export const forbidden = (message) => new AppError('FORBIDDEN', message, 403)
export const hotUpgradeUnsupported = () => new AppError(
  'DSH_HOT_UPGRADE_UNSUPPORTED',
  '热升级/重启不受支持：请手动升级 dsh 后重启',
  409,
)
