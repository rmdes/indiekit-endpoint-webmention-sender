import jwt from "jsonwebtoken";
import { processPost } from "../webmention.js";

/**
 * How many cycles to keep retrying a post whose page cannot be fetched before
 * giving up on it. A post published mid-rebuild is briefly unreachable, so this
 * needs to span a few cycles; a post whose page never appears must eventually
 * be dropped, or it occupies a slot in every batch indefinitely.
 */
const MAX_UNREACHABLE_ATTEMPTS = 5;

/**
 * Find the bearer token from request
 * @param {object} request - Express request
 * @returns {string|undefined}
 */
function findBearerToken(request) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return request.query.token || request.body?.token;
}

/**
 * Verify the token has required scope
 * Uses direct JWT verification with the app secret (for tokens created by start.sh polling)
 * @param {string} token - Bearer token (JWT)
 * @param {object} application - Indiekit application config
 * @returns {boolean}
 */
function verifyToken(token, application) {
  if (!token) return false;

  try {
    // Get the secret from environment (same one used to sign the token in start.sh)
    const secret = process.env.SECRET;
    if (!secret) {
      console.error("[webmention] No SECRET environment variable found");
      return false;
    }

    // Verify the JWT
    const decoded = jwt.verify(token, secret);

    // Check for update scope
    if (!decoded.scope?.includes("update")) {
      console.error("[webmention] Token missing update scope");
      return false;
    }

    return true;
  } catch (error) {
    console.error("[webmention] Token verification failed:", error.message);
    return false;
  }
}

/**
 * Get posts that need webmentions sent
 * @param {object} postsCollection - MongoDB posts collection
 * @param {string} sourceUrl - Optional specific URL to process
 * @returns {Promise<object[]>}
 */
async function getPostsNeedingWebmentions(postsCollection, sourceUrl = null) {
  const query = {
    // Only published posts
    "properties.post-status": { $ne: "draft" },
    // Not already processed
    "properties.webmention-sent": { $ne: true },
    // Not abandoned after repeatedly failing to fetch the post. Without this,
    // posts whose pages no longer exist keep filling the batch on every cycle
    // and eventually starve newer posts entirely.
    "properties.webmention-unreachable": { $exists: false },
  };

  // If specific URL requested, add to query
  if (sourceUrl) {
    query["properties.url"] = sourceUrl;
  }

  // Find posts, sorted by published date (oldest first)
  const posts = await postsCollection
    .find(query)
    .sort({ "properties.published": 1 })
    .limit(10) // Process max 10 at a time
    .toArray();

  return posts;
}

/**
 * Mark a post as having webmentions sent
 * @param {object} postsCollection - MongoDB posts collection
 * @param {string} postUrl - URL of the post
 * @param {object} results - Webmention results
 */
async function markWebmentionsSent(postsCollection, postUrl, results) {
  await postsCollection.updateOne(
    { "properties.url": postUrl },
    {
      $set: {
        "properties.webmention-sent": true,
        "properties.webmention-results": {
          sent: results.sent.length,
          failed: results.failed.length,
          skipped: results.skipped.length,
          details: {
            sent: results.sent,
            failed: results.failed,
            skipped: results.skipped,
          },
          timestamp: new Date().toISOString(),
        },
      },
    }
  );
}

/**
 * Record that a post’s page could not be fetched
 *
 * Counts the attempt, and once the limit is reached marks the post unreachable
 * so it stops being returned by getPostsNeedingWebmentions.
 * @param {object} postsCollection - MongoDB posts collection
 * @param {string} postUrl - URL of the post
 * @param {number} attempts - Number of attempts made so far, including this one
 * @param {boolean} abandoned - Whether the attempt limit has been reached
 */
async function recordUnreachable(postsCollection, postUrl, attempts, abandoned) {
  const set = { "properties.webmention-attempts": attempts };

  if (abandoned) {
    set["properties.webmention-unreachable"] = {
      attempts,
      reason: "Post URL could not be fetched",
      timestamp: new Date().toISOString(),
    };
  }

  await postsCollection.updateOne({ "properties.url": postUrl }, { $set: set });
}

/**
 * Get recent webmention results for display
 * @param {object} postsCollection - MongoDB posts collection
 * @param {number} limit - Max results to return
 * @returns {Promise<object[]>}
 */
async function getRecentResults(postsCollection, limit = 10) {
  const posts = await postsCollection
    .find({
      "properties.webmention-sent": true,
      "properties.webmention-results": { $exists: true },
    })
    .sort({ "properties.webmention-results.timestamp": -1 })
    .limit(limit)
    .toArray();

  return posts.map((post) => ({
    url: post.properties.url,
    sent: post.properties["webmention-results"]?.sent || 0,
    failed: post.properties["webmention-results"]?.failed || 0,
    skipped: post.properties["webmention-results"]?.skipped || 0,
    details: post.properties["webmention-results"]?.details || null,
    timestamp: post.properties["webmention-results"]?.timestamp,
  }));
}

export const webmentionSenderController = {
  /**
   * GET / - Dashboard view (protected)
   */
  async get(request, response, next) {
    try {
      const { application } = request.app.locals;
      const postsCollection = application?.collections?.get("posts");

      let pending = 0;
      let sent = 0;
      let unreachable = 0;
      let results = [];

      if (postsCollection) {
        [pending, sent, unreachable, results] = await Promise.all([
          postsCollection.countDocuments({
            "properties.post-status": { $ne: "draft" },
            "properties.webmention-sent": { $ne: true },
            // Abandoned posts are no longer pending — counting them here is
            // what makes a stuck backlog look like ordinary queue depth
            "properties.webmention-unreachable": { $exists: false },
          }),
          postsCollection.countDocuments({
            "properties.webmention-sent": true,
          }),
          postsCollection.countDocuments({
            "properties.webmention-unreachable": { $exists: true },
          }),
          getRecentResults(postsCollection, 10),
        ]);
      }

      response.render("webmention-sender", {
        title: response.locals.__("webmention-sender.title"),
        pending,
        sent,
        unreachable,
        results,
      });
    } catch (error) {
      console.error("[webmention] Dashboard error:", error);
      next(error);
    }
  },

  /**
   * GET /api/status - JSON status (public)
   */
  async status(request, response) {
    try {
      const { application } = request.app.locals;
      const postsCollection = application?.collections?.get("posts");

      if (!postsCollection) {
        return response.json({
          status: "unavailable",
          message: "Database not connected",
        });
      }

      const [pending, sent, unreachable] = await Promise.all([
        postsCollection.countDocuments({
          "properties.post-status": { $ne: "draft" },
          "properties.webmention-sent": { $ne: true },
          "properties.webmention-unreachable": { $exists: false },
        }),
        postsCollection.countDocuments({
          "properties.webmention-sent": true,
        }),
        postsCollection.countDocuments({
          "properties.webmention-unreachable": { $exists: true },
        }),
      ]);

      response.json({
        status: "ok",
        pending,
        sent,
        unreachable,
      });
    } catch (error) {
      response.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  },

  /**
   * POST / - Process and send webmentions (public, requires token)
   */
  async post(request, response, next) {
    try {
      const { application, publication } = request.app.locals;
      const postsCollection = application?.collections?.get("posts");

      if (!postsCollection) {
        return response.status(501).json({
          error: "not_implemented",
          error_description: "Database not configured",
        });
      }

      // Verify token
      const token = findBearerToken(request);
      const isValid = verifyToken(token, application);

      if (!isValid) {
        return response.status(401).json({
          error: "unauthorized",
          error_description: "Invalid or missing token",
        });
      }

      // Get source URL if provided
      const sourceUrl = request.query.source_url || request.body?.source_url;

      // Get webmention sender config
      const webmentionConfig = application.webmentionSenderConfig || {};

      // Get posts needing webmentions
      const posts = await getPostsNeedingWebmentions(postsCollection, sourceUrl);

      if (posts.length === 0) {
        return response.json({
          success: "OK",
          success_description: sourceUrl
            ? `No pending webmentions for ${sourceUrl}`
            : "No posts pending webmentions",
        });
      }

      const siteUrl = publication.me || application.url;
      const allResults = [];

      // Process each post
      for (const post of posts) {
        const postUrl = post.properties.url;

        console.log(`[webmention] Processing ${postUrl}`);

        // Verify the post URL is actually live before sending webmentions.
        // The post may not be built yet (Eleventy rebuild in progress), and
        // webmention targets verify the source URL — a 404 means rejection.
        let pageHtml;
        try {
          const pageResponse = await fetch(postUrl);
          if (pageResponse.ok) {
            pageHtml = await pageResponse.text();
          }
        } catch (error) {
          console.log(`[webmention] Could not fetch ${postUrl}: ${error.message}`);
        }

        if (!pageHtml) {
          // Not an error — the post may simply not be built yet. Count the
          // attempt so a page that never appears is eventually abandoned, and
          // record it in the results so the summary reflects what happened.
          const attempts = (post.properties["webmention-attempts"] || 0) + 1;
          const abandoned = attempts >= MAX_UNREACHABLE_ATTEMPTS;

          await recordUnreachable(postsCollection, postUrl, attempts, abandoned);

          allResults.push({
            url: postUrl,
            unreachable: true,
            attempts,
            abandoned,
            sent: [],
            failed: [],
            skipped: [],
          });

          console.log(
            abandoned
              ? `[webmention] Giving up on ${postUrl} — not reachable after ${attempts} attempts`
              : `[webmention] Skipping ${postUrl} — page not live yet (attempt ${attempts}), will retry next cycle`
          );
          continue;
        }

        // Extract from the rendered page, not the stored content. extractLinks
        // scopes to .h-entry rather than .e-content precisely so microformat
        // property links - u-in-reply-to, u-like-of, u-repost-of, u-bookmark-of -
        // are included, and those are rendered outside the stored content. A
        // reply processed from stored content alone therefore yields no targets,
        // gets marked webmention-sent with nothing sent, and is never retried.
        // pageHtml is guaranteed non-empty here; the unreachable branch above
        // continues when the fetch failed.
        const storedContent =
          post.properties.content?.html || post.properties.content?.value || "";
        const contentToProcess = pageHtml || storedContent;

        // Process the post
        const results = await processPost(postUrl, contentToProcess, siteUrl, webmentionConfig);

        // Mark as processed
        await markWebmentionsSent(postsCollection, postUrl, results);

        allResults.push({
          url: postUrl,
          ...results,
        });

        console.log(`[webmention] ${postUrl}: sent=${results.sent.length}, failed=${results.failed.length}, skipped=${results.skipped.length}`);
      }

      // Summary. Counts of webmention targets (sent/failed/skipped) are
      // separate from counts of posts (unreachable/abandoned) — conflating the
      // two is what previously reported "0 sent, 0 failed, 0 skipped" for a
      // batch in which every post had been dropped before it was processed.
      const totalSent = allResults.reduce((sum, r) => sum + r.sent.length, 0);
      const totalFailed = allResults.reduce((sum, r) => sum + r.failed.length, 0);
      const totalSkipped = allResults.reduce((sum, r) => sum + r.skipped.length, 0);
      const unreachable = allResults.filter((r) => r.unreachable).length;
      const abandoned = allResults.filter((r) => r.abandoned).length;

      const description =
        `Processed ${posts.length} post(s): ${totalSent} sent, ` +
        `${totalFailed} failed, ${totalSkipped} target(s) skipped` +
        (unreachable > 0 ? `, ${unreachable} post(s) not reachable` : "") +
        (abandoned > 0 ? ` (${abandoned} abandoned)` : "");

      return response.json({
        success: "OK",
        success_description: description,
        results: allResults,
      });
    } catch (error) {
      console.error("[webmention] Error:", error);
      next(error);
    }
  },
};
