# Matplotlib Subagent Quickstart

Use object-oriented matplotlib:

1. `fig, ax = plt.subplots(...)` for single chart
2. `fig, axes = plt.subplots(r, c, ...)` for multi-panel figures
3. Label axes/title/legend explicitly
4. Use `ax.grid(True, alpha=0.3)` unless user requests no grid
5. Save figure with:
   `plt.savefig(os.path.join(FIGURES_DIR, "<name>.png"), dpi=150, bbox_inches="tight")`
6. Call `plt.close()` after saving

Common mappings:

- line trend -> `ax.plot(...)`
- relationship -> `ax.scatter(...)`
- category compare -> `ax.bar(...)`
- distribution -> `ax.hist(...)` or `ax.boxplot(...)`
- matrix/correlation -> `ax.imshow(...)` + `plt.colorbar(...)`

Style defaults:

- publication: clean axes, thicker lines, readable labels
- presentation: larger font and line width
- web: moderate DPI and compact layout

Output discipline:

- Create only figures explicitly requested by user
- Prefer one figure per requested chart unless user asks for dashboard/subplots
