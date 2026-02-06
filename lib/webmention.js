import * as cheerio from "cheerio";

/**
 * Extract external links from HTML content
 * @param {string} html - HTML content
 * @param {string} siteUrl - Site URL to filter out internal links
 * @returns {string[]} Array of external URLs
 */
export function extractLinks(html, siteUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  const siteHost = new URL(siteUrl).hostname;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    try {
      const url = new URL(href, siteUrl);

      // Only include http/https links
      if (!url.protocol.startsWith("http")) return;

      // Exclude internal links
      if (url.hostname === siteHost) return;

      // Exclude common non-content URLs
      if (url.hostname.includes("twitter.com") && url.pathname.includes("/intent/")) return;
      if (url.hostname.includes("facebook.com") && url.pathname.includes("/sharer")) return;

      links.add(url.href);
    } catch {
      // Invalid URL, skip
    }
  });

  return [...links];
}

/**
 * Discover webmention endpoint for a target URL
 * @param {string} targetUrl - URL to check for webmention endpoint
 * @param {object} options - Options (timeout, userAgent)
 * @returns {Promise<{url: string, type: string}|null>} Endpoint info or null
 */
export async function discoverEndpoint(targetUrl, options = {}) {
  const { timeout = 10000, userAgent = "Indiekit Webmention Sender" } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html, application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    // Check Link header first
    const linkHeader = response.headers.get("link");
    if (linkHeader) {
      const endpoint = parseLinkHeader(linkHeader, response.url);
      if (endpoint) return endpoint;
    }

    // Check for X-Pingback header (fallback)
    const pingbackHeader = response.headers.get("x-pingback");
    if (pingbackHeader) {
      return { url: pingbackHeader, type: "pingback" };
    }

    // Only parse HTML content
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null;
    }

    // Parse HTML for endpoint
    const html = await response.text();
    return findEndpointInHtml(html, response.url);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      console.log(`[webmention] Timeout discovering endpoint for ${targetUrl}`);
    }
    return null;
  }
}

/**
 * Parse Link header for webmention endpoint
 * @param {string} header - Link header value
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {{url: string, type: string}|null}
 */
function parseLinkHeader(header, baseUrl) {
  // Parse Link header format: <url>; rel="webmention"
  const links = header.split(",").map((link) => link.trim());

  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel=["']?([^"'\s]+)["']?/i);
    if (match) {
      const [, url, rel] = match;
      const rels = rel.split(/\s+/);

      if (rels.includes("webmention") || rels.includes("http://webmention.org/")) {
        return {
          url: new URL(url, baseUrl).href,
          type: "webmention",
        };
      }
    }
  }

  return null;
}

/**
 * Find webmention endpoint in HTML
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {{url: string, type: string}|null}
 */
function findEndpointInHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  // Look for link and a elements with rel="webmention"
  const elements = $('link[rel~="webmention"], a[rel~="webmention"]');

  for (const el of elements) {
    const href = $(el).attr("href");
    if (href !== undefined) {
      try {
        return {
          url: new URL(href, baseUrl).href,
          type: "webmention",
        };
      } catch {
        // Invalid URL
      }
    }
  }

  // Fallback: look for pingback
  const pingback = $('link[rel~="pingback"]').attr("href");
  if (pingback) {
    try {
      return {
        url: new URL(pingback, baseUrl).href,
        type: "pingback",
      };
    } catch {
      // Invalid URL
    }
  }

  return null;
}

/**
 * Send a webmention
 * @param {string} source - Source URL (your post)
 * @param {string} target - Target URL (the page you're mentioning)
 * @param {string} endpoint - Webmention endpoint URL
 * @param {object} options - Options (userAgent)
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
export async function sendWebmention(source, target, endpoint, options = {}) {
  const { userAgent = "Indiekit Webmention Sender" } = options;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
      },
      body: `source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
    });

    const status = response.status;

    if (status >= 200 && status < 300) {
      return { success: true, status };
    }

    // Some endpoints return 202 Accepted
    if (status === 202) {
      return { success: true, status };
    }

    const error = await response.text().catch(() => "Unknown error");
    return { success: false, status, error };
  } catch (error) {
    return { success: false, status: 0, error: error.message };
  }
}

/**
 * Send a pingback (legacy fallback)
 * @param {string} source - Source URL
 * @param {string} target - Target URL
 * @param {string} endpoint - Pingback endpoint URL
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
export async function sendPingback(source, target, endpoint) {
  // XML-RPC pingback request
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<methodCall>
  <methodName>pingback.ping</methodName>
  <params>
    <param><value><string>${escapeXml(source)}</string></value></param>
    <param><value><string>${escapeXml(target)}</string></value></param>
  </params>
</methodCall>`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
      },
      body: xmlBody,
    });

    if (response.ok) {
      return { success: true, status: response.status };
    }

    return { success: false, status: response.status, error: await response.text() };
  } catch (error) {
    return { success: false, status: 0, error: error.message };
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Process a post and send webmentions to all external links
 * @param {string} postUrl - URL of the post
 * @param {string} postContent - HTML content of the post
 * @param {string} siteUrl - Site base URL
 * @param {object} options - Options
 * @returns {Promise<{sent: object[], failed: object[], skipped: object[]}>}
 */
export async function processPost(postUrl, postContent, siteUrl, options = {}) {
  const results = {
    sent: [],
    failed: [],
    skipped: [],
  };

  // Extract external links from post content
  const links = extractLinks(postContent, siteUrl);

  if (links.length === 0) {
    return results;
  }

  console.log(`[webmention] Found ${links.length} external links in ${postUrl}`);

  // Process each link
  for (const target of links) {
    try {
      // Discover endpoint
      const endpoint = await discoverEndpoint(target, options);

      if (!endpoint) {
        results.skipped.push({ target, reason: "No webmention endpoint found" });
        continue;
      }

      console.log(`[webmention] Sending to ${target} via ${endpoint.url} (${endpoint.type})`);

      // Send webmention or pingback
      let result;
      if (endpoint.type === "webmention") {
        result = await sendWebmention(postUrl, target, endpoint.url, options);
      } else if (endpoint.type === "pingback") {
        result = await sendPingback(postUrl, target, endpoint.url);
      }

      if (result.success) {
        results.sent.push({ target, endpoint: endpoint.url, type: endpoint.type, status: result.status });
      } else {
        results.failed.push({ target, endpoint: endpoint.url, type: endpoint.type, error: result.error });
      }
    } catch (error) {
      results.failed.push({ target, error: error.message });
    }
  }

  return results;
}
