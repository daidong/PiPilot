export type Theme = 'light' | 'dark'
export type ReasoningEffort = 'high' | 'medium' | 'low' | 'max'

export type ModelId = string

export interface ModelOption {
  id: ModelId
  label: string
  provider: string
}

export interface WorkingFile {
  path: string
  name: string
  accessedAt: number
}

export interface SlashCommand {
  name: string
  description: string
  args?: string
}
