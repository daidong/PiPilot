/**
 * Sandbox auto-detection — probes available providers and returns the best one.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SandboxProvider } from '../types.js'
import { ProcessSandbox } from './process-sandbox.js'

const execFileAsync = promisify(execFile)

let cachedProviders: SandboxProvider[] | null = null
let dockerAvailable: boolean | null = null

/**
 * Check if Docker is available and responsive.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 })
    dockerAvailable = true
  } catch {
    dockerAvailable = false
  }
  return dockerAvailable
}

/**
 * Get all available sandbox providers, ordered by preference.
 * Process sandbox is always available as fallback.
 */
export async function detectProviders(): Promise<SandboxProvider[]> {
  if (cachedProviders) return cachedProviders

  const providers: SandboxProvider[] = []

  // Docker: v2.0 (placeholder check for availability detection)
  // const docker = await isDockerAvailable()
  // if (docker) providers.push(new DockerSandbox())

  // Process: always available
  providers.push(new ProcessSandbox())

  cachedProviders = providers
  return providers
}

/**
 * Get the best available provider, or a specific one by name.
 */
export async function getProvider(
  preference?: 'docker' | 'process' | 'auto'
): Promise<SandboxProvider> {
  const providers = await detectProviders()

  if (preference && preference !== 'auto') {
    const match = providers.find(p => p.name === preference)
    if (match) return match
    // Fall through to default if requested provider unavailable
  }

  // Return first available (ordered by preference)
  return providers[0]
}

/**
 * Reset cached detection (for testing or after environment changes).
 */
export function resetDetectionCache(): void {
  cachedProviders = null
  dockerAvailable = null
}
