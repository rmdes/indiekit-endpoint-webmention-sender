import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { webmentionSenderController } from "./lib/controllers/webmention-sender.js";

// Module-level routers (matching Indiekit's endpoint pattern)
const protectedRouter = express.Router();
const publicRouter = express.Router();

const defaults = {
  mountPath: "/webmention-sender",
  // How long to wait for endpoint discovery (ms)
  timeout: 10000,
  // User agent for requests
  userAgent: "Indiekit Webmention Sender (https://getindiekit.com)",
};

export default class WebmentionSenderEndpoint {
  name = "Webmention sender endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get localesDirectory() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "webmention-sender.title",
      requiresDatabase: true,
    };
  }

  /**
   * Protected routes (require authentication)
   * Dashboard page in Indiekit admin UI
   */
  get routes() {
    protectedRouter.get("/", webmentionSenderController.get);
    return protectedRouter;
  }

  /**
   * Public routes (no authentication for GET, token auth for POST)
   * API endpoints for background polling
   */
  get routesPublic() {
    // JSON API for status
    publicRouter.get("/api/status", webmentionSenderController.status);

    // POST endpoint for sending webmentions (requires token auth)
    publicRouter.post("/", webmentionSenderController.post);

    return publicRouter;
  }

  init(Indiekit) {
    Indiekit.addEndpoint(this);

    // Store config in application for controller access
    Indiekit.config.application.webmentionSenderConfig = this.options;
    Indiekit.config.application._webmentionSenderPath = this.options.mountPath;
  }
}
