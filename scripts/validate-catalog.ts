#!/usr/bin/env npx ts-node --esm
/**
 * Catalog Validation Script
 *
 * Validates the MCP and Tool catalogs by checking:
 * 1. npm package existence and published versions
 * 2. Documentation link accessibility (HTTP 200)
 * 3. Entry staleness (lastVerified > 90 days)
 * 4. Required fields completeness
 *
 * Usage:
 *   npm run validate-catalog
 *   npm run validate-catalog -- --fix-dates  # Update lastVerified for valid entries
 *
 * Exit codes:
 *   0 - All validations passed
 *   1 - Some validations failed (see report)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ============================================================================
// Types
// ============================================================================

interface ValidationResult {
  name: string
  package: string
  checks: {
    npmExists: boolean | null
    npmVersion: string | null
    docLinkValid: boolean | null
    notStale: boolean
    hasRequiredFields: boolean
  }
  errors: string[]
  warnings: string[]
}

interface ValidationReport {
  timestamp: string
  totalEntries: number
  passed: number
  failed: number
  warnings: number
  results: ValidationResult[]
}

interface MCPEntry {
  name: string
  package: string
  documentation: string
  lastVerified?: string
  platform?: string[]
  envVars?: string[]
  permissions?: unknown[]
  [key: string]: unknown
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Max age in days before an entry is considered stale
  maxStaleDays: 90,
  // Timeout for HTTP requests in ms
  httpTimeout: 10000,
  // Timeout for npm registry requests in ms
  npmTimeout: 15000,
  // npm registry URL
  npmRegistry: 'https://registry.npmjs.org',
  // Concurrent request limit
  concurrency: 5,
  // Required fields for MCP entries
  requiredFields: ['name', 'package', 'description', 'category', 'keywords', 'useCases', 'popularity', 'riskLevel', 'configTemplate', 'installCommand', 'documentation', 'permissions']
}

// ============================================================================
// Helpers
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
}

function log(msg: string, color?: keyof typeof colors): void {
  if (color) {
    console.log(`${colors[color]}${msg}${colors.reset}`)
  } else {
    console.log(msg)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check if an npm package exists and get its latest version
 */
async function checkNpmPackage(packageName: string): Promise<{ exists: boolean; version: string | null; error?: string }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONFIG.npmTimeout)

    const response = await fetch(`${CONFIG.npmRegistry}/${packageName}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    })

    clearTimeout(timeout)

    if (response.status === 404) {
      return { exists: false, version: null, error: 'Package not found on npm' }
    }

    if (!response.ok) {
      return { exists: false, version: null, error: `npm registry returned ${response.status}` }
    }

    const data = await response.json() as { 'dist-tags'?: { latest?: string } }
    const version = data['dist-tags']?.latest || null

    return { exists: true, version }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message.includes('abort')) {
      return { exists: false, version: null, error: 'npm request timed out' }
    }
    return { exists: false, version: null, error: message }
  }
}

/**
 * Check if a documentation URL is accessible
 */
async function checkDocumentationLink(url: string): Promise<{ valid: boolean; status?: number; error?: string }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeout)

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    })

    clearTimeout(timeout)

    if (response.ok) {
      return { valid: true, status: response.status }
    }

    // Some servers don't support HEAD, try GET
    if (response.status === 405) {
      const getResponse = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow'
      })
      return { valid: getResponse.ok, status: getResponse.status }
    }

    return { valid: false, status: response.status, error: `HTTP ${response.status}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message.includes('abort')) {
      return { valid: false, error: 'Request timed out' }
    }
    return { valid: false, error: message }
  }
}

/**
 * Check if an entry is stale (lastVerified > maxStaleDays)
 */
function checkStaleness(lastVerified?: string): { stale: boolean; daysSince?: number } {
  if (!lastVerified) {
    return { stale: true }
  }

  const verifiedDate = new Date(lastVerified)
  if (isNaN(verifiedDate.getTime())) {
    return { stale: true }
  }

  const daysSince = Math.floor((Date.now() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24))
  return { stale: daysSince > CONFIG.maxStaleDays, daysSince }
}

/**
 * Check if all required fields are present
 */
function checkRequiredFields(entry: MCPEntry): { valid: boolean; missing: string[] } {
  const missing: string[] = []

  for (const field of CONFIG.requiredFields) {
    if (entry[field] === undefined || entry[field] === null) {
      missing.push(field)
    }
  }

  return { valid: missing.length === 0, missing }
}

/**
 * Validate a single MCP entry
 */
async function validateEntry(entry: MCPEntry, skipNetwork: boolean): Promise<ValidationResult> {
  const result: ValidationResult = {
    name: entry.name,
    package: entry.package,
    checks: {
      npmExists: null,
      npmVersion: null,
      docLinkValid: null,
      notStale: false,
      hasRequiredFields: false
    },
    errors: [],
    warnings: []
  }

  // Check required fields
  const fieldCheck = checkRequiredFields(entry)
  result.checks.hasRequiredFields = fieldCheck.valid
  if (!fieldCheck.valid) {
    result.errors.push(`Missing required fields: ${fieldCheck.missing.join(', ')}`)
  }

  // Check staleness
  const staleCheck = checkStaleness(entry.lastVerified)
  result.checks.notStale = !staleCheck.stale
  if (staleCheck.stale) {
    if (staleCheck.daysSince !== undefined) {
      result.warnings.push(`Entry is stale (last verified ${staleCheck.daysSince} days ago)`)
    } else {
      result.warnings.push('Entry has no lastVerified date')
    }
  }

  // Network checks (can be skipped)
  if (!skipNetwork) {
    // Check npm package
    const npmCheck = await checkNpmPackage(entry.package)
    result.checks.npmExists = npmCheck.exists
    result.checks.npmVersion = npmCheck.version
    if (!npmCheck.exists) {
      result.errors.push(`npm package not found: ${npmCheck.error}`)
    }

    // Check documentation link
    const docCheck = await checkDocumentationLink(entry.documentation)
    result.checks.docLinkValid = docCheck.valid
    if (!docCheck.valid) {
      result.warnings.push(`Documentation link invalid: ${docCheck.error}`)
    }
  }

  return result
}

// ============================================================================
// Main Validation Logic
// ============================================================================

async function validateCatalog(options: { skipNetwork?: boolean; fixDates?: boolean }): Promise<ValidationReport> {
  const catalogPath = join(__dirname, '..', 'src', 'recommendation', 'data', 'mcp-catalog.yaml')

  log('\n📋 Loading MCP catalog...', 'cyan')
  const content = readFileSync(catalogPath, 'utf-8')
  const catalog = YAML.parse(content) as { entries: MCPEntry[] }

  const entries = catalog.entries
  log(`   Found ${entries.length} entries\n`)

  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    totalEntries: entries.length,
    passed: 0,
    failed: 0,
    warnings: 0,
    results: []
  }

  // Process entries with concurrency limit
  log('🔍 Validating entries...\n', 'cyan')

  const chunks: MCPEntry[][] = []
  for (let i = 0; i < entries.length; i += CONFIG.concurrency) {
    chunks.push(entries.slice(i, i + CONFIG.concurrency))
  }

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(entry => validateEntry(entry, options.skipNetwork ?? false))
    )
    report.results.push(...results)

    // Rate limiting between chunks
    if (!options.skipNetwork) {
      await sleep(500)
    }
  }

  // Count results
  for (const result of report.results) {
    if (result.errors.length > 0) {
      report.failed++
    } else {
      report.passed++
    }
    if (result.warnings.length > 0) {
      report.warnings++
    }
  }

  // Update lastVerified dates if requested
  if (options.fixDates) {
    const today = new Date().toISOString().split('T')[0]
    let updated = 0

    for (const result of report.results) {
      if (result.errors.length === 0 && result.checks.npmExists && result.checks.docLinkValid) {
        const entry = catalog.entries.find(e => e.name === result.name)
        if (entry) {
          entry.lastVerified = today
          updated++
        }
      }
    }

    if (updated > 0) {
      log(`\n📝 Updating ${updated} lastVerified dates...`, 'cyan')
      const updatedYaml = YAML.stringify(catalog, { lineWidth: 0 })
      writeFileSync(catalogPath, updatedYaml, 'utf-8')
      log(`   ✓ Updated ${catalogPath}`, 'green')
    }
  }

  return report
}

function printReport(report: ValidationReport): void {
  log('\n' + '='.repeat(60), 'dim')
  log('📊 VALIDATION REPORT', 'cyan')
  log('='.repeat(60) + '\n', 'dim')

  log(`Timestamp: ${report.timestamp}`)
  log(`Total entries: ${report.totalEntries}`)
  log(`Passed: ${report.passed}`, 'green')
  log(`Failed: ${report.failed}`, report.failed > 0 ? 'red' : 'green')
  log(`With warnings: ${report.warnings}`, report.warnings > 0 ? 'yellow' : 'green')

  // Print details for failed/warned entries
  const problematic = report.results.filter(r => r.errors.length > 0 || r.warnings.length > 0)

  if (problematic.length > 0) {
    log('\n' + '-'.repeat(60), 'dim')
    log('DETAILS\n', 'cyan')

    for (const result of problematic) {
      const status = result.errors.length > 0 ? '❌' : '⚠️'
      log(`${status} ${result.name} (${result.package})`)

      for (const error of result.errors) {
        log(`   ERROR: ${error}`, 'red')
      }
      for (const warning of result.warnings) {
        log(`   WARN: ${warning}`, 'yellow')
      }

      if (result.checks.npmVersion) {
        log(`   npm version: ${result.checks.npmVersion}`, 'dim')
      }
      log('')
    }
  }

  // Print passed entries summary
  const passed = report.results.filter(r => r.errors.length === 0 && r.warnings.length === 0)
  if (passed.length > 0) {
    log('-'.repeat(60), 'dim')
    log('PASSED ENTRIES\n', 'green')
    for (const result of passed) {
      const version = result.checks.npmVersion ? ` v${result.checks.npmVersion}` : ''
      log(`   ✓ ${result.name}${version}`, 'green')
    }
  }

  log('\n' + '='.repeat(60), 'dim')
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const skipNetwork = args.includes('--skip-network') || args.includes('--offline')
  const fixDates = args.includes('--fix-dates')

  log('\n🔧 MCP Catalog Validator', 'cyan')
  log('='.repeat(60), 'dim')

  if (skipNetwork) {
    log('⚡ Running in offline mode (skipping npm/HTTP checks)', 'yellow')
  }

  try {
    const report = await validateCatalog({ skipNetwork, fixDates })
    printReport(report)

    // Exit with error if any entries failed
    if (report.failed > 0) {
      log('\n❌ Validation failed - some entries have errors\n', 'red')
      process.exit(1)
    } else {
      log('\n✅ All entries validated successfully\n', 'green')
      process.exit(0)
    }
  } catch (error) {
    log(`\n❌ Validation error: ${error}`, 'red')
    process.exit(1)
  }
}

main()
