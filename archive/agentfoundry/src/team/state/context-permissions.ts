/**
 * ContextPermissions - Permission Control for Namespaced Context
 *
 * Provides fine-grained access control:
 * - Permission levels: read, write, admin
 * - Default permissions based on namespace type
 * - Grant/revoke API for custom permissions
 */

import type { Namespace } from './namespaced-context.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Permission levels
 * - read: Can read values
 * - write: Can read and write values
 * - admin: Can read, write, and delete values
 */
export type Permission = 'read' | 'write' | 'admin'

/**
 * Permission entry
 */
interface PermissionEntry {
  agentId: string
  namespace: string  // Can be exact namespace or pattern (e.g., 'team.*', 'agent.researcher.*')
  permission: Permission
  granted: boolean
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean
  reason?: string
  grantedBy?: string  // Which rule granted/denied
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Special agent ID for wildcard permissions
 */
export const WILDCARD_AGENT = '*'

/**
 * Permission hierarchy (higher includes lower)
 */
const PERMISSION_HIERARCHY: Record<Permission, number> = {
  read: 1,
  write: 2,
  admin: 3
}

// ============================================================================
// ContextPermissions Implementation
// ============================================================================

/**
 * ContextPermissions - Manages access control for namespaced context
 */
export class ContextPermissions {
  private permissions: PermissionEntry[] = []

  constructor() {
    // Initialize default permissions
    this.initializeDefaults()
  }

  /**
   * Initialize default permission rules
   */
  private initializeDefaults(): void {
    // Team namespace: all agents can read and write by default
    this.permissions.push({
      agentId: WILDCARD_AGENT,
      namespace: 'team',
      permission: 'write',
      granted: true
    })

    // Agent namespace: owner has admin, others have no access
    // This is handled dynamically in canAccess
  }

  /**
   * Check if an agent can access a namespace with given permission
   */
  canAccess(agentId: string, namespace: Namespace, permission: Permission): boolean {
    const result = this.checkAccess(agentId, namespace, permission)
    return result.allowed
  }

  /**
   * Check access with detailed result
   */
  checkAccess(agentId: string, namespace: Namespace, permission: Permission): PermissionCheckResult {
    // Check for explicit deny first
    const explicitDeny = this.findPermission(agentId, namespace, false)
    if (explicitDeny && this.permissionCovers(explicitDeny.permission, permission)) {
      return {
        allowed: false,
        reason: 'Explicitly denied',
        grantedBy: `deny:${explicitDeny.agentId}:${explicitDeny.namespace}`
      }
    }

    // Check for explicit grant
    const explicitGrant = this.findPermission(agentId, namespace, true)
    if (explicitGrant && this.permissionCovers(explicitGrant.permission, permission)) {
      return {
        allowed: true,
        grantedBy: `grant:${explicitGrant.agentId}:${explicitGrant.namespace}`
      }
    }

    // Check wildcard grants
    const wildcardGrant = this.findPermission(WILDCARD_AGENT, namespace, true)
    if (wildcardGrant && this.permissionCovers(wildcardGrant.permission, permission)) {
      return {
        allowed: true,
        grantedBy: `grant:${WILDCARD_AGENT}:${wildcardGrant.namespace}`
      }
    }

    // Check agent namespace ownership
    if (namespace.startsWith('agent.')) {
      const ownerAgentId = namespace.slice('agent.'.length).split('.')[0]
      if (ownerAgentId === agentId) {
        // Owner has admin access to their own namespace
        return {
          allowed: true,
          reason: 'Namespace owner',
          grantedBy: 'owner'
        }
      } else {
        // Non-owner has no access by default
        return {
          allowed: false,
          reason: 'Not namespace owner',
          grantedBy: 'default'
        }
      }
    }

    // Default deny
    return {
      allowed: false,
      reason: 'No matching permission rule',
      grantedBy: 'default'
    }
  }

  /**
   * Grant permission to an agent
   */
  grant(agentId: string, namespace: string, permission: Permission): void {
    // Remove any existing permission for this agent/namespace combo
    this.removePermission(agentId, namespace)

    this.permissions.push({
      agentId,
      namespace,
      permission,
      granted: true
    })
  }

  /**
   * Revoke permission from an agent
   */
  revoke(agentId: string, namespace: string, permission: Permission): void {
    // Remove any existing permission for this agent/namespace combo
    this.removePermission(agentId, namespace)

    // Add explicit deny
    this.permissions.push({
      agentId,
      namespace,
      permission,
      granted: false
    })
  }

  /**
   * Remove permission entry (neither grant nor deny)
   */
  removePermission(agentId: string, namespace: string): void {
    this.permissions = this.permissions.filter(
      p => !(p.agentId === agentId && p.namespace === namespace)
    )
  }

  /**
   * Reset to default permissions
   */
  reset(): void {
    this.permissions = []
    this.initializeDefaults()
  }

  /**
   * Get all permissions for an agent
   */
  getPermissionsForAgent(agentId: string): PermissionEntry[] {
    return this.permissions.filter(
      p => p.agentId === agentId || p.agentId === WILDCARD_AGENT
    )
  }

  /**
   * Get all permissions for a namespace
   */
  getPermissionsForNamespace(namespace: string): PermissionEntry[] {
    return this.permissions.filter(
      p => this.namespaceMatches(p.namespace, namespace)
    )
  }

  /**
   * Export permissions (for serialization)
   */
  export(): PermissionEntry[] {
    return [...this.permissions]
  }

  /**
   * Import permissions
   */
  import(permissions: PermissionEntry[]): void {
    this.permissions = [...permissions]
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Find a matching permission entry
   */
  private findPermission(
    agentId: string,
    namespace: Namespace,
    granted: boolean
  ): PermissionEntry | undefined {
    // Look for most specific match first
    // 1. Exact agent + exact namespace
    // 2. Exact agent + namespace prefix
    // 3. Wildcard agent + exact namespace
    // 4. Wildcard agent + namespace prefix

    // Exact match
    const exactMatch = this.permissions.find(
      p => p.agentId === agentId &&
           p.namespace === namespace &&
           p.granted === granted
    )
    if (exactMatch) return exactMatch

    // Namespace prefix match (e.g., 'team' matches 'team.findings')
    const prefixMatch = this.permissions.find(
      p => p.agentId === agentId &&
           this.namespaceMatches(p.namespace, namespace) &&
           p.granted === granted
    )
    if (prefixMatch) return prefixMatch

    return undefined
  }

  /**
   * Check if a namespace pattern matches a namespace
   */
  private namespaceMatches(pattern: string, namespace: string): boolean {
    // Exact match
    if (pattern === namespace) return true

    // Prefix match (e.g., 'team' matches 'team.findings')
    if (namespace.startsWith(pattern + '.')) return true
    if (pattern.startsWith(namespace + '.')) return false

    // Base namespace match (e.g., 'team' matches 'team')
    if (pattern === 'team' && namespace === 'team') return true

    // Agent namespace prefix match
    if (pattern.startsWith('agent.') && namespace.startsWith('agent.')) {
      const patternAgentId = pattern.slice('agent.'.length).split('.')[0]
      const namespaceAgentId = namespace.slice('agent.'.length).split('.')[0]
      return patternAgentId === namespaceAgentId
    }

    return false
  }

  /**
   * Check if a permission level covers another
   */
  private permissionCovers(granted: Permission, requested: Permission): boolean {
    return PERMISSION_HIERARCHY[granted] >= PERMISSION_HIERARCHY[requested]
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a permissions manager
 */
export function createContextPermissions(): ContextPermissions {
  return new ContextPermissions()
}
