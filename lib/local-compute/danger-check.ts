/**
 * Danger check — a cheap, rule-based scan for *genuinely* dangerous shell
 * commands (RFC-016 §4.4).
 *
 * Local compute auto-runs by default (no per-task approval). The control
 * that remains is a one-tap "Run anyway?" confirm for commands that could
 * irreversibly damage the machine or exfiltrate data — mirroring Claude
 * Code's destructive-command warnings. This is NOT an LLM plan review and
 * NOT a security sandbox; it is a small allowlist-of-shapes-to-warn-on so
 * the common case (a probe, a training run, a data crunch) flows without
 * friction while `rm -rf …` / `curl … | sh` / `dd of=/dev/…` get a gate.
 *
 * Philosophy: warn ONLY when risky (false positives cost the user a click;
 * we keep the patterns specific). Everything not flagged auto-runs.
 */

export interface DangerFinding {
  /** Short machine-ish tag, e.g. 'recursive-delete'. */
  pattern: string
  /** Human-readable reason shown in the one-tap confirm card. */
  reason: string
}

interface Rule {
  pattern: string
  reason: string
  test: RegExp
}

const RULES: Rule[] = [
  {
    pattern: 'recursive-delete',
    reason: 'Recursive force-delete (rm -rf) — can wipe directories irreversibly.',
    // rm with both recursive and force flags, in any order / combined form.
    test: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\w*\s+-f|-f\w*\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i,
  },
  {
    pattern: 'disk-write',
    reason: 'Raw disk / device write (dd of=/dev, mkfs, shred) — can destroy a filesystem.',
    test: /\b(?:dd\b[^|;]*\bof=\/dev\/|mkfs(?:\.\w+)?\b|shred\b)/i,
  },
  {
    pattern: 'device-redirect',
    reason: 'Redirect into a block device (> /dev/sd…) — can corrupt a disk.',
    test: />\s*\/dev\/(?:sd|nvme|disk|hd)/i,
  },
  {
    pattern: 'pipe-to-shell',
    reason: 'Download piped straight into a shell (curl/wget … | sh) — runs unreviewed remote code.',
    test: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|fi|da)?sh\b/i,
  },
  {
    pattern: 'fork-bomb',
    reason: 'Fork bomb — exhausts process table and can hang the machine.',
    test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    pattern: 'privilege-escalation',
    reason: 'sudo / privilege escalation — runs with elevated permissions.',
    test: /\bsudo\b|\bdoas\b/i,
  },
  {
    pattern: 'broad-permission-change',
    reason: 'Recursive permission/ownership change (chmod -R 777, chown -R) on a broad path.',
    test: /\b(?:chmod\s+-[a-z]*R\w*\s+0?777|chown\s+-[a-z]*R)\b/i,
  },
  {
    pattern: 'mass-kill',
    reason: 'Mass process kill (kill -9 -1 / killall) — can take down unrelated work.',
    test: /\bkill(?:all)?\b[^|;]*\b(?:-9\s+-1|-1)\b|\bkillall\b/i,
  },
  {
    pattern: 'system-path-write',
    reason: 'Write/delete under a system path (/etc, /usr, /bin, /System) — can break the OS.',
    test: /\b(?:rm|mv|cp|tee|dd|chmod|chown)\b[^|;]*\s\/(?:etc|usr|bin|sbin|boot|System|Library)\b/i,
  },
]

/**
 * Scan a command string for dangerous shapes. Returns one finding per
 * matched rule (deduped by pattern). Empty ⇒ safe to auto-run.
 */
export function checkCommandDanger(command: string): DangerFinding[] {
  if (!command || !command.trim()) return []
  const findings: DangerFinding[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    if (rule.test.test(command) && !seen.has(rule.pattern)) {
      seen.add(rule.pattern)
      findings.push({ pattern: rule.pattern, reason: rule.reason })
    }
  }
  return findings
}

/** Convenience: just the reason strings, for event/record payloads. */
export function dangerReasons(command: string): string[] {
  return checkCommandDanger(command).map((f) => f.reason)
}
