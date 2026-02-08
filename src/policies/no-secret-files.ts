/**
 * no-secret-files - Prohibit access to sensitive files policy
 */

import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * Sensitive file patterns
 */
const SECRET_PATTERNS = [
  // Environment variable files
  /\.env$/,
  /\.env\.\w+$/,
  /\.env\.local$/,

  // Keys and certificates
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa$/,
  /id_ed25519$/,

  // Authentication files
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

  // Other sensitive files
  /\.htpasswd$/,
  /\.htaccess$/,
  /shadow$/,
  /passwd$/
]

/**
 * Check if a path is a sensitive file
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
 * Prohibit reading sensitive files policy
 */
export const noSecretFilesRead = defineGuardPolicy({
  id: 'no-secret-files-read',
  description: 'Prohibit reading sensitive files (e.g., .env, key files, etc.)',
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
        reason: `Reading sensitive files is prohibited: ${path}`
      }
    }

    return { action: 'allow' }
  }
})

/**
 * Prohibit writing sensitive files policy
 */
export const noSecretFilesWrite = defineGuardPolicy({
  id: 'no-secret-files-write',
  description: 'Prohibit writing to sensitive files',
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
        reason: `Writing to sensitive files is prohibited: ${path}`
      }
    }

    return { action: 'allow' }
  }
})

/**
 * Prohibit searching for sensitive content policy
 */
export const noSecretSearch = defineGuardPolicy({
  id: 'no-secret-search',
  description: 'Prohibit searching for sensitive content such as passwords and API keys',
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
          reason: `Searching for sensitive content is prohibited: ${pattern}`
        }
      }
    }

    return { action: 'allow' }
  }
})

/**
 * Combined sensitive file policies
 */
export const noSecretFiles = [
  noSecretFilesRead,
  noSecretFilesWrite,
  noSecretSearch
]
