export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationPreference = { type: string; label: string; inApp: boolean; email: boolean };

export const notificationsKey = ["notifications"] as const;
