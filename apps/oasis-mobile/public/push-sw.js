/* Push handlers, loaded into the generated service worker (vite.config.ts: workbox.importScripts). */
/* global self, clients */

/** The notification for a push payload; exported on self for tests. */
function notificationFor(data) {
  if (!data || data.type !== 'mission_run') {
    return { title: 'New update', options: { body: '', tag: 'update', data: { url: '/' } } };
  }
  const title = data.goal || 'Mission';
  const fallback = data.ok ? 'Mission run finished' : 'Mission run failed';
  const body = data.summary ? (data.ok ? data.summary : 'Failed: ' + data.summary) : fallback;
  return {
    title,
    options: {
      body,
      tag: 'mission-' + (data.mission_id || 'run'),
      renotify: true,
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      data: { url: '/', mission_id: data.mission_id || null, session_id: data.session_id || null },
    },
  };
}
self.__notificationFor = notificationFor;

self.addEventListener('push', (event) => {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch (e) { data = null; }
  const { title, options } = notificationFor(data);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if ('focus' in client) return client.focus();
    }
    return clients.openWindow(url);
  })());
});
