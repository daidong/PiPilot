import React from 'react'

export interface SegmentOption<T extends string = string> {
  label: string
  value: T
  desc?: string
}

interface Props<T extends string = string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string = string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="flex rounded-lg border t-border overflow-hidden">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors
              ${active
                ? 't-text-accent bg-[var(--color-accent)]/10'
                : 't-text-secondary hover:t-text hover:t-bg-hover'
              }
            `}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
