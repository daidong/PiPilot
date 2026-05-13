/**
 * Modal Compute Plan Agent
 *
 * Replaces the old profileTask + inferTaskKind + adviseImage pipeline with a
 * single tool-calling agent that reads the user's script to produce a task
 * profile and extract the script-declared Modal image/runtime configuration.
 *
 * The agent runs inside a temporary sandbox directory containing:
 *   - The submitted script (copied)
 *   - A task.md with command + description context
 *
 * It has three path-jailed tools (read_file, list_dir, grep) scoped to the
 * sandbox — it cannot access files outside it.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSandboxTools } from './sandbox-tools.js'
import { parseJsonFromLlm } from '../local-compute/task-profiler.js'
import type { ModalImageInspection, ModalPythonPackageInstaller, ModalTaskProfile } from './types.js'
import type { ResearchToolContext } from '../tools/types.js'

const SYSTEM_PROMPT = `You are a Modal compute planning agent. Your working directory contains:

- script: the submitted Modal script to run. Check the exact filename with list_dir.
- task.md: the command and task description.

Your job:
1. List the working directory to identify the script filename.
2. Read task.md and the script.
3. Analyze the compute task profile.
4. Extract the Modal image and GPU configuration declared by the script.
5. Output a single JSON block.

Task profile guidance:
- cpuDensity describes expected CPU intensity from the script structure: low for orchestration/light file operations, medium for moderate data processing, high for heavy numerical work, preprocessing, compilation, or parallel CPU loops.
- gpuDensity describes actual expected GPU use by the task: none when no GPU work is declared or apparent, light for inference/evaluation/small GPU kernels, heavy for training, fine-tuning, large batch inference, or long CUDA workloads.
- memoryPattern describes allocation behavior: constant for bounded working sets, growing for accumulating results/models/data in memory, spike for brief large loads such as model initialization or dataset materialization.
- ioPattern describes dominant filesystem/network I/O: read_heavy for dataset/model loading, write_heavy for checkpoints/exports, balanced for both, minimal for mostly compute.
- chunkable is true when the task can naturally split into independent batches, shards, files, or parameter ranges.
- resumable is true when the script appears able to continue after interruption via checkpoints, existing outputs, or idempotent batch progress.
- idempotent is true when rerunning should not corrupt state or duplicate external effects.
- hasExternalSideEffects is true for writes to external services, APIs, databases, cloud buckets, notifications, or irreversible actions.
- networkRequired is true when the script downloads data/models, calls APIs, accesses remote storage, or otherwise needs network access during execution.
- expectedDurationClass should be based on loops, epochs, data/model size clues, command/task description, and whether the script performs training, downloads, or large I/O.
- durationReasoning should explain the duration estimate specifically.

Extract these Modal image features when present:
- Base image constructors such as modal.Image.debian_slim(...), modal.Image.micromamba(...), or other modal.Image constructors.
- Python version from base image constructors.
- Python packages from .uv_pip_install(...), .pip_install(...), and .micromamba_install(...).
- System packages from .apt_install(...).
- Environment variable keys from .env({...}); include keys only.
- Local inputs from .add_local_dir(...), .add_local_file(...), and .add_local_python_source(...).
- Build commands from .run_commands(...).
- Build functions from .run_function(...).
- Build GPU resources passed to image build steps.
- Runtime GPU resources from @app.function(gpu=...), Modal function definitions, or Modal sandbox/function configuration.

GPU normalization:
- runtimeGpuType is the GPU declared for runtime execution.
- buildGpuType is the GPU declared only for image build steps.
- gpuType is the GPU used for cost estimation. Prefer runtimeGpuType. If multiple runtime GPUs are declared, choose the highest-cost GPU and add a warning. If no runtime GPU is declared, set gpuType to null.

Output ONLY this JSON shape:

\`\`\`json
{
  "taskProfile": {
    "cpuDensity": "low" | "medium" | "high",
    "gpuDensity": "none" | "light" | "heavy",
    "memoryPattern": "constant" | "growing" | "spike",
    "ioPattern": "read_heavy" | "write_heavy" | "balanced" | "minimal",
    "chunkable": <boolean>,
    "resumable": <boolean>,
    "idempotent": <boolean>,
    "hasExternalSideEffects": <boolean>,
    "networkRequired": <boolean>,
    "expectedDurationClass": "seconds" | "minutes" | "hours",
    "durationReasoning": "Brief explanation of why that duration class was chosen, based on script structure, dataset/model size clues, loops, training epochs, I/O, or task description.",
    "reasoning": "..."
  },
  "image": {
    "source": "script" | "modal_default" | "unknown",
    "baseImage": "Modal default image" | "unknown" | "modal.Image....",
    "pythonVersion": "3.11" | null,
    "pythonPackages": ["..."],
    "pythonPackageInstallers": ["uv_pip_install" | "pip_install" | "micromamba_install"],
    "systemPackages": ["..."],
    "envVars": ["..."],
    "localDirs": ["..."],
    "localFiles": ["..."],
    "localPythonSources": ["..."],
    "buildCommands": ["..."],
    "buildFunctions": ["..."],
    "buildGpuType": "T4" | "A10G" | "A100" | "A100-80GB" | "H100" | "L4" | null,
    "runtimeGpuType": "T4" | "A10G" | "A100" | "A100-80GB" | "H100" | "L4" | null,
    "gpuType": "T4" | "A10G" | "A100" | "A100-80GB" | "H100" | "L4" | null,
    "forceBuild": <boolean>,
    "warnings": ["..."],
    "reasoning": "Brief explanation of what image/runtime configuration was extracted."
  }
}
\`\`\`

Default-image case:
- source: "modal_default"
- baseImage: "Modal default image"
- pythonVersion: null
- all arrays empty
- buildGpuType, runtimeGpuType, and gpuType: null
- forceBuild: false
- warnings should include: "No explicit Modal image was declared; Modal will use its default image."

Rules:
- Keep arrays empty when a feature is not declared.
- Preserve package specifiers exactly, such as "torch==2.8.0" or "pandas>=2".
- For envVars, include keys only.
- For ambiguous dynamic expressions, include a warning rather than guessing.
- durationReasoning should explain the duration estimate specifically, not repeat the GPU or image reasoning.
- Output ONLY the JSON block — no surrounding text.`

export interface PlanAgentResult {
  taskProfile: ModalTaskProfile
  image: ModalImageInspection
}

const PACKAGE_INSTALLERS = new Set<ModalPythonPackageInstaller>([
  'uv_pip_install',
  'pip_install',
  'micromamba_install',
])

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function packageInstallers(value: unknown): ModalPythonPackageInstaller[] {
  return stringArray(value).filter((v): v is ModalPythonPackageInstaller => PACKAGE_INSTALLERS.has(v as ModalPythonPackageInstaller))
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeImageInspection(raw: any): ModalImageInspection {
  const source = raw?.source === 'script' || raw?.source === 'unknown' || raw?.source === 'modal_default'
    ? raw.source
    : 'unknown'
  const warnings = stringArray(raw?.warnings)
  if (source === 'modal_default' && warnings.length === 0) {
    warnings.push('No explicit Modal image was declared; Modal will use its default image.')
  }

  return {
    source,
    baseImage: typeof raw?.baseImage === 'string' && raw.baseImage.trim()
      ? raw.baseImage
      : source === 'modal_default' ? 'Modal default image' : 'unknown',
    pythonVersion: nullableString(raw?.pythonVersion),
    pythonPackages: stringArray(raw?.pythonPackages),
    pythonPackageInstallers: packageInstallers(raw?.pythonPackageInstallers),
    systemPackages: stringArray(raw?.systemPackages),
    envVars: stringArray(raw?.envVars),
    localDirs: stringArray(raw?.localDirs),
    localFiles: stringArray(raw?.localFiles),
    localPythonSources: stringArray(raw?.localPythonSources),
    buildCommands: stringArray(raw?.buildCommands),
    buildFunctions: stringArray(raw?.buildFunctions),
    buildGpuType: nullableString(raw?.buildGpuType),
    runtimeGpuType: nullableString(raw?.runtimeGpuType),
    gpuType: nullableString(raw?.gpuType),
    forceBuild: raw?.forceBuild === true,
    warnings,
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning : '',
  }
}

export async function runPlanAgent(
  scriptPath: string,
  command: string,
  taskDescription: string | undefined,
  ctx: ResearchToolContext,
): Promise<PlanAgentResult> {
  if (!ctx.createSubAgent) {
    throw new Error('createSubAgent is required for modal compute planning')
  }

  // Build sandbox
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-plan-'))
  try {
    // Copy script (preserve original filename so the agent sees a recognizable name)
    const scriptName = path.basename(scriptPath)
    fs.copyFileSync(scriptPath, path.join(sandbox, scriptName))

    // Write task context
    const taskLines = [`# Task`, ``, `Command: ${command}`]
    if (taskDescription) taskLines.push(``, `Description: ${taskDescription}`)
    fs.writeFileSync(path.join(sandbox, 'task.md'), taskLines.join('\n'))

    // Create sub-agent with sandboxed tools
    const tools = createSandboxTools(sandbox)
    const agent = ctx.createSubAgent({ systemPrompt: SYSTEM_PROMPT, tools })

    // Run the agent
    await agent.prompt(
      'Read the script and task, extract the script-declared Modal image/runtime configuration, then return your plan JSON.',
    )

    // Extract JSON from the agent's last assistant message
    const messages = agent.state.messages
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant || !('content' in lastAssistant)) {
      throw new Error('Plan agent produced no response')
    }
    const textBlock = (lastAssistant as any).content?.find(
      (c: any) => c.type === 'text',
    )
    if (!textBlock?.text) {
      throw new Error('Plan agent produced no text output')
    }

    const parsed = parseJsonFromLlm(textBlock.text) as any
    if (!parsed?.taskProfile || !parsed?.image) {
      throw new Error('Plan agent returned invalid JSON — missing taskProfile or image')
    }

    return {
      taskProfile: parsed.taskProfile as ModalTaskProfile,
      image: normalizeImageInspection(parsed.image),
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}
