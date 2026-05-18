/**
 * Modal Plan Agent — new home (lib/compute/backends/modal/).
 *
 * Takes a `createSubAgent` factory directly (RFC-008 §3.3) rather than
 * reaching into a ResearchToolContext for it (the smell PR #62 had).
 * Otherwise the analysis pipeline is unchanged: sandbox a copy of the
 * script in a temp dir, hand the agent three path-jailed file-reading
 * tools, prompt it for JSON, normalize the output.
 *
 * The reach into `agent.state.messages` to extract the last assistant
 * text is preserved from the original implementation. Deferred cleanup:
 * factor a public "getLastAssistantText()" helper in pi-mono so this
 * import does not break when its internal message shape changes.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import { createSandboxTools } from '../../../modal-compute/sandbox-tools.js'
import { parseJsonFromLlm } from '../../../local-compute/task-profiler.js'
import type {
  ModalImageInspection,
  ModalPythonPackageInstaller,
  ModalTaskProfile,
} from '../../../modal-compute/types.js'

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
    "durationReasoning": "Brief explanation of why that duration class was chosen.",
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
  return stringArray(value).filter((v): v is ModalPythonPackageInstaller =>
    PACKAGE_INSTALLERS.has(v as ModalPythonPackageInstaller),
  )
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Exported for unit testing. Normalizes a raw `image` object from the
 * plan agent's JSON into a ModalImageInspection.
 */
export function normalizeImageInspection(raw: unknown): ModalImageInspection {
  const r = (raw ?? {}) as Record<string, unknown>
  const sourceRaw = r.source
  const source: 'script' | 'modal_default' | 'unknown' =
    sourceRaw === 'script' || sourceRaw === 'unknown' || sourceRaw === 'modal_default'
      ? sourceRaw
      : 'unknown'
  const warnings = stringArray(r.warnings)
  if (source === 'modal_default' && warnings.length === 0) {
    warnings.push('No explicit Modal image was declared; Modal will use its default image.')
  }
  return {
    source,
    baseImage:
      typeof r.baseImage === 'string' && r.baseImage.trim()
        ? (r.baseImage as string)
        : source === 'modal_default'
          ? 'Modal default image'
          : 'unknown',
    pythonVersion: nullableString(r.pythonVersion),
    pythonPackages: stringArray(r.pythonPackages),
    pythonPackageInstallers: packageInstallers(r.pythonPackageInstallers),
    systemPackages: stringArray(r.systemPackages),
    envVars: stringArray(r.envVars),
    localDirs: stringArray(r.localDirs),
    localFiles: stringArray(r.localFiles),
    localPythonSources: stringArray(r.localPythonSources),
    buildCommands: stringArray(r.buildCommands),
    buildFunctions: stringArray(r.buildFunctions),
    buildGpuType: nullableString(r.buildGpuType),
    runtimeGpuType: nullableString(r.runtimeGpuType),
    gpuType: nullableString(r.gpuType),
    forceBuild: r.forceBuild === true,
    warnings,
    reasoning: typeof r.reasoning === 'string' ? (r.reasoning as string) : '',
  }
}

export interface RunPlanAgentOpts {
  scriptPath: string
  command: string
  taskDescription?: string
  /**
   * Factory injected by ComputeContext. Returns a freshly constructed
   * sub-agent configured with the coordinator's model and credentials.
   */
  createSubAgent: (opts: { systemPrompt: string; tools: AgentTool[]; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) => Agent
}

export async function runPlanAgent(opts: RunPlanAgentOpts): Promise<PlanAgentResult> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-plan-'))
  try {
    // Copy script — preserve filename so the agent sees a recognizable name
    const scriptName = path.basename(opts.scriptPath)
    fs.copyFileSync(opts.scriptPath, path.join(sandbox, scriptName))

    // Write task context
    const taskLines: string[] = ['# Task', '', `Command: ${opts.command}`]
    if (opts.taskDescription) taskLines.push('', `Description: ${opts.taskDescription}`)
    fs.writeFileSync(path.join(sandbox, 'task.md'), taskLines.join('\n'))

    const tools = createSandboxTools(sandbox)
    const agent = opts.createSubAgent({ systemPrompt: SYSTEM_PROMPT, tools, thinkingLevel: 'low' })

    await agent.prompt(
      'Read the script and task, extract the script-declared Modal image/runtime configuration, then return your plan JSON.',
    )

    const messages = (agent as unknown as { state: { messages: unknown[] } }).state.messages
    const lastAssistant = [...messages].reverse().find(
      (m: any) => m?.role === 'assistant',
    ) as { content?: Array<{ type: string; text?: string }> } | undefined
    if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
      throw new Error('Plan agent produced no response')
    }
    const textBlock = lastAssistant.content.find(c => c.type === 'text')
    if (!textBlock?.text) {
      throw new Error('Plan agent produced no text output')
    }

    const parsed = parseJsonFromLlm(textBlock.text) as Record<string, unknown> | null
    if (!parsed || !parsed.taskProfile || !parsed.image) {
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
