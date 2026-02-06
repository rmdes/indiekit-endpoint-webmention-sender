import express from "express";
import { webmentionSenderController } from "./lib/controllers/webmention-sender.js";

const defaults = {
  mountPath: "/webmention-sender",
  // How long to wait for endpoint discovery (ms)
  timeout: 10000,
  // User agent for requests
  userAgent: "Indiekit Webmention Sender (https://getindiekit.com)",
};

const router = express.Router();

export default class WebmentionSenderEndpoint {
  name = "Webmention sender endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "webmention-sender.title",
    };
  }

  get routesPublic() {
    router.post(
      "/",
      webmentionSenderController.post(this.options)
    );

    router.get(
      "/",
      webmentionSenderController.get(this.options)
    );

    return router;
  }

  init(Indiekit) {
    Indiekit.addEndpoint(this);

    // Register path for other plugins to find
    Indiekit.config.application._webmentionSenderPath = this.options.mountPath;
  }
}
