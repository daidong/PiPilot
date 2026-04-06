/**
 * Environment Model — static profiling + MLX detection + agent guidance.
 *
 * Probed once at startup, cached for the session.
 * No LLM calls — pure system introspection.
 */

import os from 'node:os'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GpuInfo {
  type: 'apple_silicon' | 'nvidia' | 'none'
  model: string
  memoryMb?: number
  mlxAvailable: boolean
  mlxPackages: string[]
  cudaAvailable: boolean
  metalAvailable: boolean
}

export interface StaticProfile {
  os: 'darwin' | 'linux' | 'other'
  arch: string
  cpuCores: number
  cpuModel: string
  totalMemoryMb: number
  gpu: GpuInfo
  pythonVersion: string
  pipPackages: string[]
  dockerAvailable: boolean
}

// ---------------------------------------------------------------------------
// Probing functions
// ---------------------------------------------------------------------------

async function probePython(): Promise<{ version: string; packages: string[] }> {
  let version = 'unknown'
  try {
    const { stdout } = await execFileAsync('python3', ['--version'], { timeout: 5000 })
    version = stdout.trim().replace('Python ', '')
  } catch { /* ignore */ }

  let packages: string[] = []
  try {
    const { stdout } = await execFileAsync('python3', ['-m', 'pip', 'list', '--format=json'], { timeout: 15000 })
    const parsed = JSON.parse(stdout) as Array<{ name: string; version: string }>
    packages = parsed.map(p => p.name.toLowerCase())
  } catch {
    // Try without -m
    try {
      const { stdout } = await execFileAsync('pip3', ['list', '--format=json'], { timeout: 15000 })
      const parsed = JSON.parse(stdout) as Array<{ name: string; version: string }>
      packages = parsed.map(p => p.name.toLowerCase())
    } catch { /* no pip available */ }
  }

  return { version, packages }
}

async function probeGpu(pipPackages: string[]): Promise<GpuInfo> {
  const platform = os.platform()
  const arch = os.arch()

  // Apple Silicon detection
  if (platform === 'darwin' && arch === 'arm64') {
    // Check MLX availability
    let mlxAvailable = false
    const mlxPackages: string[] = []
    const mlxRelated = ['mlx', 'mlx-nn', 'mlx-data', 'mlx-lm', 'mlx-optimizers', 'mlx-audio', 'mlx-vlm']
    for (const pkg of mlxRelated) {
      if (pipPackages.includes(pkg)) {
        mlxPackages.push(pkg)
      }
    }
    // Verify mlx actually imports
    if (pipPackages.includes('mlx')) {
      try {
        await execFileAsync('python3', ['-c', 'import mlx; print(mlx.__version__)'], { timeout: 10000 })
        mlxAvailable = true
      } catch { /* installed but broken */ }
    }

    // Get chip model
    let model = 'Apple Silicon'
    try {
      const output = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8', timeout: 3000 }).trim()
      if (output) model = output
    } catch { /* use default */ }

    return {
      type: 'apple_silicon',
      model,
      memoryMb: Math.round(os.totalmem() / (1024 * 1024)), // Unified memory
      mlxAvailable,
      mlxPackages,
      cudaAvailable: false,
      metalAvailable: true,
    }
  }

  // NVIDIA GPU detection (Linux)
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 })
    const parts = stdout.trim().split(',').map(s => s.trim())
    return {
      type: 'nvidia',
      model: parts[0] ?? 'NVIDIA GPU',
      memoryMb: parseInt(parts[1] ?? '0', 10) || undefined,
      mlxAvailable: false,
      mlxPackages: [],
      cudaAvailable: true,
      metalAvailable: false,
    }
  } catch { /* no nvidia-smi */ }

  return {
    type: 'none',
    model: 'No GPU detected',
    mlxAvailable: false,
    mlxPackages: [],
    cudaAvailable: false,
    metalAvailable: false,
  }
}

async function probeDocker(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Main probe
// ---------------------------------------------------------------------------

let cachedProfile: StaticProfile | null = null

/**
 * Probe the system and return a static profile. Cached after first call.
 */
export async function probeStaticProfile(): Promise<StaticProfile> {
  if (cachedProfile) return cachedProfile

  const [python, docker] = await Promise.all([
    probePython(),
    probeDocker(),
  ])

  const gpu = await probeGpu(python.packages)

  const platform = os.platform()

  cachedProfile = {
    os: platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : 'other',
    arch: os.arch(),
    cpuCores: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? 'Unknown CPU',
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    gpu,
    pythonVersion: python.version,
    pipPackages: python.packages,
    dockerAvailable: docker,
  }

  return cachedProfile
}

/**
 * Reset cached profile (for testing or after environment changes).
 */
export function resetProfileCache(): void {
  cachedProfile = null
}

// ---------------------------------------------------------------------------
// Agent Guidance Generation
// ---------------------------------------------------------------------------

/**
 * Generate agent guidance text for system prompt injection.
 * Tells the agent what's available so it writes compatible code.
 */
export function generateAgentGuidance(profile: StaticProfile): string {
  const lines: string[] = []

  lines.push('## Local Compute Environment')
  lines.push('')
  lines.push(`Machine: ${profile.os} ${profile.arch}, ${profile.cpuCores} CPU cores, ${profile.totalMemoryMb}MB RAM`)
  lines.push(`Python: ${profile.pythonVersion}`)

  // GPU / MLX guidance
  if (profile.gpu.type === 'apple_silicon') {
    lines.push(`GPU: ${profile.gpu.model} (${profile.gpu.memoryMb}MB unified memory, Metal available)`)
    if (profile.gpu.mlxAvailable) {
      lines.push('')
      lines.push('### MLX Acceleration Available')
      lines.push(`Installed MLX packages: ${profile.gpu.mlxPackages.join(', ')}`)
      lines.push('When writing ML training code for local_compute_execute:')
      lines.push('- Prefer mlx over PyTorch/TensorFlow for training — native Metal acceleration, no CUDA needed')
      lines.push('- Use mlx.core.array for GPU-accelerated array operations')
      lines.push('- Check mlx-community on HuggingFace for MLX-converted model weights')
      lines.push('- mlx uses lazy evaluation — call mx.eval() to force computation')
      lines.push('- mlx supports 4-bit quantization via mlx-lm for large models')
    } else {
      lines.push('')
      lines.push('MLX is NOT installed. For Apple Silicon ML acceleration, install: pip install mlx mlx-nn')
      lines.push('Without MLX, PyTorch MPS backend is available for GPU-accelerated training on Apple Silicon.')
    }
  } else if (profile.gpu.type === 'nvidia') {
    lines.push(`GPU: ${profile.gpu.model}${profile.gpu.memoryMb ? ` (${profile.gpu.memoryMb}MB VRAM)` : ''}, CUDA available`)
    lines.push('PyTorch/TensorFlow can use CUDA acceleration.')
  } else {
    lines.push('GPU: None detected. ML training will use CPU only.')
    lines.push('Consider using smaller models/datasets, or running on a machine with a GPU.')
  }

  // Docker
  if (profile.dockerAvailable) {
    lines.push('')
    lines.push('Docker: Available. Can use docker sandbox for stronger isolation.')
  }

  // Sandbox guidance
  lines.push('')
  lines.push('### Sandbox Guidelines')
  lines.push('When writing scripts for local_compute_execute:')
  lines.push('- All required packages must be importable (preflight checks imports before running)')
  lines.push('- For long-running tasks, consider adding a --smoke flag for quick validation')
  lines.push('- Print progress lines: ##PROGRESS## {"step": N, "total": M, "loss": 0.85, "phase": "training"}')
  lines.push('- Write output files to the working directory (results, figures, checkpoints)')

  return lines.join('\n')
}
