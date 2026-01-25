/**
 * Template Resolver - Handle parameterized MCP server templates
 *
 * Resolves parameterized templates by substituting user-provided values
 * and validating them against the parameter definitions.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  ConfigTemplate,
  SimpleConfigTemplateSchema,
  ParameterizedConfigTemplateSchema,
  TemplateParameter
} from './schemas/mcp-catalog.schema.js'

import type { MCPServerConfig, MCPStdioConfig } from '../mcp/index.js'

// ============================================================================
// Types
// ============================================================================

/**
 * User-provided parameter values
 */
export type ParameterValues = Record<string, string | string[]>

/**
 * Validation error for a parameter
 */
export interface ParameterValidationError {
  parameter: string
  message: string
  value?: unknown
}

/**
 * Result of template resolution
 */
export interface ResolvedTemplate {
  config: MCPServerConfig
  warnings: string[]
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Remove undefined fields from an object (returns new object)
 */
function cleanUndefinedFields<T extends object>(obj: T): T {
  const result = { ...obj }
  for (const key of Object.keys(result)) {
    if ((result as Record<string, unknown>)[key] === undefined) {
      delete (result as Record<string, unknown>)[key]
    }
  }
  return result
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a path parameter value
 */
function validatePath(
  value: string,
  mustExist: boolean,
  basePath: string
): { valid: boolean; error?: string } {
  const resolvedPath = resolve(basePath, value)

  if (mustExist) {
    if (!existsSync(resolvedPath)) {
      return {
        valid: false,
        error: `Path does not exist: ${resolvedPath}`
      }
    }
  }

  return { valid: true }
}

/**
 * Validate a parameter value against its definition
 */
function validateParameter(
  param: TemplateParameter,
  value: unknown,
  basePath: string
): ParameterValidationError[] {
  const errors: ParameterValidationError[] = []

  // Check if required and missing
  if (param.required && (value === undefined || value === null || value === '')) {
    errors.push({
      parameter: param.name,
      message: `Required parameter "${param.name}" is missing`,
      value
    })
    return errors
  }

  // If optional and not provided, skip validation
  if (!param.required && (value === undefined || value === null || value === '')) {
    return errors
  }

  // Type validation
  switch (param.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push({
          parameter: param.name,
          message: `Expected string, got ${typeof value}`,
          value
        })
      }
      break

    case 'string[]':
      if (!Array.isArray(value)) {
        errors.push({
          parameter: param.name,
          message: `Expected string array, got ${typeof value}`,
          value
        })
      } else if (!value.every(v => typeof v === 'string')) {
        errors.push({
          parameter: param.name,
          message: 'All array elements must be strings',
          value
        })
      }
      break

    case 'path':
      if (typeof value !== 'string') {
        errors.push({
          parameter: param.name,
          message: `Expected path string, got ${typeof value}`,
          value
        })
      } else if (param.validation?.type === 'path') {
        const result = validatePath(value, param.validation.mustExist ?? false, basePath)
        if (!result.valid) {
          errors.push({
            parameter: param.name,
            message: result.error!,
            value
          })
        }
      }
      break

    case 'path[]':
      if (!Array.isArray(value)) {
        errors.push({
          parameter: param.name,
          message: `Expected path array, got ${typeof value}`,
          value
        })
      } else {
        for (const v of value) {
          if (typeof v !== 'string') {
            errors.push({
              parameter: param.name,
              message: 'All array elements must be path strings',
              value
            })
            break
          }
          if (param.validation?.type === 'path') {
            const result = validatePath(v, param.validation.mustExist ?? false, basePath)
            if (!result.valid) {
              errors.push({
                parameter: param.name,
                message: result.error!,
                value: v
              })
            }
          }
        }
      }
      break
  }

  // Regex validation
  if (param.validation?.type === 'regex' && typeof value === 'string') {
    const regex = new RegExp(param.validation.pattern)
    if (!regex.test(value)) {
      errors.push({
        parameter: param.name,
        message: `Value does not match pattern: ${param.validation.pattern}`,
        value
      })
    }
  }

  return errors
}

// ============================================================================
// Template Resolution
// ============================================================================

/**
 * Check if a template is parameterized
 */
export function isParameterizedTemplate(
  template: ConfigTemplate
): template is typeof ParameterizedConfigTemplateSchema._type {
  return template.type === 'parameterized'
}

/**
 * Check if a template is simple
 */
export function isSimpleTemplate(
  template: ConfigTemplate
): template is typeof SimpleConfigTemplateSchema._type {
  return template.type === 'simple'
}

/**
 * Get required parameters from a template
 */
export function getRequiredParameters(template: ConfigTemplate): TemplateParameter[] {
  if (isSimpleTemplate(template)) {
    return []
  }
  return template.parameters.filter(p => p.required)
}

/**
 * Get all parameters from a template (including optional)
 */
export function getAllParameters(template: ConfigTemplate): TemplateParameter[] {
  if (isSimpleTemplate(template)) {
    return []
  }
  return template.parameters
}

/**
 * Resolve a template with user-provided values
 *
 * @param template - The config template to resolve
 * @param values - User-provided parameter values
 * @param basePath - Base path for resolving relative paths (default: process.cwd())
 * @returns Resolved MCP server config
 * @throws Error if validation fails
 */
export function resolveTemplate(
  template: ConfigTemplate,
  values: ParameterValues = {},
  basePath: string = process.cwd()
): ResolvedTemplate {
  const warnings: string[] = []

  // Simple templates don't need resolution
  if (isSimpleTemplate(template)) {
    const config: MCPServerConfig = {
      id: template.id,
      name: template.name,
      transport: template.transport,
      permissions: template.permissions,
      budgets: template.budgets,
      toolPrefix: template.toolPrefix,
      connectTimeout: template.connectTimeout,
      autoReconnect: template.autoReconnect
    }

    // Clean up undefined fields
    const cleanedConfig = cleanUndefinedFields(config)

    return { config: cleanedConfig, warnings }
  }

  // Parameterized template - validate and resolve
  const allErrors: ParameterValidationError[] = []

  // Apply defaults for missing optional parameters
  const resolvedValues: ParameterValues = { ...values }
  for (const param of template.parameters) {
    if (resolvedValues[param.name] === undefined && param.default !== undefined) {
      resolvedValues[param.name] = param.default
    }
  }

  // Validate all parameters
  for (const param of template.parameters) {
    const errors = validateParameter(param, resolvedValues[param.name], basePath)
    allErrors.push(...errors)
  }

  if (allErrors.length > 0) {
    const errorMessages = allErrors.map(e => `  - ${e.parameter}: ${e.message}`).join('\n')
    throw new Error(`Template parameter validation failed:\n${errorMessages}`)
  }

  // Build the transport args
  const args: string[] = [...(template.transport.baseArgs || [])]

  // Add parameter values to args
  for (const param of template.parameters) {
    const value = resolvedValues[param.name]
    if (value === undefined) continue

    if (Array.isArray(value)) {
      // For array parameters, add each value as a separate arg
      for (const v of value) {
        args.push(resolve(basePath, v))
      }
    } else {
      // For single values, add directly
      args.push(resolve(basePath, value))
    }
  }

  // Build the final config
  const transport: MCPStdioConfig = {
    type: 'stdio',
    command: template.transport.command,
    args,
    cwd: template.transport.cwd,
    env: template.transport.env
  }

  // Clean up undefined transport fields
  if (transport.cwd === undefined) delete transport.cwd
  if (transport.env === undefined) delete transport.env

  const config: MCPServerConfig = {
    id: template.id,
    name: template.name,
    transport,
    permissions: template.permissions,
    budgets: template.budgets,
    toolPrefix: template.toolPrefix,
    connectTimeout: template.connectTimeout,
    autoReconnect: template.autoReconnect
  }

  // Clean up undefined config fields
  const cleanedConfig = cleanUndefinedFields(config)

  return { config: cleanedConfig, warnings }
}

/**
 * Create a prompt message for a parameter
 */
export function getParameterPrompt(param: TemplateParameter): string {
  let prompt = param.description

  if (param.default !== undefined) {
    const defaultStr = Array.isArray(param.default)
      ? param.default.join(', ')
      : param.default
    prompt += ` (default: ${defaultStr})`
  }

  if (param.required) {
    prompt += ' [required]'
  }

  return prompt
}

/**
 * Parse a user input string into a parameter value
 * Handles array parameters by splitting on comma/space
 */
export function parseParameterInput(
  param: TemplateParameter,
  input: string
): string | string[] {
  const trimmed = input.trim()

  // Use default if empty
  if (trimmed === '' && param.default !== undefined) {
    return param.default
  }

  // Array types
  if (param.type === 'string[]' || param.type === 'path[]') {
    // Split on comma or whitespace
    return trimmed
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  return trimmed
}
