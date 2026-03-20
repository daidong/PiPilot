/**
 * LLM Compute Skill
 *
 * Provides procedural knowledge for using LLM sub-computation tools:
 * - llm-call: Custom LLM tasks
 * - llm-expand: Text expansion and query generation
 * - llm-filter: Relevance filtering and ranking
 *
 * This skill replaces the promptFragment from the compute pack,
 * enabling lazy loading to save tokens when LLM tools aren't used.
 */

import { defineSkill } from '../define-skill.js'
import type { Skill } from '../../types/skill.js'

/**
 * LLM Compute Skill
 *
 * Migrated from compute.ts promptFragment (~400 tokens → ~50 tokens initial)
 */
export const llmComputeSkill: Skill = defineSkill({
  id: 'llm-compute-skill',
  name: 'LLM Sub-Computations',
  shortDescription: 'Use LLM for text processing, expansion, filtering, and custom tasks',

  instructions: {
    summary: `Three LLM tools available:
- **llm-call**: Custom LLM tasks (classification, summarization, extraction)
- **llm-expand**: Generate text variations (search queries, synonyms, rephrase)
- **llm-filter**: Rank/filter lists by relevance (scoring 0-10)`,

    procedures: `
## llm-call Tool
Execute custom LLM prompts for:
- Text classification and categorization
- Summarization and compression
- Structured data extraction
- Custom reasoning tasks

Parameters:
- \`prompt\`: The prompt to send to the LLM
- \`systemPrompt\`: Optional system instructions
- \`maxTokens\`: Token limit for response (default: 1000)
- \`temperature\`: Creativity level 0-1 (default: 0.7)
- \`jsonMode\`: Enable JSON output parsing

## llm-expand Tool
Generate multiple variations of input text:
- **style: "search"** - Optimized search queries (default)
- **style: "synonyms"** - Synonym and alternative terms
- **style: "rephrase"** - Different phrasings and angles
- **style: "questions"** - Related questions

Parameters:
- \`text\`: Input text to expand
- \`style\`: Expansion style (search, synonyms, rephrase, questions)
- \`count\`: Number of variations (default: 5)
- \`domain\`: Context hint (e.g., "academic", "technical", "casual")

## llm-filter Tool
Score and filter lists by relevance:
- Each item scored 0-10 against the query
- Returns sorted, filtered results

Parameters:
- \`items\`: Array of items to filter (strings or objects with text field)
- \`query\`: Relevance query/criteria
- \`minScore\`: Minimum score threshold (default: 5)
- \`maxItems\`: Maximum items to return (default: 10)
- \`scoreField\`: Field name for score in output (default: "score")

## Token Budget Management
- The compute pack enforces per-call and session token limits
- Set \`maxTokens\` conservatively to avoid waste
- Use llm-filter to reduce result sets before detailed processing
- Complex tasks should be split into multiple smaller calls

## Best Practices
1. Prefer llm-expand/llm-filter over custom llm-call when applicable
2. Use appropriate expansion style for the use case
3. Set realistic maxTokens based on expected output length
4. Chain operations: expand → search → filter → process
`,

    examples: `
## Query Expansion for Search
\`\`\`json
{
  "tool": "llm-expand",
  "input": {
    "text": "machine learning applications",
    "style": "search",
    "count": 5,
    "domain": "academic"
  }
}
// Returns: ["ML applications in industry", "deep learning use cases", ...]
\`\`\`

## Filter Search Results
\`\`\`json
{
  "tool": "llm-filter",
  "input": {
    "items": ["Paper about CNNs", "Blog post about cooking", "ML research paper"],
    "query": "academic machine learning papers",
    "minScore": 7,
    "maxItems": 5
  }
}
// Returns: [{ item: "ML research paper", score: 9 }, { item: "Paper about CNNs", score: 8 }]
\`\`\`

## Custom Classification
\`\`\`json
{
  "tool": "llm-call",
  "input": {
    "prompt": "Classify the following text into categories: technical, casual, academic.\\n\\nText: 'The gradient descent algorithm converges under certain conditions...'",
    "maxTokens": 50,
    "temperature": 0.3
  }
}
// Returns: "academic"
\`\`\`

## Structured Extraction
\`\`\`json
{
  "tool": "llm-call",
  "input": {
    "prompt": "Extract the following from the paper abstract: title, authors, main contribution, methodology.",
    "systemPrompt": "You are a research paper analyzer. Output valid JSON.",
    "jsonMode": true,
    "maxTokens": 500
  }
}
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "Token quota exceeded"
- Check session token usage with context sources
- Reduce maxTokens per call
- Split large operations into smaller batches

### "JSON parsing failed" (llm-call with jsonMode)
- Ensure prompt explicitly requests JSON output
- Add schema hint in system prompt
- Lower temperature for more consistent formatting

### Poor expansion quality (llm-expand)
- Try different style options
- Add domain context for specialized vocabulary
- Increase count and filter results afterward

### Low relevance scores (llm-filter)
- Refine the query to be more specific
- Lower minScore threshold for broader results
- Check if items contain enough text for scoring

### Slow response times
- Reduce maxTokens
- Use llm-filter to reduce dataset before detailed processing
- Consider caching repeated operations
`
  },

  tools: ['llm-call', 'llm-expand', 'llm-filter'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 60,
    full: 800
  },

  tags: ['compute', 'llm', 'text-processing', 'filtering', 'expansion']
})

export default llmComputeSkill
