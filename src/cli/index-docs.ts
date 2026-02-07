/**
 * index-docs CLI Command
 *
 * Builds document index for the docs context sources.
 * Scans specified directories for documents, extracts metadata,
 * chunks content, and builds inverted keyword index.
 */

import { FileDocsIndexer } from '../core/docs-indexer.js'
import * as path from 'node:path'
import { FRAMEWORK_DIR } from '../constants.js'

export interface IndexDocsOptions {
  paths?: string[]
  extensions?: string[]
  exclude?: string[]
  chunkSize?: number
  chunkOverlap?: number
  outputDir?: string
  incremental?: boolean
  verbose?: boolean
}

/**
 * Parse command line arguments for index-docs command
 */
export function parseIndexDocsArgs(args: string[]): IndexDocsOptions {
  const options: IndexDocsOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--paths':
      case '-p':
        if (args[i + 1]) {
          options.paths = args[++i]!.split(',').map(s => s.trim())
        }
        break

      case '--ext':
      case '-e':
        if (args[i + 1]) {
          options.extensions = args[++i]!.split(',').map(s => {
            const ext = s.trim()
            return ext.startsWith('.') ? ext : `.${ext}`
          })
        }
        break

      case '--exclude':
      case '-x':
        if (args[i + 1]) {
          options.exclude = args[++i]!.split(',').map(s => s.trim())
        }
        break

      case '--chunk-size':
        if (args[i + 1]) {
          options.chunkSize = parseInt(args[++i]!, 10)
        }
        break

      case '--overlap':
        if (args[i + 1]) {
          options.chunkOverlap = parseInt(args[++i]!, 10)
        }
        break

      case '--output':
      case '-o':
        if (args[i + 1]) {
          options.outputDir = args[++i]
        }
        break

      case '--incremental':
      case '-i':
        options.incremental = true
        break

      case '-v':
      case '--verbose':
        options.verbose = true
        break
    }
  }

  return options
}

/**
 * Run the index-docs command
 */
export async function runIndexDocs(options: IndexDocsOptions): Promise<void> {
  const projectPath = process.cwd()
  const verbose = options.verbose ?? false

  // Default paths
  const paths = options.paths ?? ['./docs']
  const extensions = options.extensions ?? ['.md', '.txt']
  const exclude = options.exclude ?? []
  const chunkSize = options.chunkSize ?? 500
  const chunkOverlap = options.chunkOverlap ?? 50
  const outputDir = options.outputDir ?? FRAMEWORK_DIR
  const incremental = options.incremental ?? false

  console.log('📚 Building document index...')
  console.log('')

  if (verbose) {
    console.log('Configuration:')
    console.log(`  Project path: ${projectPath}`)
    console.log(`  Document paths: ${paths.join(', ')}`)
    console.log(`  Extensions: ${extensions.join(', ')}`)
    console.log(`  Exclude patterns: ${exclude.length > 0 ? exclude.join(', ') : '(none)'}`)
    console.log(`  Chunk size: ${chunkSize} tokens`)
    console.log(`  Chunk overlap: ${chunkOverlap} tokens`)
    console.log(`  Output directory: ${outputDir}`)
    console.log(`  Incremental: ${incremental}`)
    console.log('')
  }

  const indexer = new FileDocsIndexer(projectPath)

  try {
    const index = await indexer.build({
      paths,
      extensions,
      exclude,
      chunkSize,
      chunkOverlap,
      outputDir,
      incremental,
      verbose
    })

    console.log('')
    console.log('✅ Index built successfully!')
    console.log('')
    console.log('Summary:')
    console.log(`  Documents: ${index.stats.totalDocuments}`)
    console.log(`  Chunks: ${index.stats.totalChunks}`)
    console.log(`  Tokens: ${index.stats.totalTokens}`)
    console.log(`  By type: ${Object.entries(index.stats.byType).map(([t, c]) => `${t}(${c})`).join(', ')}`)
    console.log('')
    console.log(`Index saved to: ${path.join(projectPath, outputDir, 'docs_index.json')}`)
    console.log('')
    console.log('Usage:')
    console.log('  ctx.get("docs.index")              - List all documents')
    console.log('  ctx.get("docs.search", { query })  - Search documents')
    console.log('  ctx.get("docs.open", { path })     - Read document content')
  } catch (error) {
    console.error('')
    console.error(`❌ Failed to build index: ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * Print help for index-docs command
 */
export function printIndexDocsHelp(): void {
  console.log(`
index-docs - Build document index for docs context sources

Usage:
  agent-foundry index-docs [options]

Options:
  --paths, -p <dirs>      Document directories, comma-separated (default: ./docs)
  --ext, -e <exts>        File extensions, comma-separated (default: .md,.txt)
  --exclude, -x <globs>   Exclude patterns, comma-separated
  --chunk-size <n>        Chunk size in tokens (default: 500)
  --overlap <n>           Chunk overlap in tokens (default: 50)
  --output, -o <dir>      Output directory (default: .agentfoundry)
  --incremental, -i       Incremental update mode
  --verbose, -v           Verbose output

Examples:
  # Index docs directory
  $ agent-foundry index-docs

  # Index multiple directories
  $ agent-foundry index-docs --paths docs,wiki,notes

  # Index only markdown files
  $ agent-foundry index-docs --ext .md

  # Incremental update with verbose output
  $ agent-foundry index-docs --incremental --verbose

  # Custom chunk size
  $ agent-foundry index-docs --chunk-size 300 --overlap 30
`)
}
