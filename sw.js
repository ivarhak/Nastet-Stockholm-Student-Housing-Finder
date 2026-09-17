// Nästet's service worker exists for exactly one reason: showing a notification.
//
// `new Notification()` throws on essentially every mobile browser — Chrome on
// Android answers "Illegal constructor. Use ServiceWorkerRegistration
// .showNotification() instead" — because the constructor assumes the page will
// outlive the notification, which is not how phones work. iOS goes further and
// exposes no Notification API at all to a page in a Safari tab; it appears only
// once the site has been added to the Home Screen as a web app, which is also
// what the manifest beside this file is for.
//
// There is deliberately NO fetch handler here. A service worker that intercepts
// requests can serve a cached copy of the page or, far worse, of
// listings-<city>.json — and a housing dashboard quietly showing yesterday's
// vacancies is a bug that costs someone a flat. Without a fetch listener this
// worker cannot affect a single request: every load goes to the network exactly
// as it did before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Bring the reader back to the tab they already have open rather than opening a
// second one — the watch depends on a running page, so there usually is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
