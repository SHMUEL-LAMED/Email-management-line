// נקודת הכניסה שעולה ל-Cloudflare: כל הקו (worker.js) כמו שהוא, ובנוסף ה-API של אתר הצאט (chatsite.js)
import worker from "./worker.js";
import { chatSiteApi } from "./chatsite.js";
export * from "./worker.js";

export default {
  ...worker,
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/chatsite/")) return chatSiteApi(req, env, url);
    return worker.fetch(req, env, ctx);
  },
};
