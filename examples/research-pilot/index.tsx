/**
 * Research Pilot - Ink UI Entry Point
 *
 * A research assistant that exercises the Context Assembly Pipeline (RFC-003):
 * - 5-Phase Context Pipeline: System -> Pinned -> Selected -> Session -> Index
 * - Multi-Agent Team: Coordinator, LiteratureAgent, WritingAgent, DataAgent
 * - Research Entities: Notes, Literature, Data with provenance tracking
 * - Disk-as-Memory: All state persisted to JSON files
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/research-pilot/index.tsx
 *   npx tsx examples/research-pilot/index.tsx --debug
 */

import React from 'react'
import { render } from 'ink'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { App } from './ui/App.js'
import { PATHS, ProjectConfig } from './types.js'

// Initialize project directory structure
function initializeProject(projectPath: string): void {
  const dirs = [PATHS.root, PATHS.notes, PATHS.literature, PATHS.data, PATHS.sessions]

  for (const dir of dirs) {
    const fullPath = join(projectPath, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }
  }

  const projectFile = join(projectPath, PATHS.project)
  if (!existsSync(projectFile)) {
    const defaultConfig: ProjectConfig = {
      name: 'Research Project',
      description: 'A new research project',
      questions: [],
      userCorrections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeFileSync(projectFile, JSON.stringify(defaultConfig, null, 2))
  }
}

// Main
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('Error: OPENAI_API_KEY environment variable is required')
  console.error('  export OPENAI_API_KEY=sk-xxx')
  process.exit(1)
}

const args = process.argv.slice(2)
const debug = args.includes('--debug')
const projectPath = process.cwd()
const sessionId = crypto.randomUUID()

initializeProject(projectPath)

render(
  React.createElement(App, { apiKey, projectPath, debug, sessionId })
)
