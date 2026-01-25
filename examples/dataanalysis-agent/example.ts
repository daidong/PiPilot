/**
 * Data Analysis Multi-Agent Team Example
 *
 * Demonstrates how to use the data analysis team to process
 * analytical queries using a plan-execute-review workflow.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx ts-node examples/dataanalysis-agent/example.ts
 */

import { createDataAnalysisTeam } from './index.js'
import type { ProgressInfo } from './types.js'

// ============================================================================
// Progress Logger
// ============================================================================

function createProgressLogger(): (info: ProgressInfo) => void {
  const startTime = Date.now()

  return (info: ProgressInfo) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const step = info.step !== undefined ? ` [Step ${info.step}]` : ''
    console.log(`[${elapsed}s] [${info.agent}]${step} ${info.status}`)
  }
}

// ============================================================================
// Result Formatter
// ============================================================================

function formatResult(result: { success: boolean; output: unknown; error?: string; steps: number; durationMs: number }) {
  console.log('\n' + '='.repeat(60))
  console.log('ANALYSIS RESULT')
  console.log('='.repeat(60))

  if (result.success) {
    console.log('Status: SUCCESS')
    console.log(`Steps: ${result.steps}`)
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`)
    console.log('\nOutput:')
    console.log('-'.repeat(40))

    // Try to pretty-print JSON output
    const output = result.output
    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output)
        console.log(JSON.stringify(parsed, null, 2))
      } catch {
        console.log(output)
      }
    } else {
      console.log(JSON.stringify(output, null, 2))
    }
  } else {
    console.log('Status: FAILED')
    console.log(`Error: ${result.error ?? 'Unknown error'}`)
    console.log(`Steps completed: ${result.steps}`)
  }

  console.log('='.repeat(60))
}

// ============================================================================
// Main Example
// ============================================================================

async function main() {
  // Get API key from environment
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('Error: Please set OPENAI_API_KEY environment variable')
    console.error('  export OPENAI_API_KEY=sk-xxx')
    process.exit(1)
  }

  console.log('Creating Data Analysis Team...\n')

  // Create the team with optional database configuration
  const team = createDataAnalysisTeam({
    apiKey,
    projectPath: process.cwd(),
    databases: {
      // Example SQLite database (would need to exist for actual analysis)
      sales: {
        type: 'sqlite',
        path: './data/sales.db'
      }
    },
    maxReviewIterations: 3,
    onProgress: createProgressLogger()
  })

  // Sample analysis requests
  const sampleRequests = [
    `Analyze the following sample data and provide insights:
    - Product A: Q1=$10K, Q2=$12K, Q3=$15K, Q4=$18K
    - Product B: Q1=$8K, Q2=$7K, Q3=$9K, Q4=$11K
    - Product C: Q1=$20K, Q2=$22K, Q3=$19K, Q4=$25K

    Questions:
    1. Which product had the highest total annual revenue?
    2. Which product showed the most consistent growth?
    3. What was the overall trend across all products?`,

    `Create a summary analysis of file patterns in the current directory.
    Include: file count by extension, largest files, and any patterns observed.`
  ]

  try {
    // Run the first sample request
    console.log('Running analysis...')
    console.log('-'.repeat(60))
    console.log('Request:', sampleRequests[0].substring(0, 100) + '...')
    console.log('-'.repeat(60))
    console.log('')

    const result = await team.analyze(sampleRequests[0])
    formatResult(result)

    // Show final state
    console.log('\nFinal Team State:')
    const state = team.getState()
    console.log('Keys:', Object.keys(state))

  } catch (error) {
    console.error('Analysis failed with error:', error)
  } finally {
    // Clean up
    console.log('\nCleaning up...')
    await team.destroy()
    console.log('Done.')
  }
}

// ============================================================================
// Run if executed directly
// ============================================================================

// Check if this file is being run directly
if (process.argv[1]?.includes('dataanalysis-agent/example')) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

export { main }
