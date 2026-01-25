/**
 * Schema Utilities - Zod Schema Normalization for Structured Outputs
 *
 * OpenAI's Structured Outputs have JSON Schema restrictions that can cause
 * issues with certain Zod constructs. This module provides utilities to
 * normalize schemas for maximum compatibility.
 *
 * Key Issues:
 * - `z.optional()` generates JSON Schema that OpenAI may reject
 * - Use `z.nullable()` or provide explicit defaults instead
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 */

import { z, type ZodTypeAny, type ZodObject, type ZodRawShape } from 'zod'

// ============================================================================
// Types
// ============================================================================

/**
 * Schema compatibility issue found during analysis
 */
export interface SchemaIssue {
  path: string
  type: 'optional' | 'union' | 'transform' | 'effect' | 'unknown'
  message: string
  suggestion: string
}

/**
 * Result of schema analysis
 */
export interface SchemaAnalysisResult {
  compatible: boolean
  issues: SchemaIssue[]
}

// ============================================================================
// Bounded Array Helper
// ============================================================================

/**
 * Create a bounded array schema with max length constraint.
 * Helps prevent token explosion in multi-agent pipelines.
 *
 * @example
 * ```typescript
 * const SummarySchema = z.object({
 *   papers: boundedArray(PaperSchema, 20),
 *   themes: boundedArray(z.string(), 6),
 *   findings: boundedArray(FindingSchema, 8)
 * })
 * ```
 */
export function boundedArray<T extends ZodTypeAny>(
  schema: T,
  maxLength: number,
  minLength: number = 0
): z.ZodArray<T> {
  return z.array(schema).min(minLength).max(maxLength)
}

// ============================================================================
// Schema Analysis
// ============================================================================

/**
 * Analyze a Zod schema for OpenAI Structured Outputs compatibility.
 *
 * @example
 * ```typescript
 * const result = analyzeSchema(MySchema)
 * if (!result.compatible) {
 *   console.warn('Schema issues:', result.issues)
 * }
 * ```
 */
export function analyzeSchema(schema: ZodTypeAny, path: string = ''): SchemaAnalysisResult {
  const issues: SchemaIssue[] = []

  function analyze(s: ZodTypeAny, currentPath: string): void {
    const typeName = s._def.typeName

    switch (typeName) {
      case 'ZodOptional':
        issues.push({
          path: currentPath || 'root',
          type: 'optional',
          message: 'Optional fields may not be compatible with OpenAI Structured Outputs',
          suggestion: 'Use z.nullable() instead, or provide a default value with z.default()'
        })
        // Analyze the inner type
        if (s._def.innerType) {
          analyze(s._def.innerType, currentPath)
        }
        break

      case 'ZodUnion':
        // Unions other than nullable are problematic
        const options = s._def.options as ZodTypeAny[]
        const isNullable = options.length === 2 &&
          options.some((o: ZodTypeAny) => o._def.typeName === 'ZodNull')
        if (!isNullable) {
          issues.push({
            path: currentPath || 'root',
            type: 'union',
            message: 'Union types (except nullable) may cause issues',
            suggestion: 'Consider using z.discriminatedUnion() or restructure as separate fields'
          })
        }
        options.forEach((opt: ZodTypeAny, i: number) => analyze(opt, `${currentPath}[${i}]`))
        break

      case 'ZodObject':
        const shape = (s as ZodObject<ZodRawShape>).shape
        for (const [key, value] of Object.entries(shape)) {
          analyze(value as ZodTypeAny, currentPath ? `${currentPath}.${key}` : key)
        }
        break

      case 'ZodArray':
        if (s._def.type) {
          analyze(s._def.type, `${currentPath}[]`)
        }
        break

      case 'ZodNullable':
        // Nullable is fine, analyze inner type
        if (s._def.innerType) {
          analyze(s._def.innerType, currentPath)
        }
        break

      case 'ZodDefault':
        // Default is fine, analyze inner type
        if (s._def.innerType) {
          analyze(s._def.innerType, currentPath)
        }
        break

      case 'ZodEffects':
        issues.push({
          path: currentPath || 'root',
          type: 'effect',
          message: 'Zod effects (transform, refine, preprocess) are not supported in JSON Schema',
          suggestion: 'Move transformations to post-processing in your agent'
        })
        if (s._def.schema) {
          analyze(s._def.schema, currentPath)
        }
        break

      case 'ZodTransformer':
        issues.push({
          path: currentPath || 'root',
          type: 'transform',
          message: 'Zod transforms are not supported in JSON Schema',
          suggestion: 'Move transformations to post-processing in your agent'
        })
        break

      // Primitive types and other supported types - no issues
      case 'ZodString':
      case 'ZodNumber':
      case 'ZodBoolean':
      case 'ZodNull':
      case 'ZodLiteral':
      case 'ZodEnum':
      case 'ZodNativeEnum':
      case 'ZodRecord':
      case 'ZodTuple':
        // These are generally compatible
        break

      default:
        // Unknown type - might have issues
        if (typeName && !['ZodAny', 'ZodUnknown', 'ZodVoid', 'ZodNever'].includes(typeName)) {
          // Only warn about truly unknown types
        }
    }
  }

  analyze(schema, path)

  return {
    compatible: issues.length === 0,
    issues
  }
}

// ============================================================================
// Schema Helpers for Compatibility
// ============================================================================

/**
 * Create a nullable field that's compatible with OpenAI Structured Outputs.
 * Use this instead of z.optional() for optional fields.
 *
 * @example
 * ```typescript
 * const PaperSchema = z.object({
 *   title: z.string(),
 *   abstract: nullable(z.string()),  // Instead of z.string().optional()
 *   year: nullable(z.number())
 * })
 * ```
 */
export function nullable<T extends ZodTypeAny>(schema: T): z.ZodNullable<T> {
  return schema.nullable()
}

/**
 * Create an optional field with a default value.
 * This is compatible with OpenAI Structured Outputs.
 *
 * @example
 * ```typescript
 * const ConfigSchema = z.object({
 *   maxResults: withDefault(z.number(), 10),
 *   includeAbstract: withDefault(z.boolean(), true)
 * })
 * ```
 */
export function withDefault<T extends ZodTypeAny>(
  schema: T,
  defaultValue: z.infer<T>
): z.ZodDefault<T> {
  return schema.default(defaultValue)
}

/**
 * Create a string enum that's compatible with OpenAI Structured Outputs.
 *
 * @example
 * ```typescript
 * const StatusSchema = stringEnum(['pending', 'approved', 'rejected'])
 * ```
 */
export function stringEnum<T extends readonly [string, ...string[]]>(
  values: T
): z.ZodEnum<[T[number], ...T[number][]]> {
  return z.enum(values as unknown as [T[number], ...T[number][]])
}

// ============================================================================
// Validation Helper
// ============================================================================

/**
 * Validate a schema and throw if there are compatibility issues.
 * Use this during development to catch issues early.
 *
 * @example
 * ```typescript
 * const MySchema = z.object({...})
 * assertSchemaCompatible(MySchema, 'MySchema')  // Throws if issues found
 * ```
 */
export function assertSchemaCompatible(
  schema: ZodTypeAny,
  schemaName: string = 'Schema'
): void {
  const result = analyzeSchema(schema)
  if (!result.compatible) {
    const issueMessages = result.issues
      .map(i => `  - ${i.path}: ${i.message}\n    Suggestion: ${i.suggestion}`)
      .join('\n')
    throw new Error(
      `${schemaName} has compatibility issues with OpenAI Structured Outputs:\n${issueMessages}`
    )
  }
}

/**
 * Log warnings for schema compatibility issues without throwing.
 *
 * @example
 * ```typescript
 * const MySchema = z.object({...})
 * warnSchemaIssues(MySchema, 'MySchema')  // Logs warnings if issues found
 * ```
 */
export function warnSchemaIssues(
  schema: ZodTypeAny,
  schemaName: string = 'Schema'
): SchemaAnalysisResult {
  const result = analyzeSchema(schema)
  if (!result.compatible) {
    console.warn(`[schema-utils] ${schemaName} has potential compatibility issues:`)
    for (const issue of result.issues) {
      console.warn(`  - ${issue.path}: ${issue.message}`)
      console.warn(`    Suggestion: ${issue.suggestion}`)
    }
  }
  return result
}
