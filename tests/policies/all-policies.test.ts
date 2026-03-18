/**
 * Comprehensive tests for all built-in policies.
 * Tests each policy's match() and decide() functions directly,
 * without going through PolicyEngine.
 */

import { describe, it, expect, vi } from 'vitest'
import type { PolicyContext, PolicyDecision, GuardDecision, ObserveDecision } from '../../src/types/policy.js'

// --- no-secret-files ---
import {
  noSecretFilesRead,
  noSecretFilesWrite,
  noSecretSearch,
  noSecretFiles
} from '../../src/policies/no-secret-files.js'

// --- no-destructive ---
import {
  noDestructive,
  requireApprovalForDestructive
} from '../../src/policies/no-destructive.js'

// --- auto-limit ---
import {
  autoLimitGrep,
  autoLimitGlob,
  autoLimitRead,
  autoLimitSql,
  autoLimitPolicies
} from '../../src/policies/auto-limit.js'

// --- normalize-paths ---
import {
  normalizeReadPaths,
  normalizeWritePaths,
  normalizeGlobPaths,
  normalizePathsPolicies
} from '../../src/policies/normalize-paths.js'

// --- audit-all ---
import {
  auditAllCalls,
  auditFileWrites,
  auditCommandExecution,
  alertOnErrors,
  alertOnDenied,
  auditPolicies
} from '../../src/policies/audit-all.js'

// --- index exports ---
import {
  builtinGuardPolicies,
  builtinMutatePolicies,
  builtinObservePolicies,
  builtinPolicies,
  getBuiltinPolicy
} from '../../src/policies/index.js'

// Helper to create a minimal PolicyContext
function ctx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    tool: '',
    input: {},
    agentId: 'test-agent',
    sessionId: 'test-session',
    step: 1,
    ...overrides
  }
}

// ============================================================
// no-secret-files
// ============================================================

describe('noSecretFilesRead', () => {
  it('should have phase guard', () => {
    expect(noSecretFilesRead.phase).toBe('guard')
  })

  describe('match', () => {
    it('matches tool=read', () => {
      expect(noSecretFilesRead.match(ctx({ tool: 'read' }))).toBe(true)
    })

    it('matches operation=readFile', () => {
      expect(noSecretFilesRead.match(ctx({ operation: 'readFile' }))).toBe(true)
    })

    it('does not match tool=write', () => {
      expect(noSecretFilesRead.match(ctx({ tool: 'write' }))).toBe(false)
    })

    it('does not match tool=bash', () => {
      expect(noSecretFilesRead.match(ctx({ tool: 'bash' }))).toBe(false)
    })
  })

  describe('decide', () => {
    const cases: [string, string, boolean][] = [
      ['blocks .env', '/project/.env', true],
      ['blocks .env.local', '/project/.env.local', true],
      ['blocks .env.production', '/project/.env.production', true],
      ['blocks .pem files', '/certs/server.pem', true],
      ['blocks .key files', '/certs/server.key', true],
      ['blocks .p12 files', '/certs/store.p12', true],
      ['blocks .pfx files', '/certs/store.pfx', true],
      ['blocks id_rsa', '/home/user/.ssh/id_rsa', true],
      ['blocks id_ed25519', '/home/user/.ssh/id_ed25519', true],
      ['blocks credentials.json', '/project/credentials.json', true],
      ['blocks secrets.json', '/project/secrets.json', true],
      ['blocks auth.json', '/project/auth.json', true],
      ['blocks .netrc', '/home/user/.netrc', true],
      ['blocks .npmrc', '/home/user/.npmrc', true],
      ['blocks .pypirc', '/home/user/.pypirc', true],
      ['blocks .aws/credentials', '/home/user/.aws/credentials', true],
      ['blocks .aws/config', '/home/user/.aws/config', true],
      ['blocks .ssh/config', '/home/user/.ssh/config', true],
      ['blocks .ssh/known_hosts', '/home/user/.ssh/known_hosts', true],
      ['blocks .htpasswd', '/var/www/.htpasswd', true],
      ['blocks .htaccess', '/var/www/.htaccess', true],
      ['blocks shadow', '/etc/shadow', true],
      ['blocks passwd', '/etc/passwd', true],
      ['allows normal .ts file', '/project/src/index.ts', false],
      ['allows normal .json file', '/project/package.json', false],
      ['allows README.md', '/project/README.md', false],
      ['allows tsconfig.json', '/project/tsconfig.json', false],
    ]

    it.each(cases)('%s (%s)', (_desc, path, shouldDeny) => {
      const decision = noSecretFilesRead.decide(
        ctx({ tool: 'read', input: { path } })
      ) as GuardDecision

      if (shouldDeny) {
        expect(decision.action).toBe('deny')
        expect((decision as any).reason).toContain('Reading sensitive files is prohibited')
      } else {
        expect(decision.action).toBe('allow')
      }
    })

    it('allows when path is empty', () => {
      const decision = noSecretFilesRead.decide(
        ctx({ tool: 'read', input: {} })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('reads path from params if input.path is missing', () => {
      const decision = noSecretFilesRead.decide(
        ctx({ tool: 'read', input: {}, params: { path: '/project/.env' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })

    it('normalizes backslashes before checking', () => {
      const decision = noSecretFilesRead.decide(
        ctx({ tool: 'read', input: { path: 'C:\\Users\\dev\\.env' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })
  })
})

describe('noSecretFilesWrite', () => {
  it('should have phase guard', () => {
    expect(noSecretFilesWrite.phase).toBe('guard')
  })

  describe('match', () => {
    it('matches tool=write', () => {
      expect(noSecretFilesWrite.match(ctx({ tool: 'write' }))).toBe(true)
    })

    it('matches tool=edit', () => {
      expect(noSecretFilesWrite.match(ctx({ tool: 'edit' }))).toBe(true)
    })

    it('matches operation=writeFile', () => {
      expect(noSecretFilesWrite.match(ctx({ operation: 'writeFile' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(noSecretFilesWrite.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('blocks writing to .env', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'write', input: { path: '/project/.env', content: 'SECRET=x' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
      expect((decision as any).reason).toContain('Writing to sensitive files is prohibited')
    })

    it('blocks editing .pem files', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'edit', input: { path: '/certs/server.pem' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })

    it('blocks writing to id_rsa', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'write', input: { path: '/home/user/.ssh/id_rsa' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })

    it('blocks writing to credentials.json', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'write', input: { path: '/project/credentials.json' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })

    it('allows writing to normal files', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'write', input: { path: '/project/src/app.ts' } })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('reads path from params if input.path is missing', () => {
      const decision = noSecretFilesWrite.decide(
        ctx({ tool: 'write', input: {}, params: { path: '/project/.key' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })
  })
})

describe('noSecretSearch', () => {
  it('should have phase guard', () => {
    expect(noSecretSearch.phase).toBe('guard')
  })

  describe('match', () => {
    it('matches tool=grep', () => {
      expect(noSecretSearch.match(ctx({ tool: 'grep' }))).toBe(true)
    })

    it('matches operation=grep', () => {
      expect(noSecretSearch.match(ctx({ operation: 'grep' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(noSecretSearch.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    const blocked: [string, string][] = [
      ['password', 'password'],
      ['PASSWORD (case insensitive)', 'PASSWORD'],
      ['secret', 'my_secret'],
      ['api_key', 'api_key'],
      ['api-key', 'api-key'],
      ['apiKey', 'apiKey'],
      ['access_token', 'access_token'],
      ['access-token', 'access-token'],
      ['private_key', 'private_key'],
      ['private-key', 'private-key'],
      ['bearer', 'Bearer token'],
      ['authorization', 'Authorization header'],
    ]

    it.each(blocked)('blocks searching for %s (%s)', (_desc, pattern) => {
      const decision = noSecretSearch.decide(
        ctx({ tool: 'grep', input: { pattern } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
      expect((decision as any).reason).toContain('Searching for sensitive content is prohibited')
    })

    const allowed: [string, string][] = [
      ['normal code pattern', 'function'],
      ['import statement', 'import.*from'],
      ['class name', 'MyComponent'],
      ['TODO comment', 'TODO:'],
    ]

    it.each(allowed)('allows searching for %s (%s)', (_desc, pattern) => {
      const decision = noSecretSearch.decide(
        ctx({ tool: 'grep', input: { pattern } })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('allows when pattern is empty', () => {
      const decision = noSecretSearch.decide(
        ctx({ tool: 'grep', input: {} })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('reads pattern from params if input.pattern is missing', () => {
      const decision = noSecretSearch.decide(
        ctx({ tool: 'grep', input: {}, params: { pattern: 'password' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })
  })
})

describe('noSecretFiles combined array', () => {
  it('contains exactly 3 policies', () => {
    expect(noSecretFiles).toHaveLength(3)
  })

  it('contains read, write, and search policies', () => {
    const ids = noSecretFiles.map(p => p.id)
    expect(ids).toContain('no-secret-files-read')
    expect(ids).toContain('no-secret-files-write')
    expect(ids).toContain('no-secret-search')
  })
})

// ============================================================
// no-destructive
// ============================================================

describe('noDestructive', () => {
  it('should have phase guard', () => {
    expect(noDestructive.phase).toBe('guard')
  })

  describe('match', () => {
    it('matches tool=bash', () => {
      expect(noDestructive.match(ctx({ tool: 'bash' }))).toBe(true)
    })

    it('matches operation=exec', () => {
      expect(noDestructive.match(ctx({ operation: 'exec' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(noDestructive.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    const blocked: [string, string][] = [
      ['rm -rf /', 'rm -rf /'],
      ['rm -rf with path', 'rm -rf /home/user/important'],
      ['rm with file path', 'rm /tmp/file.txt'],
      ['rmdir', 'rmdir /tmp/mydir'],
      ['DROP TABLE', 'mysql -e "DROP TABLE users"'],
      ['DROP DATABASE', 'DROP DATABASE production'],
      ['DROP INDEX', 'DROP INDEX idx_users'],
      ['DROP VIEW', 'DROP VIEW user_view'],
      ['TRUNCATE TABLE', 'TRUNCATE TABLE logs'],
      ['mkfs', 'mkfs.ext4 /dev/sda1'],
      ['dd if=', 'dd if=/dev/zero of=/dev/sda'],
      ['git push --force', 'git push --force origin main'],
      ['git reset --hard', 'git reset --hard HEAD~1'],
      ['git clean -fd', 'git clean -fd'],
      ['chmod 777', 'chmod 777 /var/www'],
      ['chown -R', 'chown -R root:root /etc'],
      ['format', 'format C:'],
    ]

    it.each(blocked)('blocks %s', (_desc, command) => {
      const decision = noDestructive.decide(
        ctx({ tool: 'bash', input: { command } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
      expect((decision as any).reason).toContain('Dangerous command blocked')
    })

    const allowed: [string, string][] = [
      ['ls -la', 'ls -la'],
      ['cat file', 'cat /tmp/file.txt'],
      ['echo hello', 'echo hello'],
      ['npm install', 'npm install'],
      ['git status', 'git status'],
      ['git commit', 'git commit -m "message"'],
      ['git push (without --force)', 'git push origin main'],
      ['pwd', 'pwd'],
      ['mkdir', 'mkdir -p /tmp/newdir'],
      ['grep pattern', 'grep -r "pattern" /src'],
    ]

    it.each(allowed)('allows %s', (_desc, command) => {
      const decision = noDestructive.decide(
        ctx({ tool: 'bash', input: { command } })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('allows when command is empty', () => {
      const decision = noDestructive.decide(
        ctx({ tool: 'bash', input: {} })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })

    it('reads command from params if input.command is missing', () => {
      const decision = noDestructive.decide(
        ctx({ tool: 'bash', input: {}, params: { command: 'rm -rf /' } })
      ) as GuardDecision
      expect(decision.action).toBe('deny')
    })
  })
})

describe('requireApprovalForDestructive', () => {
  it('should have phase guard', () => {
    expect(requireApprovalForDestructive.phase).toBe('guard')
  })

  it('should have higher priority than noDestructive (runs later)', () => {
    expect(requireApprovalForDestructive.priority).toBeGreaterThan(noDestructive.priority!)
  })

  describe('match', () => {
    it('matches tool=bash', () => {
      expect(requireApprovalForDestructive.match(ctx({ tool: 'bash' }))).toBe(true)
    })

    it('matches operation=exec', () => {
      expect(requireApprovalForDestructive.match(ctx({ operation: 'exec' }))).toBe(true)
    })
  })

  describe('decide', () => {
    const needsApproval: [string, string][] = [
      ['rm command', 'rm file.txt'],
      ['git push', 'git push origin main'],
      ['npm publish', 'npm publish'],
      ['sudo command', 'sudo apt-get install something'],
    ]

    it.each(needsApproval)('requires approval for %s', (_desc, command) => {
      const decision = requireApprovalForDestructive.decide(
        ctx({ tool: 'bash', input: { command } })
      ) as any
      expect(decision.action).toBe('require_approval')
      expect(decision.message).toContain('Confirmation required')
      expect(decision.timeout).toBe(30000)
    })

    const noApproval: [string, string][] = [
      ['ls', 'ls -la'],
      ['cat', 'cat file.txt'],
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['echo', 'echo hello'],
    ]

    it.each(noApproval)('allows %s without approval', (_desc, command) => {
      const decision = requireApprovalForDestructive.decide(
        ctx({ tool: 'bash', input: { command } })
      ) as GuardDecision
      expect(decision.action).toBe('allow')
    })
  })
})

// ============================================================
// auto-limit
// ============================================================

describe('autoLimitGrep', () => {
  it('should have phase mutate', () => {
    expect(autoLimitGrep.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=grep', () => {
      expect(autoLimitGrep.match(ctx({ tool: 'grep' }))).toBe(true)
    })

    it('matches operation=grep', () => {
      expect(autoLimitGrep.match(ctx({ operation: 'grep' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(autoLimitGrep.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('adds limit=100 when no limit is set', () => {
      const decision = autoLimitGrep.decide(
        ctx({ tool: 'grep', input: { pattern: 'foo' } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 100 }
      ])
    })

    it('overrides limit when it exceeds 200', () => {
      const decision = autoLimitGrep.decide(
        ctx({ tool: 'grep', input: { pattern: 'foo', limit: 500 } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 100 }
      ])
    })

    it('does not modify when limit is within bounds', () => {
      const decision = autoLimitGrep.decide(
        ctx({ tool: 'grep', input: { pattern: 'foo', limit: 50 } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([])
    })

    it('does not modify when limit is exactly 200', () => {
      const decision = autoLimitGrep.decide(
        ctx({ tool: 'grep', input: { pattern: 'foo', limit: 200 } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('overrides when limit is 201', () => {
      const decision = autoLimitGrep.decide(
        ctx({ tool: 'grep', input: { pattern: 'foo', limit: 201 } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 100 }
      ])
    })
  })
})

describe('autoLimitGlob', () => {
  it('should have phase mutate', () => {
    expect(autoLimitGlob.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=glob', () => {
      expect(autoLimitGlob.match(ctx({ tool: 'glob' }))).toBe(true)
    })

    it('matches operation=glob', () => {
      expect(autoLimitGlob.match(ctx({ operation: 'glob' }))).toBe(true)
    })

    it('does not match tool=grep', () => {
      expect(autoLimitGlob.match(ctx({ tool: 'grep' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('adds default ignore patterns', () => {
      const decision = autoLimitGlob.decide(
        ctx({ tool: 'glob', input: { pattern: '**/*.ts' } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([{
        op: 'set',
        path: 'ignore',
        value: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/coverage/**']
      }])
    })

    it('always sets ignore patterns (overwrites existing)', () => {
      // The current implementation always sets ignore, it doesn't check existing
      const decision = autoLimitGlob.decide(
        ctx({ tool: 'glob', input: { pattern: '**/*.ts', ignore: ['**/custom/**'] } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toHaveLength(1)
      expect(decision.transforms[0].value).toContain('**/node_modules/**')
    })
  })
})

describe('autoLimitRead', () => {
  it('should have phase mutate', () => {
    expect(autoLimitRead.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=read', () => {
      expect(autoLimitRead.match(ctx({ tool: 'read' }))).toBe(true)
    })

    it('matches operation=readFile', () => {
      expect(autoLimitRead.match(ctx({ operation: 'readFile' }))).toBe(true)
    })

    it('does not match tool=write', () => {
      expect(autoLimitRead.match(ctx({ tool: 'write' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('adds limit=2000 when no limit is set', () => {
      const decision = autoLimitRead.decide(
        ctx({ tool: 'read', input: { path: '/file.txt' } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 2000 }
      ])
    })

    it('overrides limit when it exceeds 2000', () => {
      const decision = autoLimitRead.decide(
        ctx({ tool: 'read', input: { path: '/file.txt', limit: 5000 } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 2000 }
      ])
    })

    it('does not modify when limit is within bounds', () => {
      const decision = autoLimitRead.decide(
        ctx({ tool: 'read', input: { path: '/file.txt', limit: 500 } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('does not modify when limit is exactly 2000', () => {
      const decision = autoLimitRead.decide(
        ctx({ tool: 'read', input: { path: '/file.txt', limit: 2000 } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('overrides when limit is 2001', () => {
      const decision = autoLimitRead.decide(
        ctx({ tool: 'read', input: { path: '/file.txt', limit: 2001 } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'set', path: 'limit', value: 2000 }
      ])
    })
  })
})

describe('autoLimitSql', () => {
  it('should have phase mutate', () => {
    expect(autoLimitSql.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches when input has sql field', () => {
      expect(autoLimitSql.match(ctx({ input: { sql: 'SELECT * FROM users' } }))).toBe(true)
    })

    it('does not match when input has no sql field', () => {
      expect(autoLimitSql.match(ctx({ input: { command: 'ls' } }))).toBe(false)
    })

    it('does not match when sql is empty', () => {
      expect(autoLimitSql.match(ctx({ input: { sql: '' } }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('appends LIMIT 100 to SELECT without LIMIT', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'SELECT * FROM users' } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([
        { op: 'append', path: 'sql', value: ' LIMIT 100' }
      ])
    })

    it('does not add LIMIT when already present', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'SELECT * FROM users LIMIT 50' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('handles case-insensitive LIMIT', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'SELECT * FROM users limit 25' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('does not add LIMIT to non-SELECT statements', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'INSERT INTO users VALUES (1, "test")' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('does not add LIMIT to UPDATE statements', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'UPDATE users SET name = "test"' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('does not add LIMIT to DELETE statements', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: 'DELETE FROM users WHERE id = 1' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('handles SELECT with leading whitespace', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: '  SELECT * FROM users' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'append', path: 'sql', value: ' LIMIT 100' }
      ])
    })

    it('handles empty sql', () => {
      const decision = autoLimitSql.decide(
        ctx({ input: { sql: '' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })
  })
})

describe('autoLimitPolicies combined array', () => {
  it('contains exactly 4 policies', () => {
    expect(autoLimitPolicies).toHaveLength(4)
  })

  it('contains all auto-limit policies', () => {
    const ids = autoLimitPolicies.map(p => p.id)
    expect(ids).toContain('auto-limit-sql')
    expect(ids).toContain('auto-limit-grep')
    expect(ids).toContain('auto-limit-glob')
    expect(ids).toContain('auto-limit-read')
  })
})

// ============================================================
// normalize-paths
// ============================================================

describe('normalizeReadPaths', () => {
  it('should have phase mutate', () => {
    expect(normalizeReadPaths.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=read', () => {
      expect(normalizeReadPaths.match(ctx({ tool: 'read' }))).toBe(true)
    })

    it('matches operation=readFile', () => {
      expect(normalizeReadPaths.match(ctx({ operation: 'readFile' }))).toBe(true)
    })

    it('does not match tool=write', () => {
      expect(normalizeReadPaths.match(ctx({ tool: 'write' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('emits normalize_path transform for path with ..', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: { path: '/project/foo/../bar/file.ts' } })
      ) as any
      expect(decision.action).toBe('transform')
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'path' }
      ])
    })

    it('emits normalize_path transform for path with .', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: { path: '/project/./bar/file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'path' }
      ])
    })

    it('emits normalize_path transform for path with backslashes', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: { path: 'C:\\Users\\dev\\file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'path' }
      ])
    })

    it('emits normalize_path transform for path with double slashes', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: { path: '/project//src//file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'path' }
      ])
    })

    it('returns empty transforms for already-clean path', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: { path: '/project/src/file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('returns empty transforms when path is missing', () => {
      const decision = normalizeReadPaths.decide(
        ctx({ tool: 'read', input: {} })
      ) as any
      expect(decision.transforms).toEqual([])
    })
  })
})

describe('normalizeWritePaths', () => {
  it('should have phase mutate', () => {
    expect(normalizeWritePaths.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=write', () => {
      expect(normalizeWritePaths.match(ctx({ tool: 'write' }))).toBe(true)
    })

    it('matches tool=edit', () => {
      expect(normalizeWritePaths.match(ctx({ tool: 'edit' }))).toBe(true)
    })

    it('matches operation=writeFile', () => {
      expect(normalizeWritePaths.match(ctx({ operation: 'writeFile' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(normalizeWritePaths.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('emits normalize_path transform for path with ..', () => {
      const decision = normalizeWritePaths.decide(
        ctx({ tool: 'write', input: { path: '/project/foo/../bar/file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'path' }
      ])
    })

    it('returns empty transforms for clean path', () => {
      const decision = normalizeWritePaths.decide(
        ctx({ tool: 'write', input: { path: '/project/src/file.ts' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('returns empty transforms when path is missing', () => {
      const decision = normalizeWritePaths.decide(
        ctx({ tool: 'write', input: {} })
      ) as any
      expect(decision.transforms).toEqual([])
    })
  })
})

describe('normalizeGlobPaths', () => {
  it('should have phase mutate', () => {
    expect(normalizeGlobPaths.phase).toBe('mutate')
  })

  describe('match', () => {
    it('matches tool=glob', () => {
      expect(normalizeGlobPaths.match(ctx({ tool: 'glob' }))).toBe(true)
    })

    it('matches operation=glob', () => {
      expect(normalizeGlobPaths.match(ctx({ operation: 'glob' }))).toBe(true)
    })

    it('does not match tool=grep', () => {
      expect(normalizeGlobPaths.match(ctx({ tool: 'grep' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('emits normalize_path transform for cwd with ..', () => {
      const decision = normalizeGlobPaths.decide(
        ctx({ tool: 'glob', input: { cwd: '/project/foo/../bar' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'cwd' }
      ])
    })

    it('emits normalize_path transform for cwd with backslashes', () => {
      const decision = normalizeGlobPaths.decide(
        ctx({ tool: 'glob', input: { cwd: 'C:\\project\\src' } })
      ) as any
      expect(decision.transforms).toEqual([
        { op: 'normalize_path', path: 'cwd' }
      ])
    })

    it('returns empty transforms for clean cwd', () => {
      const decision = normalizeGlobPaths.decide(
        ctx({ tool: 'glob', input: { cwd: '/project/src' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })

    it('returns empty transforms when cwd is missing', () => {
      const decision = normalizeGlobPaths.decide(
        ctx({ tool: 'glob', input: { pattern: '**/*.ts' } })
      ) as any
      expect(decision.transforms).toEqual([])
    })
  })
})

describe('normalizePathsPolicies combined array', () => {
  it('contains exactly 3 policies', () => {
    expect(normalizePathsPolicies).toHaveLength(3)
  })

  it('contains all normalize policies', () => {
    const ids = normalizePathsPolicies.map(p => p.id)
    expect(ids).toContain('normalize-read-paths')
    expect(ids).toContain('normalize-write-paths')
    expect(ids).toContain('normalize-glob-paths')
  })
})

// ============================================================
// audit-all
// ============================================================

describe('auditAllCalls', () => {
  it('should have phase observe', () => {
    expect(auditAllCalls.phase).toBe('observe')
  })

  describe('match', () => {
    it('matches any tool', () => {
      expect(auditAllCalls.match(ctx({ tool: 'read' }))).toBe(true)
      expect(auditAllCalls.match(ctx({ tool: 'write' }))).toBe(true)
      expect(auditAllCalls.match(ctx({ tool: 'bash' }))).toBe(true)
      expect(auditAllCalls.match(ctx({ tool: 'glob' }))).toBe(true)
      expect(auditAllCalls.match(ctx({ tool: 'anything' }))).toBe(true)
    })
  })

  describe('decide', () => {
    it('returns observe action with record containing tool info', () => {
      const c = ctx({
        tool: 'read',
        input: { path: '/test/file.txt' },
        sessionId: 'sess-123',
        step: 5,
        result: { success: true }
      })
      const decision = auditAllCalls.decide(c) as ObserveDecision
      expect(decision.action).toBe('observe')
      expect(decision.record).toBeDefined()
      expect(decision.record!.tool).toBe('read')
      expect(decision.record!.input).toEqual({ path: '/test/file.txt' })
      expect(decision.record!.result).toEqual({ success: true })
      expect(decision.record!.sessionId).toBe('sess-123')
      expect(decision.record!.step).toBe(5)
      expect(decision.record!.timestamp).toBeTypeOf('number')
    })

    it('records operation if set', () => {
      const c = ctx({ tool: 'read', operation: 'readFile', input: {} })
      const decision = auditAllCalls.decide(c) as ObserveDecision
      expect(decision.record!.operation).toBe('readFile')
    })
  })
})

describe('auditFileWrites', () => {
  it('should have phase observe', () => {
    expect(auditFileWrites.phase).toBe('observe')
  })

  describe('match', () => {
    it('matches tool=write', () => {
      expect(auditFileWrites.match(ctx({ tool: 'write' }))).toBe(true)
    })

    it('matches tool=edit', () => {
      expect(auditFileWrites.match(ctx({ tool: 'edit' }))).toBe(true)
    })

    it('matches operation=writeFile', () => {
      expect(auditFileWrites.match(ctx({ operation: 'writeFile' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(auditFileWrites.match(ctx({ tool: 'read' }))).toBe(false)
    })

    it('does not match tool=bash', () => {
      expect(auditFileWrites.match(ctx({ tool: 'bash' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('returns observe action with record and emit', () => {
      const c = ctx({
        tool: 'write',
        input: { path: '/project/src/file.ts' },
        sessionId: 'sess-456'
      })
      const decision = auditFileWrites.decide(c) as ObserveDecision
      expect(decision.action).toBe('observe')
      expect(decision.record).toBeDefined()
      expect(decision.record!.type).toBe('file_write')
      expect(decision.record!.path).toBe('/project/src/file.ts')
      expect(decision.record!.timestamp).toBeTypeOf('number')
    })

    it('emits file:write event', () => {
      const c = ctx({
        tool: 'write',
        input: { path: '/project/src/file.ts' },
        sessionId: 'sess-456'
      })
      const decision = auditFileWrites.decide(c) as ObserveDecision
      expect(decision.emit).toBeDefined()
      expect(decision.emit).toHaveLength(1)
      expect(decision.emit![0].event).toBe('file:write')
      expect((decision.emit![0].data as any).path).toBe('/project/src/file.ts')
      expect((decision.emit![0].data as any).sessionId).toBe('sess-456')
    })

    it('handles missing path gracefully', () => {
      const c = ctx({ tool: 'write', input: {} })
      const decision = auditFileWrites.decide(c) as ObserveDecision
      expect(decision.record!.path).toBeUndefined()
    })
  })
})

describe('auditCommandExecution', () => {
  it('should have phase observe', () => {
    expect(auditCommandExecution.phase).toBe('observe')
  })

  describe('match', () => {
    it('matches tool=bash', () => {
      expect(auditCommandExecution.match(ctx({ tool: 'bash' }))).toBe(true)
    })

    it('matches operation=exec', () => {
      expect(auditCommandExecution.match(ctx({ operation: 'exec' }))).toBe(true)
    })

    it('does not match tool=read', () => {
      expect(auditCommandExecution.match(ctx({ tool: 'read' }))).toBe(false)
    })
  })

  describe('decide', () => {
    it('returns observe action with command and result', () => {
      const c = ctx({
        tool: 'bash',
        input: { command: 'ls -la' },
        result: { stdout: 'file1\nfile2' }
      })
      const decision = auditCommandExecution.decide(c) as ObserveDecision
      expect(decision.action).toBe('observe')
      expect(decision.record).toBeDefined()
      expect(decision.record!.type).toBe('command_execution')
      expect(decision.record!.command).toBe('ls -la')
      expect(decision.record!.result).toEqual({ stdout: 'file1\nfile2' })
      expect(decision.record!.timestamp).toBeTypeOf('number')
    })

    it('handles missing command', () => {
      const c = ctx({ tool: 'bash', input: {} })
      const decision = auditCommandExecution.decide(c) as ObserveDecision
      expect(decision.record!.command).toBeUndefined()
    })
  })
})

describe('alertOnErrors', () => {
  it('should have phase observe', () => {
    expect(alertOnErrors.phase).toBe('observe')
  })

  describe('match', () => {
    it('matches when result.success is false', () => {
      expect(alertOnErrors.match(
        ctx({ tool: 'read', result: { success: false } })
      )).toBe(true)
    })

    it('does not match when result.success is true', () => {
      expect(alertOnErrors.match(
        ctx({ tool: 'read', result: { success: true } })
      )).toBe(false)
    })

    it('does not match when result is undefined', () => {
      expect(alertOnErrors.match(
        ctx({ tool: 'read' })
      )).toBe(false)
    })

    it('does not match when result has no success field', () => {
      expect(alertOnErrors.match(
        ctx({ tool: 'read', result: { data: 'something' } })
      )).toBe(false)
    })
  })

  describe('decide', () => {
    it('returns observe action with alert containing error message', () => {
      const c = ctx({
        tool: 'read',
        input: {},
        result: { success: false, error: 'File not found' }
      })
      const decision = alertOnErrors.decide(c) as ObserveDecision
      expect(decision.action).toBe('observe')
      expect(decision.alert).toBeDefined()
      expect(decision.alert!.level).toBe('warn')
      expect(decision.alert!.message).toContain('Tool read execution failed')
      expect(decision.alert!.message).toContain('File not found')
    })

    it('uses "Unknown error" when error field is missing', () => {
      const c = ctx({
        tool: 'bash',
        input: {},
        result: { success: false }
      })
      const decision = alertOnErrors.decide(c) as ObserveDecision
      expect(decision.alert!.message).toContain('Unknown error')
    })
  })
})

describe('alertOnDenied', () => {
  it('should have phase observe', () => {
    expect(alertOnDenied.phase).toBe('observe')
  })

  describe('match', () => {
    it('matches any context', () => {
      expect(alertOnDenied.match(ctx({ tool: 'read' }))).toBe(true)
      expect(alertOnDenied.match(ctx({ tool: 'bash' }))).toBe(true)
    })
  })

  describe('decide', () => {
    it('returns observe action with emit containing policy:activity event', () => {
      const c = ctx({ tool: 'write', step: 3 })
      const decision = alertOnDenied.decide(c) as ObserveDecision
      expect(decision.action).toBe('observe')
      expect(decision.emit).toBeDefined()
      expect(decision.emit).toHaveLength(1)
      expect(decision.emit![0].event).toBe('policy:activity')
      expect((decision.emit![0].data as any).tool).toBe('write')
      expect((decision.emit![0].data as any).step).toBe(3)
      expect((decision.emit![0].data as any).timestamp).toBeTypeOf('number')
    })
  })
})

describe('auditPolicies combined array', () => {
  it('contains exactly 5 policies', () => {
    expect(auditPolicies).toHaveLength(5)
  })

  it('contains all audit policies', () => {
    const ids = auditPolicies.map(p => p.id)
    expect(ids).toContain('audit-all-calls')
    expect(ids).toContain('audit-file-writes')
    expect(ids).toContain('audit-command-execution')
    expect(ids).toContain('alert-on-errors')
    expect(ids).toContain('alert-on-denied')
  })
})

// ============================================================
// index.ts exports
// ============================================================

describe('index.ts exports', () => {
  describe('builtinGuardPolicies', () => {
    it('contains noDestructive and all noSecretFiles policies', () => {
      const ids = builtinGuardPolicies.map(p => p.id)
      expect(ids).toContain('no-destructive')
      expect(ids).toContain('no-secret-files-read')
      expect(ids).toContain('no-secret-files-write')
      expect(ids).toContain('no-secret-search')
    })

    it('has exactly 4 guard policies', () => {
      expect(builtinGuardPolicies).toHaveLength(4)
    })

    it('all have phase guard', () => {
      for (const p of builtinGuardPolicies) {
        expect(p.phase).toBe('guard')
      }
    })
  })

  describe('builtinMutatePolicies', () => {
    it('contains auto-limit and normalize-paths policies', () => {
      const ids = builtinMutatePolicies.map(p => p.id)
      expect(ids).toContain('auto-limit-sql')
      expect(ids).toContain('auto-limit-grep')
      expect(ids).toContain('auto-limit-glob')
      expect(ids).toContain('auto-limit-read')
      expect(ids).toContain('normalize-read-paths')
      expect(ids).toContain('normalize-write-paths')
      expect(ids).toContain('normalize-glob-paths')
    })

    it('has exactly 7 mutate policies', () => {
      expect(builtinMutatePolicies).toHaveLength(7)
    })

    it('all have phase mutate', () => {
      for (const p of builtinMutatePolicies) {
        expect(p.phase).toBe('mutate')
      }
    })
  })

  describe('builtinObservePolicies', () => {
    it('contains all audit policies', () => {
      const ids = builtinObservePolicies.map(p => p.id)
      expect(ids).toContain('audit-all-calls')
      expect(ids).toContain('audit-file-writes')
      expect(ids).toContain('audit-command-execution')
      expect(ids).toContain('alert-on-errors')
      expect(ids).toContain('alert-on-denied')
    })

    it('has exactly 5 observe policies', () => {
      expect(builtinObservePolicies).toHaveLength(5)
    })

    it('all have phase observe', () => {
      for (const p of builtinObservePolicies) {
        expect(p.phase).toBe('observe')
      }
    })
  })

  describe('builtinPolicies', () => {
    it('is the union of all phase arrays', () => {
      expect(builtinPolicies).toHaveLength(
        builtinGuardPolicies.length +
        builtinMutatePolicies.length +
        builtinObservePolicies.length
      )
    })
  })

  describe('getBuiltinPolicy', () => {
    it('returns policy by id', () => {
      const policy = getBuiltinPolicy('no-destructive')
      expect(policy).toBeDefined()
      expect(policy!.id).toBe('no-destructive')
    })

    it('returns undefined for unknown id', () => {
      const policy = getBuiltinPolicy('nonexistent-policy')
      expect(policy).toBeUndefined()
    })

    it('can find policies from all phases', () => {
      // guard
      expect(getBuiltinPolicy('no-destructive')).toBeDefined()
      expect(getBuiltinPolicy('no-secret-files-read')).toBeDefined()
      // mutate
      expect(getBuiltinPolicy('auto-limit-grep')).toBeDefined()
      expect(getBuiltinPolicy('normalize-read-paths')).toBeDefined()
      // observe
      expect(getBuiltinPolicy('audit-all-calls')).toBeDefined()
      expect(getBuiltinPolicy('alert-on-errors')).toBeDefined()
    })
  })
})
