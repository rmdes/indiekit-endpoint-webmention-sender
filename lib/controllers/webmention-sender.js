import jwt from "jsonwebtoken";
import { processPost } from "../webmention.js";

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
          timestamp: new Date().toISOString(),
        },
      },
    }
  );
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
      let results = [];

      if (postsCollection) {
        [pending, sent, results] = await Promise.all([
          postsCollection.countDocuments({
            "properties.post-status": { $ne: "draft" },
            "properties.webmention-sent": { $ne: true },
          }),
          postsCollection.countDocuments({
            "properties.webmention-sent": true,
          }),
          getRecentResults(postsCollection, 10),
        ]);
      }

      response.render("webmention-sender", {
        title: response.locals.__("webmention-sender.title"),
        pending,
        sent,
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

      const [pending, sent] = await Promise.all([
        postsCollection.countDocuments({
          "properties.post-status": { $ne: "draft" },
          "properties.webmention-sent": { $ne: true },
        }),
        postsCollection.countDocuments({
          "properties.webmention-sent": true,
        }),
      ]);

      response.json({
        status: "ok",
        pending,
        sent,
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
        const postContent = post.properties.content?.html || post.properties.content?.value || "";

        console.log(`[webmention] Processing ${postUrl}`);

        // If no content, try fetching the published page
        let contentToProcess = postContent;
        if (!contentToProcess) {
          try {
            const pageResponse = await fetch(postUrl);
            if (pageResponse.ok) {
              contentToProcess = await pageResponse.text();
            }
          } catch (error) {
            console.log(`[webmention] Could not fetch ${postUrl}: ${error.message}`);
          }
        }

        if (!contentToProcess) {
          console.log(`[webmention] No content to process for ${postUrl}`);
          await markWebmentionsSent(postsCollection, postUrl, { sent: [], failed: [], skipped: [] });
          continue;
        }

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

      // Summary
      const totalSent = allResults.reduce((sum, r) => sum + r.sent.length, 0);
      const totalFailed = allResults.reduce((sum, r) => sum + r.failed.length, 0);
      const totalSkipped = allResults.reduce((sum, r) => sum + r.skipped.length, 0);

      return response.json({
        success: "OK",
        success_description: `Processed ${posts.length} posts: ${totalSent} sent, ${totalFailed} failed, ${totalSkipped} skipped`,
        results: allResults,
      });
    } catch (error) {
      console.error("[webmention] Error:", error);
      next(error);
    }
  },
};
