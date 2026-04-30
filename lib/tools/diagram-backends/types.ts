/**
 * Diagram generation backend interfaces.
 *
 * Two roles are deliberately separated:
 *   - ImageProvider: generates or edits images. Requires a provider with
 *     image-generation capability (currently OpenAI only — Claude has no
 *     image-generation API).
 *   - ReviewProvider: evaluates a generated image against the request and
 *     returns structured feedback. Either OpenAI or Anthropic vision models
 *     can do this.
 *
 * Thresholds are per-reviewer because reviewers are not calibrated against
 * each other; a score of 8.0 from GPT-4o is not the same as 8.0 from Claude.
 */

export type ImageCapability = 'text_to_image' | 'image_to_image' | 'masked_edit'

/**
 * Rendering quality tier, mirroring gpt-image-2's `quality` parameter:
 *   - low    fastest + cheapest, drafts / layout exploration
 *   - medium default, balances cost and fidelity
 *   - high   typography + photoreal detail, for camera-ready output
 *   - auto   let the model pick
 *
 * The review loop starts at the doc_type-derived default and bumps one
 * tier on a `needs_edit` verdict, so iteration spends more compute only
 * when there is evidence the first pass was close-but-not-there.
 */
export type Quality = 'low' | 'medium' | 'high' | 'auto'

export type DocType =
  | 'journal'
  | 'conference'
  | 'thesis'
  | 'grant'
  | 'preprint'
  | 'report'
  | 'poster'
  | 'presentation'
  | 'default'

export type DiagramType =
  | 'flowchart'
  | 'architecture'
  | 'pathway'
  | 'circuit'
  | 'network'
  | 'conceptual'
  | 'auto'

export type ReferenceMode = 'revise_layout' | 'style_only' | 'local_edit'

export interface ReferenceInput {
  path: string
  mode: ReferenceMode
  /** Mask image for masked_edit mode (local_edit). PNG with transparent region = editable. */
  maskPath?: string
}

export type BlockingIssueKind =
  | 'wrong_content'
  | 'illegible_text'
  | 'layout_collision'
  | 'missing_element'
  | 'style_mismatch'

export interface BlockingIssue {
  kind: BlockingIssueKind
  description: string
  /** Concrete edit instruction, suitable for feeding back to an image editor. */
  fix: string
}

/**
 * Verdict drives iteration strategy:
 *   - acceptable  → done
 *   - needs_edit  → quality issues are localized; try image-to-image edit
 *   - needs_regen → issues are structural/content-level; redo text-to-image
 */
export type Verdict = 'acceptable' | 'needs_edit' | 'needs_regen'

/**
 * Five dimension breakdown. Each is scored 0-2:
 *   0 = absent / wrong
 *   1 = present but flawed
 *   2 = publication-ready
 *
 * `score` is the total (0-10) — kept as a redundant field so the threshold
 * check stays a single comparison, and so reviewers that prefer to grade
 * holistically can still set it directly. Downstream code that needs to
 * route fixes (e.g. "labels are weak → bump label tier") reads the
 * individual dimensions.
 */
export interface ReviewResult {
  score: number
  /** Scientific accuracy — concepts, relationships, notation correct. */
  accuracy: number
  /** Clarity & readability — hierarchy, unambiguous at a glance. */
  clarity: number
  /** Label quality — complete, legible, consistent. */
  labels: number
  /** Layout & composition — balanced, no overlap, logical flow. */
  layout: number
  /** House-style adherence (or generic professional appearance when no profile). */
  style: number
  blockingIssues: BlockingIssue[]
  /** Reviewer's short natural-language summary. */
  summary: string
  verdict: Verdict
}

export interface ReviewRequest {
  image: Buffer
  prompt: string
  docType: DocType
  diagramType: DiagramType
  iteration: number
  maxIterations: number
  /**
   * Short summary of the house-style profile this figure is meant to
   * belong to. Used by the reviewer as the ground truth for the 5th
   * rubric dimension (house-style adherence). Omit to fall back to
   * generic professional-appearance evaluation.
   */
  houseProfileSummary?: string
}

export interface ImageGenOptions {
  /** Overrides the provider's configured quality for this single call. */
  quality?: Quality
  /**
   * Overrides the provider's configured `size` for this single call.
   * Lets image-to-image edits track the source PNG's aspect — without
   * this, OpenAI re-renders to whatever size the provider was created
   * with and squishes the source. Format mirrors the provider's expected
   * size string (e.g. '1024x1024', '1536x1024', '1024x1536', 'auto').
   */
  size?: string
}

export interface ImageProvider {
  /** Stable identifier, e.g. "openai:gpt-image-2". */
  id: string
  /** Human-readable label for logs and UI. */
  label: string
  capabilities: Set<ImageCapability>
  textToImage(prompt: string, options?: ImageGenOptions): Promise<Buffer>
  imageToImage?(prompt: string, image: Buffer, options?: ImageGenOptions): Promise<Buffer>
  maskedEdit?(prompt: string, image: Buffer, mask: Buffer, options?: ImageGenOptions): Promise<Buffer>
}

/** Per-reviewer threshold table. Keys default to `default` when unlisted. */
export type ThresholdTable = Partial<Record<DocType, number>> & { default: number }

export interface ReviewProvider {
  id: string
  label: string
  thresholds: ThresholdTable
  review(req: ReviewRequest): Promise<ReviewResult>
}

export interface DiagramProviderSet {
  image: ImageProvider
  review: ReviewProvider
}
