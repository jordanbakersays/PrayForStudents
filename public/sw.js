self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = null;
    if (event.data) {
      // Normal pushes carry a JSON payload
      try { data = event.data.json(); } catch (_e) { data = null; }
    } else {
      // Empty push = birthday alert. Ask the server what to say for this device.
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const res = await fetch("/api/birthday-alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "message", endpoint: sub.endpoint }),
          });
          if (res.ok) {
            const msg = await res.json();
            if (msg && msg.title) data = { title: msg.title, body: msg.body, tag: "birthday-alert" };
          }
        }
      } catch (_e) {}
    }
    data = data || {};
    await self.registration.showNotification(data.title || "Calvary Students", {
      body: data.body || "Time to pray for your students 🙏",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || "prayer-reminder",
      renotify: true,
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
