/**
 * Audit visualization theme bridge.
 *
 * Force-graph renders on a <canvas>, which means we can't use CSS classes —
 * we need concrete color strings at paint time. This module reads the
 * project's CSS custom properties (set by html.dark / html.light) and
 * exposes them as a typed map. Switching theme via the ui-store causes
 * the hook to re-resolve, so the graph re-paints with the right palette.
 */

import { useEffect, useState } from 'react'
import { useUIStore } from '../../../stores/ui-store'
import type { EdgeRel, NodeKind } from '../../../../../../lib/audit-graph/index'

export interface AuditPalette {
  // Node fills per kind
  kind: Record<NodeKind, string>
  // Edge colors per relation (rgba so callers can derive variants)
  rel: Record<EdgeRel, string>
  // Taint target — the color tinted nodes/edges shift toward
  taint: [number, number, number]
  // Canvas label color — matches --color-text so it tracks light/dark theme.
  canvasLabel: string
  // Warning color (--color-status-warning) — used for the citation-flag badge.
  warn: string
}

function readVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function withAlpha(color: string, alpha: number): string {
  // Accept hex (#rrggbb), rgb(), or rgba() and project to rgba with the given alpha.
  const hex = hexToRgb(color)
  if (hex) return `rgba(${hex[0]},${hex[1]},${hex[2]},${alpha})`
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(',').map(s => s.trim())
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`
  }
  return color
}

function readPalette(): AuditPalette {
  const accent  = readVar('--color-accent')          || '#34d0ba'
  const accent2 = readVar('--color-accent-2')        || '#818cf8'
  const accent2Soft = readVar('--color-accent-2-soft') || '#a5b4fc'
  const success = readVar('--color-status-success') || '#36c459'
  const warning = readVar('--color-status-warning') || '#e0a820'
  const error   = readVar('--color-status-error')   || '#ef5350'
  const muted   = readVar('--color-text-muted')     || '#4a5660'
  const secondary = readVar('--color-text-secondary') || '#7e8d98'
  const info    = readVar('--color-status-info')    || '#60a5fa'
  // Skill nodes get a dedicated violet, distinct from trace (accent2) and the
  // sky-blue file/info hue, so "what guided this step" reads at a glance.
  const skill   = readVar('--color-status-skill')   || '#c084fc'

  const errorRgb = hexToRgb(error) || [239, 83, 80]
  const text = readVar('--color-text') || '#cdd5db'

  return {
    kind: {
      session:  muted,
      trace:    accent2,
      step:     accent,
      tool:     warning,
      chat:     secondary,
      artifact: success,
      file:     info,                       // file = informational (sky blue)
      dir:      accent2Soft,
      span:     muted,
      skill:    skill,
    },
    rel: {
      contains:  withAlpha(muted, 0.18),
      precedes:  withAlpha(accent, 0.55),
      invokes:   withAlpha(warning, 0.6),
      returns:   withAlpha(warning, 0.45),
      'sub-llm': withAlpha(secondary, 0.4),
      reads:     withAlpha(info, 0.55),
      writes:    withAlpha(success, 0.7),
      creates:   withAlpha(success, 0.85),
      retrieved: withAlpha(info, 0.55),
      mentions:  withAlpha(muted, 0.35),
      listed:    withAlpha(accent2Soft, 0.45),
      applies:   withAlpha(skill, 0.55),
    },
    taint: errorRgb,
    canvasLabel: text,
    warn: warning,
  }
}

/** Mix an rgba/hex color toward a target rgb at the given factor (0–1). */
export function tintToward(color: string, target: [number, number, number], mix = 0.55): string {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
  if (m) {
    const r = Math.round(+m[1] * (1 - mix) + target[0] * mix)
    const g = Math.round(+m[2] * (1 - mix) + target[1] * mix)
    const b = Math.round(+m[3] * (1 - mix) + target[2] * mix)
    const a = m[4] ?? '1'
    return `rgba(${r},${g},${b},${a})`
  }
  const hex = hexToRgb(color)
  if (hex) {
    const r = Math.round(hex[0] * (1 - mix) + target[0] * mix)
    const g = Math.round(hex[1] * (1 - mix) + target[1] * mix)
    const b = Math.round(hex[2] * (1 - mix) + target[2] * mix)
    return `rgb(${r},${g},${b})`
  }
  return color
}

export function useAuditPalette(): AuditPalette {
  const theme = useUIStore(s => s.theme)
  const [palette, setPalette] = useState<AuditPalette>(() => readPalette())
  useEffect(() => {
    // Wait one frame so html.dark/.light has been applied before we read.
    const id = requestAnimationFrame(() => setPalette(readPalette()))
    return () => cancelAnimationFrame(id)
  }, [theme])
  return palette
}
