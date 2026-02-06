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
 * @param {string} token - Bearer token
 * @param {object} application - Indiekit application config
 * @returns {Promise<boolean>}
 */
async function verifyToken(token, application) {
  if (!token) return false;

  try {
    // Use Indiekit's token verification
    const response = await fetch(application.tokenEndpoint, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `token=${encodeURIComponent(token)}`,
    });

    if (!response.ok) return false;

    const data = await response.json();
    // Require update scope (same as syndication)
    return data.active && data.scope?.includes("update");
  } catch {
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

export const webmentionSenderController = {
  /**
   * GET - Show status/info page
   */
  get(options) {
    return async (request, response) => {
      const { application } = request.app.locals;
      const postsCollection = application?.collections?.get("posts");

      let pendingCount = 0;
      let sentCount = 0;

      if (postsCollection) {
        pendingCount = await postsCollection.countDocuments({
          "properties.post-status": { $ne: "draft" },
          "properties.webmention-sent": { $ne: true },
        });

        sentCount = await postsCollection.countDocuments({
          "properties.webmention-sent": true,
        });
      }

      // Return JSON for API calls, HTML for browser
      if (request.accepts("html")) {
        response.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Webmention Sender</title>
            <style>
              body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
              .stat { display: inline-block; padding: 1rem; margin: 0.5rem; background: #f0f0f0; border-radius: 8px; }
              .stat-value { font-size: 2rem; font-weight: bold; }
              .stat-label { color: #666; }
            </style>
          </head>
          <body>
            <h1>Webmention Sender</h1>
            <div>
              <div class="stat">
                <div class="stat-value">${pendingCount}</div>
                <div class="stat-label">Pending</div>
              </div>
              <div class="stat">
                <div class="stat-value">${sentCount}</div>
                <div class="stat-label">Sent</div>
              </div>
            </div>
            <p>POST to this endpoint with a valid token to process pending webmentions.</p>
            <p>Optional: <code>?source_url=...</code> to process a specific post.</p>
          </body>
          </html>
        `);
      } else {
        response.json({
          pending: pendingCount,
          sent: sentCount,
        });
      }
    };
  },

  /**
   * POST - Process and send webmentions
   */
  post(options) {
    return async (request, response, next) => {
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
        const isValid = await verifyToken(token, application);

        if (!isValid) {
          return response.status(401).json({
            error: "unauthorized",
            error_description: "Invalid or missing token",
          });
        }

        // Get source URL if provided
        const sourceUrl = request.query.source_url || request.body?.source_url;

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
          const results = await processPost(postUrl, contentToProcess, siteUrl, options);

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
    };
  },
};
