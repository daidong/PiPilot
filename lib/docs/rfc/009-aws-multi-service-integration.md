# RFC-009: AWS Multi-Service Integration

**Status:** Draft — planning only, not scheduled. Reference doc for when we actually add AWS support.
**Author:** Captain + Claude
**Date:** 2026-05-17
**Builds on:** RFC-008 (Compute Backend Abstraction)
**Scope:** A reference architecture for integrating *multiple* AWS services (EC2, Bedrock, S3, Lambda, CloudWatch, …) without making the agent / coordinator codebase scale super-linearly with each service added.

## 0. TL;DR

A user-facing "AWS support" feature is **not one thing**. It's an umbrella over a set of services that belong in **three different abstraction layers** already present in this codebase:

| Layer | Service kind | Examples | Where it plugs in |
|---|---|---|---|
| **A. ComputeBackend** | Long-running compute jobs | EC2, AWS Batch, Fargate, SageMaker training | `lib/compute/` (RFC-008) |
| **B. LLM Provider** | Hosted model inference | Bedrock (Claude / Llama / Titan) | pi-mono provider system |
| **C. Agent Tool** | One-shot RPC / data ops | S3 ops, Lambda invoke, CloudWatch query, DynamoDB get | `lib/tools/` (`createXxxTools()` pattern) |

The complexity claim this RFC defends: **as long as each AWS service plugs into the right layer, total cost is additive (≈ linear in service count), not multiplicative.** The pathology to avoid is a single mega-abstraction like `AwsBackend` that conflates all three.

A representative target — EC2 (compute) + Bedrock (provider) + S3 (tools) — costs ~3000 LOC / 3-4 weeks, only ~50% more than EC2 alone. See §6 for the full estimate.

This RFC is a **reference doc**, not an implementation plan. It locks the layering, names the shared infrastructure, and inventories the per-service surface so a future implementer can start without re-litigating the architecture.

## 1. Motivation — why this RFC exists before any code

A user asked the natural question: *"if I want EC2 + S3 + Bedrock, does the implementation difficulty jump dramatically?"*

The wrong answer is "yes" (and would lead to either over-scoping or never doing it). The right answer is "no, if we keep the abstractions clean", which only holds if we **commit to the layering before the first AWS line of code lands**. RFC-008 settled the ComputeBackend abstraction for "the next compute target"; this RFC extends that frame to the *next ten* AWS services.

If we skip this step and start with an EC2 backend, the second AWS service (e.g. S3) will arrive without a layering decision and will either (a) get stuffed into the ComputeBackend and pollute the eight-method interface or (b) get its own one-off integration that doesn't share credentials / telemetry / settings UI with EC2. Both outcomes are paid forever; the RFC is paid once.

## 2. Layering — what goes where, and why

### 2.1 Layer A: ComputeBackend (RFC-008 reuse)

**Used for:** long-running jobs with a submit → poll → complete lifecycle.

| AWS service | Fits because |
|---|---|
| EC2 | Provision instance → SSH → run → terminate. Most state-heavy; baseline reference. |
| AWS Batch | Submit job → AWS schedules → poll job status. Simpler than EC2 (AWS owns lifecycle). |
| Fargate / ECS task | Submit container → AWS schedules → poll. Like Batch but per-task. |
| SageMaker training | CreateTrainingJob → poll → CreateModel/extract artifacts. Mature AWS-managed job model. |
| Glue / EMR jobs | StartJobRun → poll → terminal status. Same pattern. |

**Doesn't fit:** S3 (no lifecycle), Bedrock (one-shot inference), Lambda invoke (synchronous), CloudWatch query (read-only).

**Identity rule (RFC-008 A4):** each backend declares `id: 'aws-ec2' | 'aws-batch' | …` with `toolPrefix: 'ec2' | 'batch' | …`. No `id: 'aws'` umbrella — each compute service is its own backend.

### 2.2 Layer B: LLM Provider (pi-mono provider system)

**Used for:** model inference requests routed through the existing provider abstraction the coordinator already uses for Anthropic / OpenAI.

| AWS service | Fits because |
|---|---|
| Bedrock (Anthropic Claude on Bedrock) | LLM request/response, conforms to provider contract. |
| Bedrock (Meta Llama / Amazon Titan / Mistral on Bedrock) | Same surface, different model id routing. |

**Implementation footprint:** one provider class that maps the standard provider interface onto `bedrock-runtime:InvokeModel`. Bedrock's request/response shape is per-model-family (Claude messages format vs. Titan completion format vs. Llama chat format), so the provider needs a small per-family adapter. Estimated 200-400 LOC total.

**Note for future implementer:** verify pi-mono's provider abstraction shape (`@mariozechner/pi-agent-core` exports) before locking the Bedrock implementation. If pi-mono doesn't already have an extension point for custom providers, that's a prerequisite contribution upstream — flag it early.

### 2.3 Layer C: Agent Tool (`lib/tools/` pattern)

**Used for:** one-shot operations the agent invokes the way it invokes `web_search` / `web_fetch`.

| AWS service | Tools to expose | Typical LOC per tool |
|---|---|---|
| S3 | `s3_upload`, `s3_download`, `s3_list`, `s3_presigned_url`, `s3_copy`, `s3_delete` | 50-100 |
| Lambda | `lambda_invoke`, `lambda_list_functions` | 80-100 |
| CloudWatch Logs | `cloudwatch_logs_query` (Logs Insights), `cloudwatch_logs_tail` | 100-150 |
| DynamoDB | `dynamodb_get`, `dynamodb_query`, `dynamodb_put` (gated — write capability flag) | 80-120 |
| Comprehend / Rekognition / Textract | one tool per useful operation | 60-100 |

**Pattern:** one factory per service — `createS3Tools(ctx): AgentTool[]`, `createLambdaTools(ctx): AgentTool[]` — wired into `createResearchTools()` in `lib/tools/index.ts`. Identical mechanics to `createWebTools()`. The tools are registered through pi-mono's `AgentTool` shape and surfaced to the coordinator like any other.

**Anti-pattern (do not do):** a single `aws_tool({service, action, params})` superguard. That gives the LLM unpredictable type signatures, makes error classification per-service impossible, and ruins the "tool description guides the agent" property.

### 2.4 What the user actually means by "AWS support"

Different users frame the request differently. The layering decision should be invariant under these framings:

| User framing | Where it lands |
|---|---|
| "I want to train a model on AWS" | Layer A (probably SageMaker, or EC2 if they need a custom box) |
| "I want my agent to use Claude on Bedrock instead of the Anthropic API" | Layer B (Bedrock provider) |
| "I want my agent to read / write my S3 buckets" | Layer C (S3 tools) |
| "I want the agent to look up CloudWatch logs when debugging" | Layer C (CloudWatch tools) |
| "I want a Lambda function to be callable as a tool" | Layer C (Lambda invoke tool) or Layer A (if it's a long async invoke) |

In every case, the layer is determined by the **interaction shape** (long-running job? inference call? RPC?) — not by the AWS product family.

## 3. Shared Infrastructure — the AWS bus

The three layers share four cross-cutting concerns. Building them once means each new AWS service adds *only* its service-specific code.

### 3.1 Credentials (the central piece)

Centralize once in `lib/aws/credentials.ts` (~150 LOC):

```typescript
interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string         // STS / SSO
  region: string                // default region; per-call can override
  profile?: string              // when sourcing from ~/.aws/credentials
}

interface AwsCredentialResolution {
  source: 'settings' | 'env' | 'profile' | 'instance-metadata'
  credentials: AwsCredentials
  validatedAt: string           // ISO; cached STS GetCallerIdentity check
}

class AwsCredentialProvider {
  resolve(opts?: { region?: string }): Promise<AwsCredentialResolution>
  validate(creds: AwsCredentials): Promise<{ valid: boolean; accountId?: string; arn?: string; error?: string }>
}
```

Resolution priority (highest wins):
1. Explicit settings (Compute tab → AWS credentials, like the existing Modal credentials UI)
2. Environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`)
3. `~/.aws/credentials` profile (if `AWS_PROFILE` set or default profile exists)
4. Instance metadata (only meaningful if the app is run on EC2 itself — niche)

Validation: a single `sts:GetCallerIdentity` call. Cache for 5 minutes. Surface `accountId` + `arn` in the settings UI so the user can confirm they're pointing at the right account.

**All three layers source from this** — Layer A backends pass credentials into the AWS SDK clients they create; Layer B Bedrock provider does the same; Layer C tools receive credentials via the same `ComputeContext`-style injection used today. No service implements its own credential loading.

### 3.2 Region selection

Region is *not* a single global. Different AWS services have different region availability (Bedrock model availability varies; SageMaker GPU instances vary; some user S3 buckets are in non-default regions). The credential layer supplies a **default** region; per-call (per-plan, per-tool-invocation) overrides are required.

Practical contract:
- `AwsCredentials.region` is the default
- Every backend's `plan()` can accept a `region` field in its `backendData` plan input
- Every tool's parameters schema includes an optional `region`
- The Bedrock provider's model id can carry region routing (or accept explicit region)

### 3.3 Settings UI

One **Compute tab → AWS section** (parallel to the existing Modal section):

```
┌─ AWS ────────────────────────────────────────┐
│ Access key ID:     [_______________________]  │
│ Secret access key: [_______________________]  │
│ Default region:    [us-east-1            v]   │
│ Profile (optional):[default                ]  │
│                                               │
│ [ Test connection ]                           │
│   ✓ Connected as arn:aws:iam::123…:user/X    │
│   ✓ EC2 access verified                      │
│   ✓ Bedrock access verified                  │
│   ✗ S3 list-buckets: AccessDenied            │
└───────────────────────────────────────────────┘
```

The "Test connection" surfaces per-service capability checks — these are the same probes each layer's `probeAvailability()` / equivalent already calls. The UI just shows them in one place. ~200-300 LOC reusing existing settings patterns.

### 3.4 Telemetry / cost ledger

AWS spending is the highest-stakes user-visible cost in this app (per-month bills, surprise charges). The current Modal backend has its own cost tracking; AWS expansion should consolidate:

- Layer A backends report cost-per-run to a shared `aws-cost-ledger.jsonl` (filesystem) on terminal transition
- Layer B Bedrock provider reports per-invocation token cost
- Layer C tools that incur charges (S3 GET / PUT, Lambda invoke) report per-call
- A future Compute tab "Spend this month" pill aggregates this

This is **optional** but flagged here so the per-service code is uniform about where it writes. Ledger spec deferred to a follow-up RFC if/when implemented.

## 4. Per-Service Inventory

A reference table for the future implementer. Estimated LOC includes the service's main module + tests; excludes shared infrastructure (§3).

### 4.1 Layer A: Compute services

| Service | Approval needed? | Cost model | Crash risk | LOC | Notes |
|---|---|---|---|---|---|
| **EC2** | Yes | per-hour instance type × duration | High (orphan instances burn $$$) | 1700-2500 | Most complex. Needs instance lifecycle + SSH + artifact SCP back. Critical to persist `instanceId` before returning from submit. |
| **AWS Batch** | Yes | per-vCPU + per-GB-hour | Low (AWS handles cleanup) | 800-1200 | Submit JobDefinition + JobQueue; poll JobStatus. Much simpler lifecycle. |
| **Fargate task** | Yes | per-vCPU + per-GB-hour | Low | 700-1000 | Like Batch but no queue layer. RunTask + DescribeTasks. |
| **SageMaker training** | Yes | per-instance × duration | Medium (training jobs can be stopped but billing is per-second) | 1000-1500 | Closest to Modal's model — AWS manages everything; we provide container image + dataset URI. |

### 4.2 Layer B: LLM Provider

| Service | LOC | Notes |
|---|---|---|
| **Bedrock** | 200-400 | Per-model-family adapter (Claude messages / Titan completions / Llama chat). Cross-region inference profiles are a recent addition — design for the 2026+ Bedrock API, not the 2024 one. |

### 4.3 Layer C: Tools

| Service | Tools | LOC total | Notes |
|---|---|---|---|
| **S3** | upload, download, list, presigned-url, copy, delete | 400-500 | The most-asked-for. Watch out for large file uploads (multipart) and prefix-listing pagination. |
| **Lambda** | invoke (sync), invoke-async, list-functions | 200-300 | Sync invoke fits Tool; long-async (>15min) should be Layer A. |
| **CloudWatch Logs** | query (Logs Insights), tail | 200-300 | Logs Insights is a query language — tool description must teach the LLM the syntax (`fields @timestamp, @message | filter ...`). |
| **DynamoDB** | get, query, put | 250-350 | Writes gated by capability flag (don't let agent silently destroy data). |
| **Textract / Rekognition / Comprehend** | one tool per useful API | 150-300 each | Niche; add only on demand. |

## 5. Anti-Patterns — what NOT to do

These show up by default if the layering isn't enforced; each is paid forever once it lands.

### 5.1 The "AwsBackend" mega-object

❌ One ComputeBackend implementation that internally dispatches to EC2 / S3 / Bedrock / Lambda. Breaks RFC-008's eight-method semantics (S3 has no `submit/getStatus/stop`), forces the renderer to handle a Frankenstein `backendData` union, and concentrates blast radius — a bug in S3 code can break the EC2 backend's tests.

✅ One backend per long-running compute service; storage and inference live in their own layers.

### 5.2 The "AwsTools" superguard

❌ A single tool `aws({service: 's3', action: 'list', params: {bucket: '...'}})`. LLM can't reason about parameter shapes; error messages have no semantic class; per-service authorization can't be expressed in a tool description.

✅ One tool per concrete operation, named after the operation (`s3_list`, `lambda_invoke`).

### 5.3 Per-service credential loading

❌ EC2 backend loads `~/.aws/credentials`; Bedrock provider reads env vars; S3 tools accept `accessKeyId` as a tool parameter. Three different stories for "where are my AWS keys?", three different settings UI shards.

✅ All three sources from `lib/aws/credentials.ts`.

### 5.4 Region as a hidden global

❌ A single "AWS region" setting in app config that every service uses. Real workflows are cross-region (Bedrock in us-west-2, S3 bucket in eu-central-1, EC2 in us-east-1).

✅ Default region in credentials; per-call override in plans / tool params.

### 5.5 Doing Bedrock as a "tool" instead of a provider

❌ `bedrock_invoke({model, prompt})` as an agent tool. Doesn't compose with the coordinator's existing streaming / token-accounting / context-caching. Two LLM paths to maintain.

✅ Bedrock plugs into pi-mono's provider abstraction. The coordinator switches "provider" the same way it switches between Anthropic and OpenAI today.

## 6. Effort Estimate — the representative target

A grounded estimate for the user's stated example (EC2 + Bedrock + S3):

| Module | LOC | Time |
|---|---|---|
| Shared AWS infra (`lib/aws/credentials.ts` + Settings UI) | 250-350 | 1 day |
| Layer A: EC2 ComputeBackend | 1700-2500 | 2-3 weeks |
| Layer B: Bedrock provider | 200-400 | 1-2 days |
| Layer C: S3 tools (6 core ops) | 400-500 | 2-3 days |
| Cross-cutting: tests, docs, telemetry hooks | 300-500 | 2-3 days |
| **Total** | **~2900-4250** | **~3-4 weeks** |

Reference: RFC-008 EC2-only estimate was ~2000 LOC / 2-3 weeks. The marginal cost of *adding* Bedrock + S3 on top of EC2 is **~1000 LOC / ~1 week** — most of which is the shared infra that pays for itself across all future AWS services.

**Each subsequent service** (Batch, Lambda tools, CloudWatch tools, etc.) drops further because the shared infra already exists:
- A new Layer A backend: ~1000 LOC (no longer needs to build credentials / settings UI from scratch)
- A new Layer B provider variant: ~150 LOC
- A new Layer C tool set: ~150-300 LOC per service

After service #2, the per-service cost is **flat**.

## 7. Open Questions (deferred)

These don't need to be answered to start, but should be revisited before the EC2 implementation lands:

1. **Cost ledger spec** — JSONL format, retention policy, how it surfaces in the UI. Probably a small follow-up RFC.
2. **STS role assumption / SSO** — does v1 need to support `aws sso login`? Likely no (access keys cover the 90% case), but flag it.
3. **MFA-gated credentials** — same; defer.
4. **Per-service capability probes** — do we eagerly probe all AWS services on credential save (slow but informative settings UI), or lazily on first use (fast but errors land late)? Lean lazy with a "Test connection" button (§3.3) doing the eager pass on demand.
5. **Bedrock model id → region routing** — once cross-region inference profiles are widely available, the provider can hide region routing entirely. Track AWS's API stability before deciding.
6. **Agent-tool gating for destructive ops** — `s3_delete`, `dynamodb_put` should be capability-gated (similar to the approval gate for ComputeBackend). Where does this live? Probably a new pi-mono tool capability flag; flag for the implementer.
7. **EC2 artifact return** — this surfaced in the prior compute audit as a P1 gap (no way for a backend to declare "here are the output files"). RFC-008 deferred it. EC2 will force the issue. Either extend `RunStatus` with `artifacts: Array<{path, size, mime}>`, or solve it externally (force scripts to write to S3 + use S3 tools to retrieve). The former is ~150 LOC and benefits Local + Modal too; the latter is zero LOC but pushes the workflow onto the user. Decide at EC2 implementation time.

## 8. Implementation Order (when work resumes)

Suggested sequence — each step delivers user value standalone, and each one's infrastructure is reused by the next:

1. **Shared AWS credentials layer + Settings UI** (§3.1, §3.3) — 1 day. Unlocks everything.
2. **Bedrock provider** (Layer B) — 1-2 days. Smallest, validates the credentials layer end-to-end, gives the user an immediate "I can use Claude via Bedrock" win.
3. **S3 tools** (Layer C) — 2-3 days. Second-smallest, gives the agent file I/O against the user's existing AWS storage.
4. **EC2 ComputeBackend** (Layer A) — 2-3 weeks. The big one; do it last so the shared infra is battle-tested.
5. **(Optional) Artifact return API in RFC-008** — 2-3 days. Decide based on EC2 implementation experience whether to extend `RunStatus.artifacts` (recommended) or push to S3.
6. **(Future) Additional compute backends** — Batch, Fargate, SageMaker on demand. Each one is now ~1 week with shared infra in place.

## 9. References

- RFC-008 — Compute Backend Abstraction (the layer-A interface this RFC reuses)
- `lib/compute/backend.ts` — the eight-method ComputeBackend interface
- `lib/compute/backends/modal/modal-backend.ts` — reference implementation pattern for a non-local backend
- `lib/tools/web-tools.ts` — reference pattern for `createXxxTools()`
- AWS SDK for JavaScript v3 — `@aws-sdk/client-*` modules (modular per-service)
- pi-mono provider system — provider extension points (verify before Bedrock implementation)
