/**
 * Experiment Request Skill
 *
 * Procedural knowledge for designing executable experiment requests
 * that can be outsourced to a junior researcher for execution.
 *
 * Addresses quality gaps in ExperimentRequest generation:
 * - Missing schemas for output files
 * - Vague method steps without copy-pasteable commands
 * - No expected results or success criteria
 * - Forward references to nonexistent scripts/files
 *
 * Total: ~100 tokens (summary) → ~1,200 tokens (full, lazy loaded)
 */

import { defineSkill } from '../../../src/skills/define-skill.js'
import type { Skill } from '../../../src/types/skill.js'

/**
 * Experiment Request Design Skill
 *
 * Comprehensive guidance for producing self-contained, unambiguous
 * experiment requests that a junior researcher can execute without
 * asking clarifying questions.
 */
export const experimentRequestSkill: Skill = defineSkill({
  id: 'experiment-request-skill',
  name: 'Experiment Request Design',
  shortDescription: 'Design executable experiment requests for outsourced execution',

  instructions: {
    summary: `Experiment request design guidance:
- **Self-Contained**: Every ExperimentRequest must be executable without clarifying questions
- **10 Mandatory Sections**: goal, preconditions, filesProduced, methodSteps, frozenPrompts, controls, metrics, expectedResult, outputFormat, submissionChecklist
- **Copy-Pasteable Commands**: Every step must include exact commands with \`<PLACEHOLDER>\` for variable parts
- **Schema-First Outputs**: Every output file must have column-level or field-level schema defined`,

    procedures: `
## 10 Mandatory Sections

Every ExperimentRequest MUST include all 10 sections below. The gate will reject requests missing any required section.

### 1. Goal (2-3 sentences)
Why this experiment matters and what question it answers. Link to the research hypothesis or claim being tested.

### 2. Preconditions
Specific requirements the executor must have before starting:
- Software with exact version numbers (e.g., "Python 3.11+", "Node 20.x")
- Hardware requirements (e.g., "GPU with 8GB+ VRAM" or "no special hardware")
- Access requirements (e.g., "API key for service X stored in \`$ENV_VAR\`")
- Data dependencies (e.g., "input file at \`<DATA_DIR>/corpus.jsonl\`")

### 3. Files Produced
List every output file the experiment will generate:
- File path (relative to experiment root)
- Format (TSV, CSV, JSON, JSONL, PNG, etc.)
- Schema: column names and types for tabular data, or JSON field descriptions
- Example: \`results/latency.tsv\` — columns: \`trial_id:int, prompt_tokens:int, latency_ms:float, model:string\`

### 4. Method Steps
Numbered steps with exact copy-pasteable commands:
- Every command must be runnable as-is (after placeholder substitution)
- Mark variable substitutions with \`<PLACEHOLDER>\` syntax (e.g., \`<MODEL_NAME>\`, \`<DATA_DIR>\`)
- Include expected duration or timeout for long-running steps
- If a step produces intermediate output, specify the file path and format

### 5. Frozen Prompts
If the experiment involves sending prompts to an LLM or agent:
- Include the exact prompt text verbatim in a code fence
- NEVER say "use the prompt from step X" — always inline the full text
- If prompts vary by condition, list each variant separately
- Include system prompts, user prompts, and any tool schemas

### 6. Controls
- What is held constant across conditions
- What varies (independent variables)
- Baselines (if any) and how they differ from experimental conditions
- Randomization strategy (fixed seed, shuffled order, etc.)

### 7. Metrics
For each metric:
- Name and definition (e.g., "p50 latency: 50th percentile of latency_ms column")
- Source file: which output file contains the raw data
- Extraction logic: exact command or formula to compute (e.g., \`cut -f3 results.tsv | sort -n | awk 'NR==int(NR*0.5)'\`)

### 8. Expected Result
What a successful run looks like — be specific:
- Expected file count and approximate sizes
- Expected metric ranges (e.g., "p50 latency should be 200-500ms")
- Patterns that indicate success or failure
- Known failure modes and what they look like in the data

### 9. Output Format / Schemas
Column-level definitions for every output file:
\`\`\`
results/latency.tsv
  trial_id     int       Sequential trial number (1-based)
  prompt_tokens int      Token count of the input prompt
  latency_ms   float     Wall-clock response time in milliseconds
  model        string    Model identifier used for this trial
\`\`\`

For JSON files, provide a JSON Schema or annotated example.

### 10. Submission Checklist
Checkboxes for every required upload:
\`\`\`
- [ ] results/latency.tsv (N rows, one per trial)
- [ ] results/summary_stats.json (aggregated metrics)
- [ ] logs/run.log (full execution log)
- [ ] env_info.txt (software versions, hardware info)
\`\`\`

## Quality Rules

- **No forward references**: Do not reference tools, scripts, or files that are not provided inline or confirmed to exist
- **No deferred resolution**: Do not write "if unknown, we'll detect later" — resolve all unknowns before issuing
- **Warmup vs measure**: If the experiment has phases (warmup, measure), define explicit boundaries (e.g., "discard first 5 trials")
- **Time-basis warnings**: When joining data from different clock sources, note the synchronization method
- **Placeholder discipline**: Every \`<PLACEHOLDER>\` must be listed in Preconditions with instructions for the executor to fill it in
`,

    examples: `
## Golden Example (scored 10/10)

\`\`\`json
{
  "goal": "Measure p50/p95 latency and token throughput of GPT-4o vs Claude-3.5 on a 200-prompt benchmark to validate the claim that model X is ≤15% slower.",
  "preconditions": "Python 3.11+, openai>=1.30, anthropic>=0.25. API keys in $OPENAI_API_KEY and $ANTHROPIC_API_KEY. Input file: <DATA_DIR>/benchmark_prompts.jsonl (200 lines, each {id, prompt, expected_tokens}).",
  "filesProduced": [
    "results/latency.tsv — columns: trial_id:int, model:string, prompt_id:string, prompt_tokens:int, completion_tokens:int, latency_ms:float, timestamp_utc:string",
    "results/summary.json — fields: {model: {p50_ms, p95_ms, mean_throughput_tok_s, n_trials}}"
  ],
  "methodSteps": [
    "1. Install dependencies: \`pip install openai>=1.30 anthropic>=0.25\`",
    "2. Run benchmark script: \`python run_benchmark.py --input <DATA_DIR>/benchmark_prompts.jsonl --output results/ --models gpt-4o,claude-3-5-sonnet --trials-per-prompt 3 --warmup 5\`",
    "3. The script iterates over each prompt × model × trial, records latency, writes to results/latency.tsv",
    "4. Compute summary: \`python summarize.py --input results/latency.tsv --output results/summary.json\`"
  ],
  "frozenPrompts": "System prompt for benchmark: 'You are a helpful assistant. Answer the user query concisely.' — User prompt: verbatim from benchmark_prompts.jsonl 'prompt' field.",
  "controls": "Fixed: temperature=0, max_tokens=512, system prompt. Varies: model (gpt-4o, claude-3-5-sonnet). Baseline: gpt-4o. Randomization: prompts shuffled with seed=42.",
  "metrics": "p50 latency (median of latency_ms per model), p95 latency (95th percentile), mean throughput (completion_tokens / latency_ms * 1000). Source: results/latency.tsv.",
  "expectedResult": "2 × 200 × 3 = 1200 rows in latency.tsv. p50 latency 200-800ms per model. summary.json has entries for both models.",
  "outputFormat": "latency.tsv: TSV with header. summary.json: {model_name: {p50_ms: float, p95_ms: float, mean_throughput_tok_s: float, n_trials: int}}",
  "submissionChecklist": "[ ] results/latency.tsv (1200 rows)\\n[ ] results/summary.json\\n[ ] logs/run.log\\n[ ] env_info.txt"
}
\`\`\`

**Why this scores 10/10**: Every command is copy-pasteable. Output schemas are column-level. Expected row count is computable. Metrics have extraction sources. No ambiguity.

## Bad Example (scored 2/10)

\`\`\`json
{
  "goal": "Test the models",
  "method": "Run the benchmark and collect results",
  "expectedResult": "Should show performance differences"
}
\`\`\`

**Why this scores 2/10**: No preconditions. No output file schemas. "Run the benchmark" is not a command. "Should show performance differences" is not a measurable expected result. Missing: controls, metrics, submission checklist, frozen prompts.
`,

    troubleshooting: `
## Common Failure Modes

### "Missing schema"
Every output file MUST have column names and types defined in filesProduced and outputFormat. If you don't know the schema yet, design it before issuing the request.

### "Vague method"
Every step must have a concrete command or action. Replace "run the experiment" with the exact command: \`python run.py --config config.yaml --output results/\`. If the script doesn't exist yet, provide it inline or mark it as a precondition.

### "No expected result"
The executor needs to know what success looks like. "It should work" is not acceptable. Provide: expected file count, approximate row counts, metric ranges, and patterns that indicate failure.

### "Forward reference to nonexistent file"
Before referencing a script or data file, verify it exists or provide it inline. If you reference \`run_benchmark.py\`, either include its full source or confirm its path and that the executor has access to it.

### "Ambiguous segmentation"
When experiments have phases (warmup/measure), define explicit boundaries: "Trials 1-5 are warmup (discard). Trials 6-N are measurement (include in analysis)." Never leave phase boundaries implicit.

### "Missing placeholder definitions"
Every \`<PLACEHOLDER>\` in method steps must appear in preconditions with instructions for the executor. If you write \`<DATA_DIR>\`, preconditions must say: "Set DATA_DIR to the path of your data directory."
`
  },

  tools: [],  // No specific tool — triggered by coordinator context in S2-S4 stages
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 100,
    full: 1200
  },

  tags: ['experiment', 'methodology', 'outsource', 'experiment-request']
})

export default experimentRequestSkill
