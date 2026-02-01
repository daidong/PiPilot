import { create } from 'zustand'

export interface Notification {
  id: string
  type: 'info' | 'alert' | 'reminder'
  title: string
  body: string
  scheduledTaskId?: string
  createdAt: string
  readAt?: string
}

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  loading: boolean
  load: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  setNotifications: (notifications: Notification[]) => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  loading: false,

  load: async () => {
    set({ loading: true })
    try {
      const api = (window as any).api
      const [notifications, unreadCount] = await Promise.all([
        api.listNotifications(),
        api.getUnreadCount()
      ])
      set({ notifications, unreadCount, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  markRead: async (id: string) => {
    const api = (window as any).api
    await api.markNotificationRead(id)
    const notifications = get().notifications.map(n =>
      n.id === id ? { ...n, readAt: n.readAt || new Date().toISOString() } : n
    )
    set({
      notifications,
      unreadCount: notifications.filter(n => !n.readAt).length
    })
  },

  markAllRead: async () => {
    const api = (window as any).api
    await api.markAllNotificationsRead()
    const now = new Date().toISOString()
    set({
      notifications: get().notifications.map(n => ({ ...n, readAt: n.readAt || now })),
      unreadCount: 0
    })
  },

  setNotifications: (notifications: Notification[]) => {
    set({
      notifications,
      unreadCount: notifications.filter(n => !n.readAt).length
    })
  }
}))
