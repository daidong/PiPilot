/**
 * Academic Writing Skill
 *
 * Procedural knowledge for academic/research writing:
 * - Narrative flow over bullet enumeration
 * - Outline creation with narrative arc
 * - Section drafting with citation integration
 * - Style guidelines for scholarly prose
 *
 * Migrated from:
 * - coordinator-module-writing (~50 tokens)
 * - writing-outliner-system (~350 tokens)
 * - writing-drafter-system (~350 tokens)
 *
 * Total before: ~750 tokens (always loaded)
 * After: ~80 tokens (summary) → ~600 tokens (full, lazy loaded)
 */

import { defineSkill } from '../../../src/skills/define-skill.js'
import type { Skill } from '../../../src/types/skill.js'

/**
 * Academic Writing Skill
 *
 * Provides comprehensive guidance for research document creation,
 * from outlining to drafting, with emphasis on narrative flow.
 */
export const academicWritingSkill: Skill = defineSkill({
  id: 'academic-writing-skill',
  name: 'Academic Writing',
  shortDescription: 'Research paper outlining and drafting with narrative flow, not bullet enumeration',

  instructions: {
    summary: `Academic writing guidance for research documents:
- **Philosophy**: Narrative flow over bullet enumeration; every sentence earns its place
- **Outlining**: Create structure with narrative arc (motivation → tension → contribution → evidence → resolution)
- **Drafting**: Compelling scholarly prose with natural citation integration [Author, Year]
- **Style**: Formal but accessible; direct claims; prefer prose, use bullets when requested or clearer`,

    procedures: `
## Writing Philosophy

Good academic writing is NOT a list of logical points. It is a narrative that draws the reader
in step by step, guiding them to understand and agree with your argument. Think of it as
storytelling: each section should motivate the next, every sentence should earn its place, and
the reader should never wonder "why am I reading this?"

**Key shift**: From "enumerating logic" to "telling a story."
- Build suspense with open questions
- Deliver insights as resolutions
- Let each paragraph naturally set up the next

## Style Principles

1. **Formal but accessible**: Technical precision without unnecessary jargon
2. **Direct, confident claims**: Avoid hedging unless genuinely uncertain
3. **Prefer prose by default**: Use full sentences for narrative flow; use bullets/dashes when requested or when clarity improves
4. **Citations as narrative**: Integrate [Author, Year] naturally, not as afterthoughts

## Outlining Process

When creating an outline:

1. **Establish narrative arc**:
   - Motivation: Why should the reader care?
   - Tension: What problem or gap exists?
   - Contribution: What does this work offer?
   - Evidence: How is the contribution supported?
   - Resolution: What's the takeaway?

2. **Structure sections as story beats**:
   - Each section should motivate the next
   - Subsections develop the section's central idea
   - Note where citations strengthen the narrative

3. **Plan word allocation**:
   - Introduction: ~10-15% of total
   - Background/Related Work: ~15-20%
   - Methodology/Approach: ~20-25%
   - Results/Findings: ~25-30%
   - Discussion/Conclusion: ~15-20%

## Drafting Process

When drafting sections:

1. **Paragraph structure**:
   - Open with a question, tension, or claim
   - Develop with evidence and reasoning
   - Close by leading into what follows
   - Reader should feel walked through reasoning, not scanning bullets

2. **Citation integration**:
   - Weave citations into the narrative: "As [Author, Year] demonstrated..."
   - Group related citations: "[Author1, Year; Author2, Year]"
   - Use citations to support claims, not replace them

3. **Cross-section continuity**:
   - End sections with forward-looking statements
   - Begin sections by connecting to previous material
   - Maintain consistent terminology throughout

## Output Formats

### Outline Output
\`\`\`json
{
  "title": "Proposed document title",
  "type": "paper|report|review|proposal",
  "sections": [
    {
      "heading": "Section heading",
      "level": 1,
      "description": "What this section covers and its role in the narrative",
      "subsections": [...],
      "suggestedWordCount": 500,
      "citationsNeeded": ["topic1", "topic2"]
    }
  ],
  "estimatedTotalWords": 3000,
  "notes": "Suggestions for strengthening the narrative"
}
\`\`\`

### Draft Output
\`\`\`json
{
  "sectionHeading": "The section heading",
  "content": "The drafted prose with [Author, Year] citations...",
  "wordCount": 500,
  "citationsUsed": [
    { "key": "Author2024", "context": "How/where cited" }
  ],
  "suggestions": "Notes for improving this section"
}
\`\`\`
`,

    examples: `
## Good vs Bad Opening Paragraphs

### Bad (Bullet-style thinking):
"This section covers three topics. First, we discuss X. Second, we examine Y. Third, we analyze Z."

### Good (Narrative flow):
"Understanding X requires grappling with a fundamental tension: while Y promises efficiency, it often sacrifices the nuance that Z demands. This section traces how researchers have navigated this trade-off, revealing patterns that inform our approach."

## Citation Integration

### Bad:
"Machine learning is used in healthcare [1][2][3][4][5]."

### Good:
"The application of machine learning to healthcare has evolved rapidly, from early diagnostic systems [Smith, 2018] to recent work on treatment optimization [Jones, 2022]. However, as [Chen, 2023] argues, these advances raise new questions about interpretability that the field has yet to resolve."

## Section Transitions

### Bad:
"Section 3: Methodology"
"This section describes our methodology."

### Good:
"Section 3: Methodology"
"The tensions identified above—between scalability and accuracy, between generality and domain specificity—shaped our methodological choices. We sought an approach that could..."

## Outline Example

Topic: "Improving Log Analysis with Machine Learning"

\`\`\`json
{
  "title": "Learning from Logs: A Machine Learning Approach to Operational Intelligence",
  "type": "paper",
  "sections": [
    {
      "heading": "Introduction",
      "level": 1,
      "description": "Hook: Modern systems generate massive logs but insight extraction remains manual. Tension: Traditional parsing fails at scale. Contribution: ML-based approach that learns log structure.",
      "suggestedWordCount": 600,
      "citationsNeeded": ["log analysis challenges", "ML for systems"]
    },
    {
      "heading": "The Log Analysis Problem",
      "level": 1,
      "description": "Deepen the tension: why is this hard? Heterogeneous formats, evolving schemas, semantic ambiguity.",
      "suggestedWordCount": 800,
      "citationsNeeded": ["log formats", "parsing limitations"]
    }
  ],
  "estimatedTotalWords": 6000,
  "notes": "Consider adding a running example that threads through all sections"
}
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "The writing feels like a list"
- Check: Does each paragraph start with "First," "Second," "Additionally"?
- Fix: Rewrite openings as questions, tensions, or claims
- Test: Can you remove the enumeration words without losing meaning?

### "Citations feel bolted on"
- Check: Are citations clustered at sentence ends?
- Fix: Integrate citations into the sentence structure
- Example: "Building on [Author]'s framework, we extend..." vs "This was studied before [Author]."

### "Sections don't flow together"
- Check: Does each section ending connect to the next?
- Fix: Add a forward-looking final sentence to each section
- Test: Read only the first and last paragraphs—is the thread clear?

### "The outline lacks narrative"
- Check: Can you state each section's "job" in the story?
- Fix: For each section, answer: "Why does the reader need this NOW?"
- Reorder sections if the logical flow doesn't match the narrative flow

### "Draft is too verbose"
- Check: Does every sentence earn its place?
- Fix: Ask "what would the reader lose if I deleted this?"
- Target: Cut 20% in revision without losing meaning

### "Hedging weakens claims"
- Weak: "It might be possible that X could potentially..."
- Strong: "X occurs when..." (add caveats only where genuinely needed)
- Test: Count hedging words (might, could, possibly, perhaps)—aim for <5% of text
`
  },

  tools: ['writing-outline', 'writing-draft'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 80,
    full: 1200
  },

  tags: ['writing', 'academic', 'research', 'narrative', 'outline', 'draft']
})

export default academicWritingSkill
