import React from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { useNotificationStore, type Notification } from '../../stores/notification-store'

export function NotificationPanel() {
  const notifications = useNotificationStore((s) => s.notifications)
  const unreadCount = useNotificationStore((s) => s.unreadCount)
  const load = useNotificationStore((s) => s.load)
  const markRead = useNotificationStore((s) => s.markRead)
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const setNotifications = useNotificationStore((s) => s.setNotifications)

  React.useEffect(() => {
    load()
    const api = (window as any).api
    const unsub = api.onNotification?.((list: Notification[]) => {
      setNotifications(list)
    })
    return () => unsub?.()
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider flex items-center gap-1.5">
          <Bell size={12} />
          Notifications
          {unreadCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-blue-500 text-white font-medium">
              {unreadCount}
            </span>
          )}
        </h3>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="text-[10px] t-text-muted hover:t-text flex items-center gap-0.5 transition-colors"
            title="Mark all read"
          >
            <CheckCheck size={10} />
            Read all
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="text-xs t-text-muted">No notifications</p>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {notifications.slice(0, 20).map((n) => (
            <NotificationRow key={n.id} notification={n} onRead={markRead} />
          ))}
        </div>
      )}
    </div>
  )
}

function NotificationRow({ notification, onRead }: { notification: Notification; onRead: (id: string) => void }) {
  const isUnread = !notification.readAt
  const time = new Date(notification.createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <button
      onClick={() => isUnread && onRead(notification.id)}
      className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${
        isUnread ? 't-bg-hover' : 'opacity-60'
      }`}
    >
      <div className="flex items-start gap-1.5">
        {isUnread && (
          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs t-text truncate font-medium">{notification.title}</p>
          <p className="text-[10px] t-text-secondary line-clamp-2 mt-0.5">{notification.body}</p>
          <p className="text-[10px] t-text-muted mt-0.5">{time}</p>
        </div>
      </div>
    </button>
  )
}
