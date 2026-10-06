// Tiny scheduler: twice a day (covers daylight saving), tell the site to check whether any
// birthday alerts are due. All the real logic lives in functions/api/birthday-alerts.js.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const res = await fetch(`${env.SITE_URL}/api/birthday-alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": env.CRON_SECRET },
        body: JSON.stringify({ action: "run" }),
      });
      console.log("birthday run:", res.status, await res.text());
    })());
  },
};
