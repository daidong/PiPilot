/**
 * Data Analysis Skill
 *
 * Procedural knowledge for Python-based data analysis:
 * - Statistical analysis and visualization
 * - Data transformation and cleaning
 * - Machine learning modeling
 * - Results manifest generation
 *
 * Migrated from:
 * - data-analysis-system (~1250 tokens)
 * - data-analysis-tasks (~450 tokens)
 * - data-code-template (~300 tokens)
 * - data-analyzer-system (~700 tokens)
 * - coordinator-module-data (~125 tokens)
 *
 * Total before: ~2,825 tokens (loaded per agent)
 * After: ~100 tokens (summary) → ~1,400 tokens (full, lazy loaded)
 */

import { defineSkill } from '../../../src/skills/define-skill.js'
import type { Skill } from '../../../src/types/skill.js'

/**
 * Data Analysis Skill
 *
 * Comprehensive guidance for Python data analysis tasks
 * with strict output rules and best practices.
 */
export const dataAnalysisSkill: Skill = defineSkill({
  id: 'data-analysis-skill',
  name: 'Data Analysis',
  shortDescription: 'Python data analysis, visualization, statistics, and ML modeling',

  instructions: {
    summary: `Python data analysis guidance:
- **Runtime Variables**: Use DATA_FILE, FIGURES_DIR, TABLES_DIR, DATA_DIR, RESULTS_FILE (pre-defined)
- **STRICT OUTPUT RULE**: Generate ONLY what user requested (count nouns = count outputs)
- **Results Manifest**: Always call write_results() at end with outputs and summary
- **No Extras**: No bonus plots, summary tables, or supplementary files unless explicitly requested`,

    procedures: `
## Critical Path Rules

### Pre-defined Runtime Variables
The following variables are defined BEFORE your code runs:
\`\`\`python
DATA_FILE    # Absolute path to input data file
FIGURES_DIR  # Absolute path for saving figures
TABLES_DIR   # Absolute path for saving CSV tables
DATA_DIR     # Absolute path for transformed data
RESULTS_FILE # Absolute path for results manifest JSON
\`\`\`

### Path Usage Rules (MUST FOLLOW)
- ✅ Use \`DATA_FILE\` to read input: \`pd.read_csv(DATA_FILE)\`
- ✅ Use \`os.path.join(FIGURES_DIR, "name.png")\` for outputs
- ❌ Do NOT compute or derive paths
- ❌ Do NOT use \`os.path.dirname(__file__)\`
- ❌ Do NOT hardcode any file paths
- ❌ Do NOT save to directories other than the pre-defined ones

## STRICT MINIMAL OUTPUT RULE

**This is critical—violation is a failure.**

1. Count the nouns in user request:
   - "a plot" = 1 figure
   - "two charts" = 2 figures
   - "statistics" = 1 summary table

2. Generate EXACTLY that many outputs:
   - User asks for "a plot" → produce 1 PNG, not 2, not 5
   - User asks for "statistics" → produce 1 CSV, not 10

3. Before every \`plt.savefig()\` or \`df.to_csv()\`:
   - Ask: "Did the user request THIS specific output?"
   - If NO → DELETE that code

4. Do NOT create:
   - Summary tables unless requested
   - Intermediate DataFrames as CSV
   - "Bonus" outputs like activity plots
   - Supplementary analyses

## Results Manifest

Always call \`write_results()\` at the end:

\`\`\`python
write_results(
    outputs=[
        {
            "path": os.path.join(FIGURES_DIR, "scatter.png"),
            "type": "figure",
            "title": "X vs Y Scatter Plot",
            "description": "Correlation visualization",  # optional
            "tags": ["correlation", "scatter"]           # optional
        },
        {
            "path": os.path.join(TABLES_DIR, "stats.csv"),
            "type": "table",
            "title": "Summary Statistics"
        }
    ],
    summary={
        "correlation": 0.85,
        "n_rows": 1000,
        "key_finding": "Strong positive correlation"
    }
)
\`\`\`

## Analysis Tasks

### analyze (Statistical Analysis)
- Compute only the statistics explicitly requested by the user
- Identify correlations/outliers only when requested
- Print key findings to stdout
- Save summary as CSV table only if the user asked for file output

### visualize (Data Visualization)
- Create appropriate plots for data types
- Use matplotlib + seaborn for publication quality
- Add titles, axis labels, legends
- Use clean style (seaborn whitegrid)
- Save as PNG (never plt.show())

### transform (Data Transformation)
- Clean, reshape, or transform data
- Handle missing values, type conversions
- Save transformed dataset as CSV only when requested
- Print summary of changes

### model (Statistical Modeling)
- Build statistical/ML models (sklearn, statsmodels)
- Report performance metrics
- Save results summary as CSV only when requested
- Print key metrics to stdout

## Code Standards

### Required Setup
\`\`\`python
import os
import json
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend
import matplotlib.pyplot as plt
import seaborn as sns
import warnings
warnings.filterwarnings('ignore')
\`\`\`

### Figure Best Practices
\`\`\`python
plt.figure(figsize=(10, 6), dpi=150)
# ... plotting code ...
plt.tight_layout()
plt.savefig(os.path.join(FIGURES_DIR, "name.png"))
plt.close()  # Always close after saving
\`\`\`

### Data Quality Checks
\`\`\`python
# Check for missing values
print(f"Missing values: {df.isnull().sum().sum()}")

# Check data types
print(df.dtypes)

# Basic statistics
print(df.describe())
\`\`\`
`,

    examples: `
## Example: Single Plot Request

User: "Create a scatter plot of column A vs column B"

\`\`\`python
import os
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns

# Read data
df = pd.read_csv(DATA_FILE)

# Create the ONE requested plot
plt.figure(figsize=(10, 6), dpi=150)
sns.scatterplot(data=df, x='A', y='B')
plt.title('A vs B')
plt.xlabel('A')
plt.ylabel('B')
plt.tight_layout()
plt.savefig(os.path.join(FIGURES_DIR, 'scatter_a_vs_b.png'))
plt.close()

# Write results manifest
write_results(
    outputs=[
        {"path": os.path.join(FIGURES_DIR, 'scatter_a_vs_b.png'), "type": "figure", "title": "A vs B Scatter"}
    ],
    summary={"correlation": df['A'].corr(df['B'])}
)
\`\`\`

## Example: Statistics Request

User: "Calculate summary statistics for the dataset"

\`\`\`python
import os
import pandas as pd

df = pd.read_csv(DATA_FILE)

# Calculate statistics
stats = df.describe()
stats.to_csv(os.path.join(TABLES_DIR, 'summary_stats.csv'))

# Print to stdout
print("Summary Statistics:")
print(stats)

write_results(
    outputs=[
        {"path": os.path.join(TABLES_DIR, 'summary_stats.csv'), "type": "table", "title": "Summary Statistics"}
    ],
    summary={"n_rows": len(df), "n_cols": len(df.columns)}
)
\`\`\`

## Anti-Pattern: Over-Generation

User: "Create a histogram of values"

❌ BAD (creates 5 outputs for 1 request):
\`\`\`python
# Histogram
plt.savefig('histogram.png')
# Box plot (NOT REQUESTED)
plt.savefig('boxplot.png')
# Summary stats (NOT REQUESTED)
stats.to_csv('stats.csv')
# Data sample (NOT REQUESTED)
df.head(100).to_csv('sample.csv')
# Correlation matrix (NOT REQUESTED)
plt.savefig('correlation.png')
\`\`\`

✅ GOOD (creates exactly 1 output):
\`\`\`python
plt.figure(figsize=(10, 6), dpi=150)
plt.hist(df['values'], bins=30, edgecolor='black')
plt.title('Distribution of Values')
plt.xlabel('Value')
plt.ylabel('Frequency')
plt.tight_layout()
plt.savefig(os.path.join(FIGURES_DIR, 'histogram.png'))
plt.close()

write_results(
    outputs=[{"path": os.path.join(FIGURES_DIR, 'histogram.png'), "type": "figure", "title": "Value Distribution"}]
)
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "FileNotFoundError for data file"
- Use DATA_FILE variable, not hardcoded path
- Check: \`print(DATA_FILE)\` to verify path
- Ensure file exists before reading

### "Permission denied saving figure"
- Use FIGURES_DIR, TABLES_DIR, DATA_DIR only
- Do not save to arbitrary directories
- Check directory exists: \`os.makedirs(FIGURES_DIR, exist_ok=True)\`

### "Figure not appearing in results"
- Call \`plt.close()\` after \`plt.savefig()\`
- Use \`matplotlib.use('Agg')\` before importing pyplot
- Include figure in write_results() outputs list

### "Results manifest missing"
- Always call write_results() at end of script
- Check RESULTS_FILE path is used correctly
- Ensure outputs list includes all generated files

### "Too many outputs generated"
- Re-read user request: count the nouns
- Delete any code that creates unrequested outputs
- Ask: "Did user ask for THIS?" for each savefig/to_csv

### "Plot quality issues"
- Set \`dpi=150\` for good resolution
- Use \`plt.tight_layout()\` to prevent clipping
- Add proper titles and labels

### "Memory issues with large data"
- Use chunked reading: \`pd.read_csv(DATA_FILE, chunksize=10000)\`
- Select only needed columns
- Use appropriate dtypes: \`dtype={'col': 'category'}\`
`
  },

  tools: ['data-analyze'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 100,
    full: 1400
  },

  tags: ['data', 'analysis', 'python', 'visualization', 'statistics', 'ml']
})

export default dataAnalysisSkill
