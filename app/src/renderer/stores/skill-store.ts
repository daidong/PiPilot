import { create } from 'zustand'

export interface SkillManifest {
  name: string
  description: string
  category: string
  depends: string[]
  tags: string[]
  source: 'builtin' | 'user' | 'workspace'
  enabled: boolean
  enabledReason: 'direct' | 'dependency' | null
  dependencyOf: string[]
}

interface SkillState {
  skills: SkillManifest[]
  loading: boolean
  refreshSkills: () => Promise<void>
  toggleSkill: (name: string) => Promise<void>
  uploadSkill: (file: File) => Promise<{ success: boolean; skillName?: string; error?: string }>
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loading: false,

  refreshSkills: async () => {
    const api = (window as any).api
    set({ loading: true })
    try {
      const skills = await api.listSkills()
      set({ skills: skills || [] })
    } finally {
      set({ loading: false })
    }
  },

  toggleSkill: async (name: string) => {
    const api = (window as any).api
    const { skills, refreshSkills } = get()
    const skill = skills.find((s) => s.name === name)
    if (!skill) return

    // Don't allow toggling dependency-locked skills
    if (skill.enabledReason === 'dependency') return

    // Compute new direct selection list (only 'direct' enabled skills)
    const currentDirect = skills
      .filter((s) => s.enabled && s.enabledReason === 'direct')
      .map((s) => s.name)

    const newDirect = skill.enabled
      ? currentDirect.filter((n) => n !== name)
      : [...currentDirect, name]

    await api.setEnabledSkills(newDirect)
    // Refresh from server to get resolved dependencies
    await refreshSkills()
  },

  uploadSkill: async (file: File) => {
    const api = (window as any).api
    const arrayBuffer = await file.arrayBuffer()
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    )
    const result = await api.uploadSkill(file.name, base64)
    if (result.success) {
      await get().refreshSkills()
    }
    return result
  }
}))
