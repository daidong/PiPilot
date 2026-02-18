# Color Spec v1 (YOLO Researcher Desktop)

## 1. Purpose

Reduce cognitive load by making color a strict semantic channel, not a layout/decorative channel.

This spec applies to:

- `examples/yolo-researcher/desktop/src/renderer/global.css`
- `examples/yolo-researcher/desktop/src/renderer/components/*`

## 2. Current Problems (from code audit)

- Too many accent colors are active at the same time (`teal/sky/amber/rose/emerald/violet/...`).
- Status semantics and decorative accents are mixed.
- Multiple components still use ad-hoc status color classes (`emerald/rose/amber/...`) instead of one shared token contract.
- Local style overrides (`style={...}`) reduce consistency and increase drift risk.

## 3. Design Principles

1. Neutral-first: most UI is neutral surfaces, borders, and text.
2. Single-accent: one brand accent per view.
3. Status-lane only: status colors appear only in status primitives (badge, dot, alert, terminal stream labels).
4. Non-color backup: every status must also have text/icon/position cue.
5. Token-only: no raw hex in components.

## 4. Token Model

Use 5 groups only.

### 4.1 Surface tokens

- `--sys-surface-canvas`
- `--sys-surface-panel`
- `--sys-surface-raised`
- `--sys-surface-hover`
- `--sys-surface-selected`

### 4.2 Text tokens

- `--sys-text-primary`
- `--sys-text-secondary`
- `--sys-text-muted`
- `--sys-text-inverse`

### 4.3 Border tokens

- `--sys-border-default`
- `--sys-border-subtle`
- `--sys-border-strong`
- `--sys-border-focus`

### 4.4 Interactive tokens (single accent)

- `--sys-accent-primary`
- `--sys-accent-primary-hover`
- `--sys-accent-soft-bg`
- `--sys-accent-soft-border`
- `--sys-accent-on-primary`

### 4.5 Status tokens

- success: `--sys-status-success-{fg,bg,border}`
- warning: `--sys-status-warning-{fg,bg,border}`
- danger: `--sys-status-danger-{fg,bg,border}`
- info: `--sys-status-info-{fg,bg,border}`
- neutral: `--sys-status-neutral-{fg,bg,border}`

## 5. Baseline Palette (v1)

Dark theme:

- Accent: teal only.
- Keep neutral contrast stable, keep status colors low saturation on bg.

Suggested dark values:

- `--sys-surface-canvas: #0a0a0a`
- `--sys-surface-panel: #171717`
- `--sys-surface-raised: #202225`
- `--sys-surface-hover: rgba(255,255,255,0.05)`
- `--sys-surface-selected: rgba(255,255,255,0.10)`
- `--sys-text-primary: #f5f5f5`
- `--sys-text-secondary: #c4c4c4`
- `--sys-text-muted: #8a8a8a`
- `--sys-border-default: #2a2a2a`
- `--sys-border-subtle: #222222`
- `--sys-border-strong: #4a4a4a`
- `--sys-accent-primary: #14b8a6`
- `--sys-accent-primary-hover: #0d9488`

Light theme:

- Mirror semantic meaning, not exact luminance inversion.
- Accent remains same hue family.

## 6. Color Budget Rules

Per screen:

1. Max 1 non-status accent hue at a time.
2. Max 4 status hues in system, but max 2 status hues in one card/list block.
3. High-saturation area should stay under 10% of viewport.
4. Body text never uses status/accent colors.

## 7. Semantic Mapping Rules

1. `success`: completed/healthy/pass.
2. `warning`: needs attention but still progressing (`no_delta`, paused, checkpoint needed).
3. `danger`: failed/blocked/action required.
4. `info`: running/in-progress/partial.
5. `neutral`: idle/unknown/default.

Hard rule:

- Do not use `danger` as decorative heading color.

## 8. Component Mapping (v1)

### 8.1 StatusBar

- Running dot uses `status.info`.
- Idle uses `status.neutral`.
- Paused uses `status.warning`.
- Failed uses `status.danger`.

### 8.2 ControlPanel

- Section labels use text tokens only.
- Keep accent only for primary CTA and focused input ring.
- Remove per-section accent headers (`teal/sky` split).

### 8.3 EvidenceView / TerminalView

- Keep stream semantics:
  - stdout label -> `status.success.fg`
  - stderr label -> `status.danger.fg`
- Artifact chips and filter chips use neutral styles; active state uses accent.

### 8.4 ActivityView

- Type card backgrounds should be neutral.
- Type distinction moves to icon + label text, not multi-hue cards.

## 9. Accessibility Requirements

1. Text contrast:
   - normal text >= 4.5:1
   - large text >= 3:1
2. UI boundaries and focus indicators >= 3:1.
3. Status recognition cannot depend on color only.
4. Keyboard focus must always use `--sys-border-focus` ring.

## 10. Migration Plan

Phase 1: token layer freeze

- Add `--sys-*` tokens in `global.css`.
- Keep old `--color-*` as temporary aliases to `--sys-*`.

Phase 2: semantic adapters

- Replace `toneForStatus` and status class helpers with token-based classes.
- Remove direct `emerald/rose/amber/sky` utility classes in status rendering.

Phase 3: component cleanup

- Replace inline color literals and ad-hoc style objects with token classes.
- Convert multi-color cards to neutral cards + icon labels.

Phase 4: guardrails

- Add lint rule/check script:
  - forbid hex/rgb/hsl in `components/*.tsx` except `global.css`.
  - forbid Tailwind status color utilities in renderer components.

## 11. Acceptance Criteria (v1 done)

1. No component-level raw color literals outside `global.css`.
2. Status visuals pass through one shared semantic helper.
3. Side panel, tabs, evidence list show neutral-first hierarchy.
4. Designer/dev can change accent hue by editing <= 6 token values.
5. Two user tasks improve in test:
   - “find current blocker”
   - “find latest progress evidence”

