---
name: scientific-visualization
description: Meta-skill for publication-ready figures. Use when creating journal submission figures requiring multi-panel layouts, significance annotations, error bars, colorblind-safe palettes, and specific journal formatting (Nature, Science, Cell). Orchestrates matplotlib/seaborn/plotly with publication styles. For quick exploration use seaborn or plotly directly.
category: Visualization
depends: [matplotlib, seaborn]
tags: [science, visualization]
triggers: [publication figure, journal figure, multi-panel figure, figure for Nature, figure for Science, error bars, significance annotation, 做图, 论文配图]
license: MIT license
metadata:
    skill-author: K-Dense Inc.
---

# Scientific Visualization

## Overview

Scientific visualization transforms data into clear, accurate figures for publication. Create journal-ready plots with multi-panel layouts, error bars, significance markers, and colorblind-safe palettes. Export as PDF/EPS/TIFF using matplotlib, seaborn, and plotly for manuscripts.

## When to Use This Skill

This skill should be used when:
- Creating plots or visualizations for scientific manuscripts
- Preparing figures for journal submission (Nature, Science, Cell, PLOS, etc.)
- Ensuring figures are colorblind-friendly and accessible
- Making multi-panel figures with consistent styling
- Exporting figures at correct resolution and format
- Following specific publication guidelines
- Improving existing figures to meet publication standards
- Creating figures that need to work in both color and grayscale

## Quick Start Guide

### Basic Publication-Quality Figure

```python
import matplotlib.pyplot as plt
import numpy as np

# Apply a compact publication style inline so this example runs anywhere
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
    'font.size': 8,
    'axes.labelsize': 9,
    'xtick.labelsize': 7,
    'ytick.labelsize': 7,
    'axes.spines.top': False,
    'axes.spines.right': False,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
})

# Create figure with appropriate size (single column = 3.5 inches)
fig, ax = plt.subplots(figsize=(3.5, 2.5))

# Plot data
x = np.linspace(0, 10, 100)
ax.plot(x, np.sin(x), label='sin(x)')
ax.plot(x, np.cos(x), label='cos(x)')

# Proper labeling with units
ax.set_xlabel('Time (seconds)')
ax.set_ylabel('Amplitude (mV)')
ax.legend(frameon=False)

# Save in publication formats
fig.savefig('figure1.pdf')
fig.savefig('figure1.png', dpi=300)
```

Reusable presets and export helpers live in `@skill/scripts/style_presets.py` and `@skill/scripts/figure_export.py`. Inspect or run those from a shell instead of assuming they are importable from the current notebook or workspace script.

### Using Pre-configured Styles

Journal-specific presets live in `@skill/assets/*.mplstyle` and `@skill/scripts/style_presets.py`.
Do not assume your current Python working directory can open skill-local files directly or import `style_presets` as a global module. Copy the relevant `rcParams` into your script, or run the helper from a shell using the scoped path.

```python
import matplotlib.pyplot as plt

# Example Nature-like settings applied inline
plt.rcParams.update({
    'font.size': 7,
    'axes.labelsize': 8,
    'xtick.labelsize': 6,
    'ytick.labelsize': 6,
    'legend.fontsize': 6,
    'savefig.dpi': 600,
})

# Now create figures - they'll automatically match Nature specifications
fig, ax = plt.subplots(figsize=(3.5, 2.5))
# ... your plotting code ...
```

### Quick Start with Seaborn

For statistical plots, use seaborn with publication styling:

```python
import seaborn as sns
import matplotlib.pyplot as plt

# Apply publication styling inline
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
    'font.size': 8,
    'axes.labelsize': 9,
    'xtick.labelsize': 7,
    'ytick.labelsize': 7,
})
sns.set_theme(style='ticks', context='paper', font_scale=1.1)
sns.set_palette('colorblind')

# Create statistical comparison figure
fig, ax = plt.subplots(figsize=(3.5, 3))
sns.boxplot(data=df, x='treatment', y='response', 
            order=['Control', 'Low', 'High'], palette='Set2', ax=ax)
sns.stripplot(data=df, x='treatment', y='response',
              order=['Control', 'Low', 'High'], 
              color='black', alpha=0.3, size=3, ax=ax)
ax.set_ylabel('Response (μM)')
sns.despine()

# Save figure
fig.savefig('treatment_comparison.pdf')
fig.savefig('treatment_comparison.png', dpi=300)
```

## Core Principles and Best Practices

### 1. Resolution and File Format

**Critical requirements** (detailed in `@skill/references/publication_guidelines.md`):
- **Raster images** (photos, microscopy): 300-600 DPI
- **Line art** (graphs, plots): 600-1200 DPI or vector format
- **Vector formats** (preferred): PDF, EPS, SVG
- **Raster formats**: TIFF, PNG (never JPEG for scientific data)

**Implementation:**
```python
# Save vector + raster outputs directly from matplotlib
fig.savefig('myfigure.pdf', bbox_inches='tight')
fig.savefig('myfigure.png', dpi=300, bbox_inches='tight')
```

If you want reusable export helpers, inspect or run `@skill/scripts/figure_export.py` from the shell.

### 2. Color Selection - Colorblind Accessibility

**Always use colorblind-friendly palettes** (detailed in `@skill/references/color_palettes.md`):

**Recommended: Okabe-Ito palette** (distinguishable by all types of color blindness):
```python
okabe_ito = ['#E69F00', '#56B4E9', '#009E73', '#F0E442',
             '#0072B2', '#D55E00', '#CC79A7', '#000000']
plt.rcParams['axes.prop_cycle'] = plt.cycler(color=okabe_ito)
```

Reusable palette definitions also live in `@skill/assets/color_palettes.py`.

**For heatmaps/continuous data:**
- Use perceptually uniform colormaps: `viridis`, `plasma`, `cividis`
- Avoid red-green diverging maps (use `PuOr`, `RdBu`, `BrBG` instead)
- Never use `jet` or `rainbow` colormaps

**Always test figures in grayscale** to ensure interpretability.

### 3. Typography and Text

**Font guidelines** (detailed in `@skill/references/publication_guidelines.md`):
- Sans-serif fonts: Arial, Helvetica, Calibri
- Minimum sizes at **final print size**:
  - Axis labels: 7-9 pt
  - Tick labels: 6-8 pt
  - Panel labels: 8-12 pt (bold)
- Sentence case for labels: "Time (hours)" not "TIME (HOURS)"
- Always include units in parentheses

**Implementation:**
```python
# Set fonts globally
import matplotlib as mpl
mpl.rcParams['font.family'] = 'sans-serif'
mpl.rcParams['font.sans-serif'] = ['Arial', 'Helvetica']
mpl.rcParams['font.size'] = 8
mpl.rcParams['axes.labelsize'] = 9
mpl.rcParams['xtick.labelsize'] = 7
mpl.rcParams['ytick.labelsize'] = 7
```

### 4. Figure Dimensions

**Journal-specific widths** (detailed in `@skill/references/journal_requirements.md`):
- **Nature**: Single 89 mm, Double 183 mm
- **Science**: Single 55 mm, Double 175 mm
- **Cell**: Single 85 mm, Double 178 mm

**Check figure size compliance:**
```python
fig = plt.figure(figsize=(3.5, 3))  # 89 mm for Nature
width_mm, height_mm = fig.get_size_inches() * 25.4
print(f'{width_mm:.1f} mm x {height_mm:.1f} mm')
```

Compare those values against `@skill/references/journal_requirements.md`, or reuse the helper in `@skill/scripts/figure_export.py`.

### 5. Multi-Panel Figures

**Best practices:**
- Label panels with bold letters: **A**, **B**, **C** (uppercase for most journals, lowercase for Nature)
- Maintain consistent styling across all panels
- Align panels along edges where possible
- Use adequate white space between panels

**Example implementation** (see `@skill/references/matplotlib_examples.md` for complete code):
```python
from string import ascii_uppercase

fig = plt.figure(figsize=(7, 4))
gs = fig.add_gridspec(2, 2, hspace=0.4, wspace=0.4)

ax1 = fig.add_subplot(gs[0, 0])
ax2 = fig.add_subplot(gs[0, 1])
# ... create other panels ...

# Add panel labels
for i, ax in enumerate([ax1, ax2, ...]):
    ax.text(-0.15, 1.05, ascii_uppercase[i], transform=ax.transAxes,
            fontsize=10, fontweight='bold', va='top')
```

## Common Tasks

### Task 1: Create a Publication-Ready Line Plot

See `@skill/references/matplotlib_examples.md` Example 1 for complete code.

**Key steps:**
1. Apply publication style
2. Set appropriate figure size for target journal
3. Use colorblind-friendly colors
4. Add error bars with correct representation (SEM, SD, or CI)
5. Label axes with units
6. Remove unnecessary spines
7. Save in vector format

**Using seaborn for automatic confidence intervals:**
```python
import seaborn as sns
fig, ax = plt.subplots(figsize=(5, 3))
sns.lineplot(data=timeseries, x='time', y='measurement',
             hue='treatment', errorbar=('ci', 95), 
             markers=True, ax=ax)
ax.set_xlabel('Time (hours)')
ax.set_ylabel('Measurement (AU)')
sns.despine()
```

### Task 2: Create a Multi-Panel Figure

See `@skill/references/matplotlib_examples.md` Example 2 for complete code.

**Key steps:**
1. Use `GridSpec` for flexible layout
2. Ensure consistent styling across panels
3. Add bold panel labels (A, B, C, etc.)
4. Align related panels
5. Verify all text is readable at final size

### Task 3: Create a Heatmap with Proper Colormap

See `@skill/references/matplotlib_examples.md` Example 4 for complete code.

**Key steps:**
1. Use perceptually uniform colormap (`viridis`, `plasma`, `cividis`)
2. Include labeled colorbar
3. For diverging data, use colorblind-safe diverging map (`RdBu_r`, `PuOr`)
4. Set appropriate center value for diverging maps
5. Test appearance in grayscale

**Using seaborn for correlation matrices:**
```python
import seaborn as sns
fig, ax = plt.subplots(figsize=(5, 4))
corr = df.corr()
mask = np.triu(np.ones_like(corr, dtype=bool))
sns.heatmap(corr, mask=mask, annot=True, fmt='.2f',
            cmap='RdBu_r', center=0, square=True,
            linewidths=1, cbar_kws={'shrink': 0.8}, ax=ax)
```

### Task 4: Prepare Figure for Specific Journal

**Workflow:**
1. Check journal requirements: `@skill/references/journal_requirements.md`
2. Set figure width, font sizes, and export DPI explicitly in matplotlib, or copy the relevant preset from `@skill/scripts/style_presets.py`
3. Create figure at the final intended print size
4. Export to the journal's required formats directly with `fig.savefig(...)`, or reuse `@skill/scripts/figure_export.py`

### Task 5: Fix an Existing Figure to Meet Publication Standards

**Checklist approach** (full checklist in `@skill/references/publication_guidelines.md`):

1. **Check resolution**: Verify DPI meets journal requirements
2. **Check file format**: Use vector for plots, TIFF/PNG for images
3. **Check colors**: Ensure colorblind-friendly
4. **Check fonts**: Minimum 6-7 pt at final size, sans-serif
5. **Check labels**: All axes labeled with units
6. **Check size**: Matches journal column width
7. **Test grayscale**: Figure interpretable without color
8. **Remove chart junk**: No unnecessary grids, 3D effects, shadows

### Task 6: Create Colorblind-Friendly Visualizations

**Strategy:**
1. Use approved palettes from `@skill/assets/color_palettes.py`
2. Add redundant encoding (line styles, markers, patterns)
3. Test with colorblind simulator
4. Ensure grayscale compatibility

**Example:**
```python
import matplotlib.pyplot as plt

okabe_ito = ['#E69F00', '#56B4E9', '#009E73', '#F0E442',
             '#0072B2', '#D55E00', '#CC79A7', '#000000']
plt.rcParams['axes.prop_cycle'] = plt.cycler(color=okabe_ito)

# Add redundant encoding beyond color
line_styles = ['-', '--', '-.', ':']
markers = ['o', 's', '^', 'v']

for i, (data, label) in enumerate(datasets):
    plt.plot(x, data, linestyle=line_styles[i % 4],
             marker=markers[i % 4], label=label)
```

## Statistical Rigor

**Always include:**
- Error bars (SD, SEM, or CI - specify which in caption)
- Sample size (n) in figure or caption
- Statistical significance markers (*, **, ***)
- Individual data points when possible (not just summary statistics)

**Example with statistics:**
```python
# Show individual points with summary statistics
ax.scatter(x_jittered, individual_points, alpha=0.4, s=8)
ax.errorbar(x, means, yerr=sems, fmt='o', capsize=3)

# Mark significance
ax.text(1.5, max_y * 1.1, '***', ha='center', fontsize=8)
```

## Working with Different Plotting Libraries

### Matplotlib
- Most control over publication details
- Best for complex multi-panel figures
- Use provided style files for consistent formatting
- See `@skill/references/matplotlib_examples.md` for extensive examples

### Seaborn

Seaborn provides a high-level, dataset-oriented interface for statistical graphics, built on matplotlib. It excels at creating publication-quality statistical visualizations with minimal code while maintaining full compatibility with matplotlib customization.

**Key advantages for scientific visualization:**
- Automatic statistical estimation and confidence intervals
- Built-in support for multi-panel figures (faceting)
- Colorblind-friendly palettes by default
- Dataset-oriented API using pandas DataFrames
- Semantic mapping of variables to visual properties

#### Quick Start with Publication Style

Always apply matplotlib publication styles first, then configure seaborn:

```python
import seaborn as sns
import matplotlib.pyplot as plt

# Apply publication style inline
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
    'font.size': 8,
    'axes.labelsize': 9,
    'xtick.labelsize': 7,
    'ytick.labelsize': 7,
})

# Configure seaborn for publication
sns.set_theme(style='ticks', context='paper', font_scale=1.1)
sns.set_palette('colorblind')  # Use colorblind-safe palette

# Create figure
fig, ax = plt.subplots(figsize=(3.5, 2.5))
sns.scatterplot(data=df, x='time', y='response', 
                hue='treatment', style='condition', ax=ax)
sns.despine()  # Remove top and right spines
```

#### Common Plot Types for Publications

**Statistical comparisons:**
```python
# Box plot with individual points for transparency
fig, ax = plt.subplots(figsize=(3.5, 3))
sns.boxplot(data=df, x='treatment', y='response', 
            order=['Control', 'Low', 'High'], palette='Set2', ax=ax)
sns.stripplot(data=df, x='treatment', y='response',
              order=['Control', 'Low', 'High'], 
              color='black', alpha=0.3, size=3, ax=ax)
ax.set_ylabel('Response (μM)')
sns.despine()
```

**Distribution analysis:**
```python
# Violin plot with split comparison
fig, ax = plt.subplots(figsize=(4, 3))
sns.violinplot(data=df, x='timepoint', y='expression',
               hue='treatment', split=True, inner='quartile', ax=ax)
ax.set_ylabel('Gene Expression (AU)')
sns.despine()
```

**Correlation matrices:**
```python
# Heatmap with proper colormap and annotations
fig, ax = plt.subplots(figsize=(5, 4))
corr = df.corr()
mask = np.triu(np.ones_like(corr, dtype=bool))  # Show only lower triangle
sns.heatmap(corr, mask=mask, annot=True, fmt='.2f',
            cmap='RdBu_r', center=0, square=True,
            linewidths=1, cbar_kws={'shrink': 0.8}, ax=ax)
plt.tight_layout()
```

**Time series with confidence bands:**
```python
# Line plot with automatic CI calculation
fig, ax = plt.subplots(figsize=(5, 3))
sns.lineplot(data=timeseries, x='time', y='measurement',
             hue='treatment', style='replicate',
             errorbar=('ci', 95), markers=True, dashes=False, ax=ax)
ax.set_xlabel('Time (hours)')
ax.set_ylabel('Measurement (AU)')
sns.despine()
```

#### Multi-Panel Figures with Seaborn

**Using FacetGrid for automatic faceting:**
```python
# Create faceted plot
g = sns.relplot(data=df, x='dose', y='response',
                hue='treatment', col='cell_line', row='timepoint',
                kind='line', height=2.5, aspect=1.2,
                errorbar=('ci', 95), markers=True)
g.set_axis_labels('Dose (μM)', 'Response (AU)')
g.set_titles('{row_name} | {col_name}')
sns.despine()

# Save with correct DPI
g.figure.savefig('figure_facets.pdf', bbox_inches='tight')
g.figure.savefig('figure_facets.png', dpi=300, bbox_inches='tight')
```

**Combining seaborn with matplotlib subplots:**
```python
# Create custom multi-panel layout
fig, axes = plt.subplots(2, 2, figsize=(7, 6))

# Panel A: Scatter with regression
sns.regplot(data=df, x='predictor', y='response', ax=axes[0, 0])
axes[0, 0].text(-0.15, 1.05, 'A', transform=axes[0, 0].transAxes,
                fontsize=10, fontweight='bold')

# Panel B: Distribution comparison
sns.violinplot(data=df, x='group', y='value', ax=axes[0, 1])
axes[0, 1].text(-0.15, 1.05, 'B', transform=axes[0, 1].transAxes,
                fontsize=10, fontweight='bold')

# Panel C: Heatmap
sns.heatmap(correlation_data, cmap='viridis', ax=axes[1, 0])
axes[1, 0].text(-0.15, 1.05, 'C', transform=axes[1, 0].transAxes,
                fontsize=10, fontweight='bold')

# Panel D: Time series
sns.lineplot(data=timeseries, x='time', y='signal', 
             hue='condition', ax=axes[1, 1])
axes[1, 1].text(-0.15, 1.05, 'D', transform=axes[1, 1].transAxes,
                fontsize=10, fontweight='bold')

plt.tight_layout()
sns.despine()
```

#### Color Palettes for Publications

Seaborn includes several colorblind-safe palettes:

```python
# Use built-in colorblind palette (recommended)
sns.set_palette('colorblind')

# Or specify custom colorblind-safe colors (Okabe-Ito)
okabe_ito = ['#E69F00', '#56B4E9', '#009E73', '#F0E442',
             '#0072B2', '#D55E00', '#CC79A7', '#000000']
sns.set_palette(okabe_ito)

# For heatmaps and continuous data
sns.heatmap(data, cmap='viridis')  # Perceptually uniform
sns.heatmap(corr, cmap='RdBu_r', center=0)  # Diverging, centered
```

#### Choosing Between Axes-Level and Figure-Level Functions

**Axes-level functions** (e.g., `scatterplot`, `boxplot`, `heatmap`):
- Use when building custom multi-panel layouts
- Accept `ax=` parameter for precise placement
- Better integration with matplotlib subplots
- More control over figure composition

```python
fig, ax = plt.subplots(figsize=(3.5, 2.5))
sns.scatterplot(data=df, x='x', y='y', hue='group', ax=ax)
```

**Figure-level functions** (e.g., `relplot`, `catplot`, `displot`):
- Use for automatic faceting by categorical variables
- Create complete figures with consistent styling
- Great for exploratory analysis
- Use `height` and `aspect` for sizing

```python
g = sns.relplot(data=df, x='x', y='y', col='category', kind='scatter')
```

#### Statistical Rigor with Seaborn

Seaborn automatically computes and displays uncertainty:

```python
# Line plot: shows mean ± 95% CI by default
sns.lineplot(data=df, x='time', y='value', hue='treatment',
             errorbar=('ci', 95))  # Can change to 'sd', 'se', etc.

# Bar plot: shows mean with bootstrapped CI
sns.barplot(data=df, x='treatment', y='response',
            errorbar=('ci', 95), capsize=0.1)

# Always specify error type in figure caption:
# "Error bars represent 95% confidence intervals"
```

#### Best Practices for Publication-Ready Seaborn Figures

1. **Always set publication theme first:** `sns.set_theme(style='ticks', context='paper', font_scale=1.1)`

2. **Use colorblind-safe palettes:** `sns.set_palette('colorblind')`

3. **Remove unnecessary elements:** `sns.despine()`

4. **Control figure size appropriately:** use `fig, ax = plt.subplots(figsize=(3.5, 2.5))` for axes-level plots, or `sns.relplot(..., height=3, aspect=1.2)` for figure-level plots.

5. **Show individual data points when possible:** combine summary and raw data, for example `sns.boxplot(...)` plus `sns.stripplot(..., alpha=0.3)`.

6. **Include proper labels with units:** `ax.set_xlabel('Time (hours)')` and `ax.set_ylabel('Expression (AU)')`

7. **Export at correct resolution:** `fig.savefig('figure_name.pdf', bbox_inches='tight')` and `fig.savefig('figure_name.png', dpi=300, bbox_inches='tight')`

#### Advanced Seaborn Techniques

**Pairwise relationships for exploratory analysis:**
```python
# Quick overview of all relationships
g = sns.pairplot(data=df, hue='condition', 
                 vars=['gene1', 'gene2', 'gene3'],
                 corner=True, diag_kind='kde', height=2)
```

**Hierarchical clustering heatmap:**
```python
# Cluster samples and features
g = sns.clustermap(expression_data, method='ward', 
                   metric='euclidean', z_score=0,
                   cmap='RdBu_r', center=0, 
                   figsize=(10, 8), 
                   row_colors=condition_colors,
                   cbar_kws={'label': 'Z-score'})
```

**Joint distributions with marginals:**
```python
# Bivariate distribution with context
g = sns.jointplot(data=df, x='gene1', y='gene2',
                  hue='treatment', kind='scatter',
                  height=6, ratio=4, marginal_kws={'kde': True})
```

#### Common Seaborn Issues and Solutions

**Issue: Legend outside plot area**
```python
g = sns.relplot(...)
g._legend.set_bbox_to_anchor((0.9, 0.5))
```

**Issue: Overlapping labels**
```python
plt.xticks(rotation=45, ha='right')
plt.tight_layout()
```

**Issue: Text too small at final size**
```python
sns.set_context('paper', font_scale=1.2)  # Increase if needed
```

#### Additional Resources

For more detailed seaborn information, see:
- `@skill:seaborn/SKILL.md` - Comprehensive seaborn documentation
- `@skill:seaborn/references/examples.md` - Practical use cases
- `@skill:seaborn/references/function_reference.md` - Complete API reference
- `@skill:seaborn/references/objects_interface.md` - Modern declarative API

### Plotly
- Interactive figures for exploration
- Export static images for publication
- Configure for publication quality:
```python
fig.update_layout(
    font=dict(family='Arial, sans-serif', size=10),
    plot_bgcolor='white',
    # ... see matplotlib_examples.md Example 8
)
fig.write_image('figure.png', scale=3)  # scale=3 gives ~300 DPI
```

## Resources

### References Directory

**Load these as needed for detailed information:**

- **`@skill/references/publication_guidelines.md`**: Comprehensive best practices
  - Resolution and file format requirements
  - Typography guidelines
  - Layout and composition rules
  - Statistical rigor requirements
  - Complete publication checklist

- **`@skill/references/color_palettes.md`**: Color usage guide
  - Colorblind-friendly palette specifications with RGB values
  - Sequential and diverging colormap recommendations
  - Testing procedures for accessibility
  - Domain-specific palettes (genomics, microscopy)

- **`@skill/references/journal_requirements.md`**: Journal-specific specifications
  - Technical requirements by publisher
  - File format and DPI specifications
  - Figure dimension requirements
  - Quick reference table

- **`@skill/references/matplotlib_examples.md`**: Practical code examples
  - 10 complete working examples
  - Line plots, bar plots, heatmaps, multi-panel figures
  - Journal-specific figure examples
  - Tips for each library (matplotlib, seaborn, plotly)

### Scripts Directory

**Use these helper scripts for automation:**

- **`@skill/scripts/figure_export.py`**: Export utilities
  - `save_publication_figure()`: Save in multiple formats with correct DPI
  - `save_for_journal()`: Use journal-specific requirements automatically
  - `check_figure_size()`: Verify dimensions meet journal specs
  - Run directly: `python @skill/scripts/figure_export.py` for examples

- **`@skill/scripts/style_presets.py`**: Pre-configured styles
  - `apply_publication_style()`: Apply preset styles (default, nature, science, cell)
  - `set_color_palette()`: Quick palette switching
  - `configure_for_journal()`: One-command journal configuration
  - Run directly: `python @skill/scripts/style_presets.py` to see examples

### Assets Directory

**Use these files in figures:**

- **`@skill/assets/color_palettes.py`**: Importable color definitions
  - All recommended palettes as Python constants
  - `apply_palette()` helper function
  - Copy definitions from this file if you need them in notebooks/scripts

- **Matplotlib style files**: copy settings from these files, or resolve their absolute path before calling `plt.style.use()`
  - `@skill/assets/publication.mplstyle`: General publication quality
  - `@skill/assets/nature.mplstyle`: Nature journal specifications
  - `@skill/assets/presentation.mplstyle`: Larger fonts for posters/slides

## Workflow Summary

**Recommended workflow for creating publication figures:**

1. **Plan**: Determine target journal, figure type, and content
2. **Configure**: Apply appropriate style for journal, for example `plt.rcParams.update({'font.size': 7, 'axes.labelsize': 8, 'savefig.dpi': 600})`
3. **Create**: Build figure with proper labels, colors, statistics
4. **Verify**: Check size, fonts, colors, accessibility, for example `width_mm, height_mm = fig.get_size_inches() * 25.4`
5. **Export**: Save in required formats, for example `fig.savefig('figure1.pdf', bbox_inches='tight')` and `fig.savefig('figure1.png', dpi=300, bbox_inches='tight')`
6. **Review**: View at final size in manuscript context

## Common Pitfalls to Avoid

1. **Font too small**: Text unreadable when printed at final size
2. **JPEG format**: Never use JPEG for graphs/plots (creates artifacts)
3. **Red-green colors**: ~8% of males cannot distinguish
4. **Low resolution**: Pixelated figures in publication
5. **Missing units**: Always label axes with units
6. **3D effects**: Distorts perception, avoid completely
7. **Chart junk**: Remove unnecessary gridlines, decorations
8. **Truncated axes**: Start bar charts at zero unless scientifically justified
9. **Inconsistent styling**: Different fonts/colors across figures in same manuscript
10. **No error bars**: Always show uncertainty

## Final Checklist

Before submitting figures, verify:

- [ ] Resolution meets journal requirements (300+ DPI)
- [ ] File format is correct (vector for plots, TIFF for images)
- [ ] Figure size matches journal specifications
- [ ] All text readable at final size (≥6 pt)
- [ ] Colors are colorblind-friendly
- [ ] Figure works in grayscale
- [ ] All axes labeled with units
- [ ] Error bars present with definition in caption
- [ ] Panel labels present and consistent
- [ ] No chart junk or 3D effects
- [ ] Fonts consistent across all figures
- [ ] Statistical significance clearly marked
- [ ] Legend is clear and complete

Use this skill to ensure scientific figures meet the highest publication standards while remaining accessible to all readers.
