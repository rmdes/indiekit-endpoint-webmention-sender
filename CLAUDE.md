# CLAUDE.md - indiekit-endpoint-webmention-sender

This file provides guidance to AI agents working with this Indiekit plugin.

## Package Overview

`@rmdes/indiekit-endpoint-webmention-sender` is a webmention sender plugin for Indiekit. It automatically discovers and sends webmentions to external URLs linked in published posts. The plugin extracts links from post content, discovers webmention endpoints (via HTTP headers or HTML), sends webmention notifications, and tracks which posts have been processed to prevent duplicate sends.

**npm Package:** `@rmdes/indiekit-endpoint-webmention-sender`
**Version:** 1.0.4
**Type:** ESM module (`"type": "module"`)
**Mount Path:** `/webmention-sender` (default, configurable)

## Architecture

### Data Flow

```
Published Post (MongoDB posts collection)
    → Controller checks properties.webmention-sent flag
    → Extract external links from content (Cheerio)
    → For each link:
        → Discover webmention endpoint (HTTP headers or HTML)
        → Send webmention POST request (source=post, target=link)
        → Track result (sent/failed/skipped)
    → Mark post as processed (properties.webmention-sent = true)
    → Store results in properties.webmention-results
```

### Key Components

**Entry Point:** `index.js` - Plugin class, route registration, initialization

**Controllers:**
- `lib/controllers/webmention-sender.js` - Dashboard view, status API, POST handler (sends webmentions)

**Business Logic:**
- `lib/webmention.js` - Core webmention logic:
  - `extractLinks()` - Parse HTML for external links
  - `discoverEndpoint()` - Find webmention endpoint via HTTP or HTML
  - `sendWebmention()` - POST to webmention endpoint
  - `sendPingback()` - Legacy XML-RPC pingback fallback
  - `processPost()` - Orchestrates full workflow for a post

**Views:**
- `views/webmention-sender.njk` - Admin dashboard (pending/sent counts, recent results)

## Routes

### Protected (Require Authentication)

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| GET | `/webmention-sender` | `webmentionSenderController.get` | Admin dashboard - shows pending/sent counts and recent results |

### Public (No Authentication, but POST requires token)

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| GET | `/webmention-sender/api/status` | `webmentionSenderController.status` | JSON status API (pending/sent counts) |
| POST | `/webmention-sender` | `webmentionSenderController.post` | Process posts and send webmentions (requires JWT token with `update` scope) |

## Authentication

The POST endpoint uses **JWT token authentication** (NOT IndieAuth). This is designed for background polling (e.g., cron job in `start.sh`).

### Token Requirements

- Must be a valid JWT signed with `process.env.SECRET`
- Must include `scope: "update"`
- Can be passed via:
  - `Authorization: Bearer <token>` header
  - Query parameter: `?token=<token>`
  - Body parameter: `token=<token>`

### Token Creation Example

```javascript
// In start.sh polling loop
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { me: 'https://example.com', scope: 'update' },
  process.env.SECRET,
  { expiresIn: '5m' }
);
```

### Token Verification

```javascript
// In webmention-sender.js controller
function verifyToken(token, application) {
  const secret = process.env.SECRET;
  const decoded = jwt.verify(token, secret);
  return decoded.scope?.includes("update");
}
```

## MongoDB Schema

The plugin does NOT create its own collections. It modifies the existing `posts` collection.

### Post Document Updates

The plugin adds these properties to post documents:

```javascript
{
  "properties": {
    // ... existing post properties ...

    "webmention-sent": true,  // Boolean flag (indexed for queries)

    "webmention-results": {   // Results from last send
      "sent": 3,              // Count of successful sends
      "failed": 1,            // Count of failed sends
      "skipped": 2,           // Count of skipped (no endpoint found)
      "timestamp": "2025-02-13T10:00:00.000Z"  // ISO string
    }
  }
}
```

### Queries Used

**Find posts needing webmentions:**
```javascript
{
  "properties.post-status": { $ne: "draft" },
  "properties.webmention-sent": { $ne: true }
}
```

**Find posts with webmentions sent:**
```javascript
{
  "properties.webmention-sent": true,
  "properties.webmention-results": { $exists: true }
}
```

## Configuration

```javascript
// indiekit.config.js
export default {
  plugins: [
    "@rmdes/indiekit-endpoint-webmention-sender",
  ],

  "@rmdes/indiekit-endpoint-webmention-sender": {
    mountPath: "/webmention-sender",  // Optional, default "/webmention-sender"
    timeout: 10000,                   // Optional, endpoint discovery timeout (ms), default 10000
    userAgent: "My Site Webmention Sender",  // Optional, User-Agent header
  },
};
```

## API Reference

### GET /webmention-sender/api/status

Public JSON status endpoint.

**Response:**
```json
{
  "status": "ok",
  "pending": 5,
  "sent": 42
}
```

**Error Response:**
```json
{
  "status": "unavailable",
  "message": "Database not connected"
}
```

### POST /webmention-sender

Process posts and send webmentions. Requires JWT token with `update` scope.

**Headers:**
```
Authorization: Bearer <jwt-token>
```

**Query Parameters:**
- `source_url` (optional) - Process only a specific post URL

**Request:**
```bash
curl -X POST "https://example.com/webmention-sender" \
  -H "Authorization: Bearer $TOKEN"
```

**Success Response:**
```json
{
  "success": "OK",
  "success_description": "Processed 2 posts: 5 sent, 1 failed, 3 skipped",
  "results": [
    {
      "url": "https://example.com/posts/hello",
      "sent": [
        {
          "target": "https://other.site/article",
          "endpoint": "https://other.site/webmention",
          "type": "webmention",
          "status": 202
        }
      ],
      "failed": [
        {
          "target": "https://broken.site/",
          "endpoint": "https://broken.site/webmention",
          "type": "webmention",
          "error": "Connection refused"
        }
      ],
      "skipped": [
        {
          "target": "https://no-webmention.site/",
          "reason": "No webmention endpoint found"
        }
      ]
    }
  ]
}
```

**Error Response:**
```json
{
  "error": "unauthorized",
  "error_description": "Invalid or missing token"
}
```

## Webmention Discovery

The plugin follows the [Webmention specification](https://www.w3.org/TR/webmention/) for endpoint discovery:

### Discovery Order

1. **HTTP `Link` header** - Highest priority
   ```
   Link: <https://example.com/webmention>; rel="webmention"
   ```

2. **HTTP `X-Pingback` header** - Fallback for legacy pingback
   ```
   X-Pingback: https://example.com/pingback
   ```

3. **HTML `<link>` or `<a>` tags** - Parsed from response body
   ```html
   <link rel="webmention" href="https://example.com/webmention">
   <a rel="webmention" href="https://example.com/webmention">Webmention</a>
   ```

### Discovery Behavior

- **Timeout:** 10 seconds (configurable via `timeout` option)
- **Redirects:** Follows redirects (uses `redirect: "follow"`)
- **Content-Type filtering:** Only parses HTML (`text/html`, `application/xhtml+xml`)
- **Relative URLs:** Resolves relative endpoints to absolute using base URL

## Link Extraction

Uses Cheerio to parse HTML and extract external links:

```javascript
// From lib/webmention.js
export function extractLinks(html, siteUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  const siteHost = new URL(siteUrl).hostname;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const url = new URL(href, siteUrl);

    // Filter logic:
    // - Only http/https links
    // - Exclude internal links (same hostname)
    // - Exclude social share intents
  });

  return [...links];
}
```

### Link Filtering

**Included:**
- External links (different hostname)
- HTTP/HTTPS protocol only

**Excluded:**
- Internal links (same hostname as `siteUrl`)
- Non-HTTP protocols (mailto:, tel:, javascript:, etc.)
- Social share intents:
  - `twitter.com/.../intent/...`
  - `facebook.com/.../sharer/...`

## Sending Webmentions

### Webmention Format

```http
POST /webmention HTTP/1.1
Host: target-site.com
Content-Type: application/x-www-form-urlencoded
User-Agent: Indiekit Webmention Sender

source=https://your-site.com/post&target=https://target-site.com/article
```

### Success Criteria

- Status code 200-299 (success)
- Status code 202 (accepted, async processing)

### Error Handling

- Network errors → `failed` with error message
- Non-2xx status → `failed` with status code
- Timeout → `failed` with "Timeout" message

### Pingback Fallback

If no webmention endpoint found, but `X-Pingback` header exists:

```xml
POST /pingback HTTP/1.1
Host: target-site.com
Content-Type: application/xml

<?xml version="1.0" encoding="UTF-8"?>
<methodCall>
  <methodName>pingback.ping</methodName>
  <params>
    <param><value><string>https://your-site.com/post</string></value></param>
    <param><value><string>https://target-site.com/article</string></value></param>
  </params>
</methodCall>
```

## Automatic Processing via Polling

For automatic webmention sending, add a polling loop to your deployment script:

### Example: Cloudron `start.sh`

```bash
# Webmention sender - polls every 5 minutes
(
    echo "[webmention] Starting auto-send polling"
    while true; do
        SECRET=$(cat /app/data/config/.secret 2>/dev/null)
        ORIGIN="${CLOUDRON_APP_ORIGIN}"

        if [ -n "$SECRET" ]; then
            TOKEN=$(node -e "
                const jwt = require('jsonwebtoken');
                const token = jwt.sign(
                    { me: '$ORIGIN', scope: 'update' },
                    '$SECRET',
                    { expiresIn: '5m' }
                );
                console.log(token);
            " 2>/dev/null)

            if [ -n "$TOKEN" ]; then
                RESULT=$(curl -s -X POST \"http://localhost:8080/webmention-sender?token=\${TOKEN}\" 2>&1)
                echo "[webmention] $(date '+%Y-%m-%d %H:%M:%S') - $RESULT"
            fi
        fi

        sleep 300  # 5 minutes
    done
) &
```

### Why JWT Instead of IndieAuth?

- **Background execution:** Polling loop runs outside user session
- **No user interaction:** Cannot redirect to IndieAuth flow
- **Server-to-server:** Internal communication, no external auth needed
- **Secret-based:** Uses same secret as Indiekit session management

## Processing Logic

### Full Workflow (from `processPost()`)

```javascript
async function processPost(postUrl, postContent, siteUrl, options) {
  const results = { sent: [], failed: [], skipped: [] };

  // 1. Extract external links from HTML
  const links = extractLinks(postContent, siteUrl);

  // 2. Process each link
  for (const target of links) {
    // 3. Discover webmention endpoint
    const endpoint = await discoverEndpoint(target, options);

    if (!endpoint) {
      results.skipped.push({ target, reason: "No webmention endpoint found" });
      continue;
    }

    // 4. Send webmention or pingback
    let result;
    if (endpoint.type === "webmention") {
      result = await sendWebmention(postUrl, target, endpoint.url, options);
    } else if (endpoint.type === "pingback") {
      result = await sendPingback(postUrl, target, endpoint.url);
    }

    // 5. Track result
    if (result.success) {
      results.sent.push({ target, endpoint: endpoint.url, type: endpoint.type, status: result.status });
    } else {
      results.failed.push({ target, endpoint: endpoint.url, type: endpoint.type, error: result.error });
    }
  }

  return results;
}
```

### Content Fetching

If post has no `properties.content.html` or `properties.content.value`, the controller attempts to fetch the published page:

```javascript
if (!contentToProcess) {
  const pageResponse = await fetch(postUrl);
  if (pageResponse.ok) {
    contentToProcess = await pageResponse.text();
  }
}
```

This allows webmentions to work for posts that store minimal content in MongoDB.

## Inter-Plugin Relationships

### Dependencies
- `cheerio` ^1.0.0 - HTML parsing for link extraction
- `jsonwebtoken` ^9.0.0 - JWT token verification
- `node-fetch` ^3.3.2 - HTTP requests
- `express` ^5.0.0 - Routing

### Works With
- **@indiekit/endpoint-micropub** - Creates posts with `properties.url` and `properties.content`
- **@rmdes/indiekit-endpoint-micropub** - Fork with custom type-based post discovery
- **Any Indiekit publication** - Reads from standard `posts` collection

### Independent From
- **@rmdes/indiekit-endpoint-webmention-io** - Receives incoming webmentions (separate concern)
- **@rmdes/indiekit-endpoint-webmentions-proxy** - Proxies webmention.io API (separate concern)

## Known Gotchas

### 1. No Content in MongoDB

**Symptom:** Posts skip with "No content to process"

**Cause:** Some post types store only metadata in MongoDB, actual content lives in files

**Fix:** Plugin automatically fetches published URL as fallback. Ensure `properties.url` is set correctly.

### 2. Duplicate Sends

**Symptom:** Webmentions sent multiple times for same post

**Cause:** `properties.webmention-sent` flag not set or manual database edits

**Prevention:** Plugin uses MongoDB atomic update (`updateOne`) to mark posts as processed. Do NOT manually clear `webmention-sent` unless you want to re-send.

### 3. Token Expiry

**Symptom:** "Invalid or missing token" error in polling loop

**Cause:** JWT expired (if set to very short expiry)

**Fix:** Use reasonable expiry (5 minutes) and regenerate token on each poll iteration (as shown in example script).

### 4. Timeout During Discovery

**Symptom:** Many links appear in `skipped` results

**Cause:** Target sites slow to respond, discovery times out

**Fix:** Increase `timeout` option (default 10 seconds):
```javascript
"@rmdes/indiekit-endpoint-webmention-sender": {
  timeout: 20000  // 20 seconds
}
```

### 5. Posts Never Marked as Processed

**Symptom:** Same posts processed repeatedly

**Cause:** `markWebmentionsSent()` fails silently (database write error)

**Debug:** Check Indiekit logs for MongoDB errors. Verify `posts` collection is writable.

## Testing Recommendations

### Manual Testing Workflow

1. **Create a test post with external links:**
   ```bash
   curl -X POST https://example.com/micropub \
     -H "Authorization: Bearer $TOKEN" \
     -d "h=entry" \
     -d "content=Check out this great article: https://other-site.com/post"
   ```

2. **Verify post is pending:**
   ```bash
   curl https://example.com/webmention-sender/api/status
   # Should show "pending": 1
   ```

3. **Trigger webmention send:**
   ```bash
   curl -X POST "https://example.com/webmention-sender" \
     -H "Authorization: Bearer $TOKEN"
   ```

4. **Verify post is marked sent:**
   ```bash
   curl https://example.com/webmention-sender/api/status
   # Should show "pending": 0, "sent": 1
   ```

5. **Check results in MongoDB:**
   ```javascript
   db.posts.findOne({ "properties.url": "https://example.com/posts/test" })
   // Verify webmention-sent: true and webmention-results object exists
   ```

### Test Cases

**Link Extraction:**
- Internal links excluded
- Relative URLs resolved
- Social share intents excluded
- Non-HTTP protocols excluded

**Endpoint Discovery:**
- Link header takes priority
- HTML link tag fallback works
- X-Pingback header detected
- Timeout handling

**Sending:**
- 200/202 status treated as success
- 4xx/5xx errors tracked as failed
- Network errors tracked as failed

**Duplicate Prevention:**
- Post marked sent after processing
- Second trigger does not re-send
- Manual update of `webmention-sent: false` causes re-send

### MongoDB Queries for Debugging

```javascript
// Find posts pending webmentions
db.posts.find({
  "properties.post-status": { $ne: "draft" },
  "properties.webmention-sent": { $ne: true }
})

// Find posts with webmentions sent
db.posts.find({
  "properties.webmention-sent": true
})

// View webmention results for a post
db.posts.findOne(
  { "properties.url": "https://example.com/posts/test" },
  { "properties.webmention-results": 1 }
)

// Clear webmention-sent flag (for testing)
db.posts.updateOne(
  { "properties.url": "https://example.com/posts/test" },
  { $unset: { "properties.webmention-sent": "", "properties.webmention-results": "" } }
)
```

## Common Issues

### "Database not configured" error

**Cause:** MongoDB not available at plugin init

**Fix:** Ensure `MONGODB_URL` environment variable is set and connection succeeds

### "Invalid or missing token" error

**Cause:** JWT token missing, expired, or missing `update` scope

**Fix:** Verify token generation includes `scope: "update"` and hasn't expired

### "No content to process" in logs

**Cause:** Post has no `properties.content.html` or `.value` and published URL fetch failed

**Fix:**
- Verify post has content stored in MongoDB
- Verify `properties.url` is correct and accessible
- Check network access from server to published URL

### Webmentions sent but never appear on target site

**Cause:** Not a plugin issue - target site may:
- Not support webmentions (no endpoint, but HTML link found)
- Have moderation queue
- Reject webmentions from unknown sources

**Debug:** Check target site's webmention implementation and logs

## Source of Truth

**Edit here:** `/home/rick/code/indiekit-dev/indiekit-endpoint-webmention-sender/`

**Do NOT edit:**
- `indiekit-cloudron/node_modules/@rmdes/indiekit-endpoint-webmention-sender/` - Installed copy (read-only)

## Publishing Workflow

1. Edit code in this repo
2. Bump version in `package.json`
3. Commit and push to GitHub
4. **User must run `npm publish`** (requires OTP)
5. Update version in `indiekit-cloudron/Dockerfile` (npm install line)
6. Update `indiekit.config.js.rmendes` if config changed
7. Update `start.sh.rmendes` if polling logic changed
8. Run `cd /home/rick/code/indiekit-dev/indiekit-cloudron && make prepare && cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Related Files

- `indiekit-cloudron/config/indiekit.config.js.rmendes` - Production config for rmendes.net
- `indiekit-cloudron/config/start.sh.rmendes` - Background polling loop implementation
- `indiekit-cloudron/nginx.conf` - nginx routes (ensure `/webmention-sender` is proxied to `:8080`)

## Performance Considerations

- **Sequential processing:** Links processed one at a time (no parallel requests)
- **Timeout per link:** 10 seconds default (configurable)
- **Max posts per run:** 10 posts (hard-coded in `getPostsNeedingWebmentions`)
- **No rate limiting:** Plugin does not implement rate limiting (relies on target sites)

For sites with many posts/links, consider:
- Increasing poll interval (reduce frequency)
- Decreasing `timeout` (faster failure for unresponsive sites)
- Processing specific posts via `source_url` parameter
