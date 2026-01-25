/**
 * no-secret-files - 禁止访问敏感文件策略
 */

import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * 敏感文件模式
 */
const SECRET_PATTERNS = [
  // 环境变量文件
  /\.env$/,
  /\.env\.\w+$/,
  /\.env\.local$/,

  // 密钥和证书
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa$/,
  /id_ed25519$/,

  // 认证文件
  /credentials\.json$/,
  /secrets\.json$/,
  /auth\.json$/,
  /\.netrc$/,
  /\.npmrc$/,
  /\.pypirc$/,

  // AWS
  /\.aws\/credentials$/,
  /\.aws\/config$/,

  // SSH
  /\.ssh\/config$/,
  /\.ssh\/known_hosts$/,

  // 其他敏感文件
  /\.htpasswd$/,
  /\.htaccess$/,
  /shadow$/,
  /passwd$/
]

/**
 * 检查路径是否为敏感文件
 */
function isSensitivePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/')

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return true
    }
  }

  return false
}

/**
 * 禁止读取敏感文件策略
 */
export const noSecretFilesRead = defineGuardPolicy({
  id: 'no-secret-files-read',
  description: '禁止读取敏感文件（如 .env、密钥文件等）',
  priority: 10,
  match: (ctx) => {
    return ctx.tool === 'read' || ctx.operation === 'readFile'
  },
  decide: (ctx) => {
    const path = (ctx.input as { path?: string })?.path ??
                 (ctx.params as { path?: string })?.path ?? ''

    if (isSensitivePath(path)) {
      return {
        action: 'deny',
        reason: `禁止读取敏感文件: ${path}`
      }
    }

    return { action: 'allow' }
  }
})

/**
 * 禁止写入敏感文件策略
 */
export const noSecretFilesWrite = defineGuardPolicy({
  id: 'no-secret-files-write',
  description: '禁止写入敏感文件',
  priority: 10,
  match: (ctx) => {
    return ctx.tool === 'write' || ctx.tool === 'edit' || ctx.operation === 'writeFile'
  },
  decide: (ctx) => {
    const path = (ctx.input as { path?: string })?.path ??
                 (ctx.params as { path?: string })?.path ?? ''

    if (isSensitivePath(path)) {
      return {
        action: 'deny',
        reason: `禁止写入敏感文件: ${path}`
      }
    }

    return { action: 'allow' }
  }
})

/**
 * 禁止搜索敏感内容策略
 */
export const noSecretSearch = defineGuardPolicy({
  id: 'no-secret-search',
  description: '禁止搜索密码、API 密钥等敏感内容',
  priority: 10,
  match: (ctx) => {
    return ctx.tool === 'grep' || ctx.operation === 'grep'
  },
  decide: (ctx) => {
    const pattern = (ctx.input as { pattern?: string })?.pattern ??
                    (ctx.params as { pattern?: string })?.pattern ?? ''

    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /api.?key/i,
      /access.?token/i,
      /private.?key/i,
      /bearer/i,
      /authorization/i
    ]

    for (const sensitive of sensitivePatterns) {
      if (sensitive.test(pattern)) {
        return {
          action: 'deny',
          reason: `禁止搜索敏感内容: ${pattern}`
        }
      }
    }

    return { action: 'allow' }
  }
})

/**
 * 合并的敏感文件策略
 */
export const noSecretFiles = [
  noSecretFilesRead,
  noSecretFilesWrite,
  noSecretSearch
]
