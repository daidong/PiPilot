---
id: literature-skill
name: Literature Search
shortDescription: Academic paper discovery, relevance scoring, and literature review synthesis
category: Literature & Search
tools: [literature-search]
loadingStrategy: lazy
tags: [literature, research, papers, search, review, academic]
---

Literature research guidance:
- **Planning**: Decompose research into 3-6 sub-topics with diverse queries
- **Reviewing**: Score papers 1-10 (≥7 = relevant), force-rank and cut bottom 30%
- **Synthesizing**: Create themed literature reviews with gaps analysis
- **Coordination**: One search per topic per request; synthesize, don't dump raw results

## Procedures

### Search Planning

#### Decomposition Strategy
When given a research request:
1. Identify 3-6 **sub-topics** covering all aspects
2. Assign priority: high (core), medium (supporting), low (peripheral)
3. Generate 2-3 **diverse queries** per sub-topic using:
   - Academic terminology and synonyms
   - Acronyms and full names
   - Related concepts and methods

#### Query Guidelines
- Use source-specific syntax when applicable:
  - DBLP: `author:LastName topic`, `venue:CONF method`
  - Semantic Scholar: natural language queries work best
  - arXiv: include category prefixes when relevant
- Set appropriate targets:
  - Comprehensive study: 30-50 papers total
  - Focused query: 10-20 papers total
  - Minimum 3 papers per sub-topic for coverage

#### Incremental Planning
When previous search results exist:
- Check coverage data: skip well-covered sub-topics
- Avoid duplicate queries: use different terminology
- Focus on identified gaps

### Paper Evaluation

#### Scoring Rubric (STRICT)
| Score | Meaning | Example |
|-------|---------|---------|
| 10 | Seminal/foundational, directly addresses core question | The paper that introduced the method you're studying |
| 8-9 | Highly relevant, key sub-topic contribution | Strong related work with significant findings |
| 6-7 | Tangentially related, background only | Survey that mentions your topic briefly |
| 1-5 | Not relevant or peripherally connected | Different domain despite keyword overlap |

#### Scoring Rules
1. **Justify every score**: 1-2 sentences explaining the rating
2. **Force ranking**: After scoring, cut the bottom 30%
3. **Auto-save threshold**: ≥7 saves to local library
4. **Be decisive**: If meaningfully relevant, score ≥7

#### Evaluation Pitfalls
- "HPC scheduling" ≠ "HPC log analysis" (score 4, not 7)
- "General ML survey" ≠ "specific ML application" (score 5, not 8)
- Keyword overlap ≠ conceptual relevance

#### Approval Criteria
- At least 3 papers score ≥7
- Coverage score ≥0.5
- Approve only when criteria are satisfied with reasonable confidence
- Request targeted refinement when critical sub-topics are missing

#### Refinement Queries
If requesting more searches:
- Target specific missing sub-topics
- Use DIFFERENT terminology than original queries
- Maximum 2-3 targeted refinement queries

### Literature Synthesis

#### Review Structure
1. **Overview**: High-level summary addressing research question
2. **Source Attribution**: Local library vs. external papers
3. **Coverage Assessment**: Which sub-topics are well-covered
4. **Thematic Organization**: Group papers by research themes
5. **Key Findings**: Major conclusions from the literature
6. **Research Gaps**: What's missing or understudied

#### Synthesis Guidelines
- Address the user's research question directly
- Don't just list papers—analyze and compare
- Identify patterns, contradictions, and trends
- Note methodological approaches across papers
- Highlight seminal works vs. incremental contributions

### Metadata Preservation

When processing papers, preserve ALL fields:
- **Required**: id, title, authors (full array), abstract, year, url, source
- **Scoring**: relevanceScore, relevanceJustification
- **Optional**: doi, venue, citationCount (use null if missing)

Truncate abstract to ~800 chars if very long, but preserve meaning.

## Examples

### Search Plan Example

Research request: "Machine learning for log analysis in distributed systems"

```json
{
  "topic": "ML-based log analysis for distributed systems",
  "subTopics": [
    { "name": "Log parsing and template extraction", "priority": "high", "expectedPaperCount": 10 },
    { "name": "Anomaly detection in logs", "priority": "high", "expectedPaperCount": 12 },
    { "name": "Root cause analysis", "priority": "medium", "expectedPaperCount": 8 },
    { "name": "Log-based failure prediction", "priority": "medium", "expectedPaperCount": 6 }
  ],
  "queryBatches": [
    {
      "subTopic": "Log parsing and template extraction",
      "queries": ["log parsing deep learning", "log template extraction neural", "automated log parsing"],
      "sources": ["semantic_scholar", "arxiv", "dblp"],
      "priority": 1
    }
  ],
  "targetPaperCount": 40,
  "minimumCoveragePerSubTopic": 3
}
```

### Paper Scoring Example

```json
{
  "title": "DeepLog: Anomaly Detection in System Logs using Deep Learning",
  "relevanceScore": 9,
  "relevanceJustification": "Foundational work directly addressing ML for log anomaly detection; introduces LSTM-based approach that became influential in the field."
}
```

```json
{
  "title": "A Survey on Machine Learning Techniques",
  "relevanceScore": 4,
  "relevanceJustification": "General ML survey with no specific focus on logs or distributed systems; only tangentially relevant as background."
}
```

### Literature Summary Structure

```json
{
  "title": "Literature Review: ML-Based Log Analysis",
  "overview": "Recent advances in applying machine learning to system log analysis have focused on three main areas...",
  "sourceAttribution": {
    "localPapers": 5,
    "externalPapers": 12,
    "totalPapers": 17
  },
  "themes": [
    {
      "name": "Deep Learning for Log Parsing",
      "papers": ["DeepLog", "LogParse", "Drain"],
      "insight": "Neural approaches outperform traditional regex-based parsing for heterogeneous log sources"
    }
  ],
  "keyFindings": [
    "LSTM-based models achieve 95%+ accuracy on standard benchmarks",
    "Unsupervised methods show promise for zero-shot detection"
  ],
  "researchGaps": [
    "Limited work on cross-system generalization",
    "Few studies address real-time processing constraints"
  ]
}
```

## Troubleshooting

### "Not enough relevant papers found"
- Check query diversity: are you using synonyms and related terms?
- Broaden scope: remove overly specific constraints
- Check sources: some topics are better covered on arXiv vs. Semantic Scholar

### "Too many low-relevance results"
- Tighten queries: add domain-specific terms
- Use venue/author filters on DBLP
- Increase minScore threshold

### "Coverage gaps persist after multiple searches"
- The gap may reflect actual literature scarcity
- Try adjacent fields: related domains may have relevant work
- Check for survey papers that cite relevant work

### "Scoring inconsistency"
- Re-read the rubric: 6-7 is "tangential", not "somewhat relevant"
- Apply force ranking: bottom 30% must be cut regardless of scores
- Ask: "Does this paper DIRECTLY help answer the research question?"

### "Synthesis feels like a paper list"
- Group by themes, not by paper
- Compare and contrast findings
- Identify patterns and contradictions
- Focus on insights, not summaries

### "Duplicate papers across searches"
- Check paper IDs before adding to results
- Local library papers should be deduplicated automatically
- Use source attribution to track provenance
