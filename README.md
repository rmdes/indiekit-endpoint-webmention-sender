# @rmdes/indiekit-endpoint-webmention-sender

Webmention sender endpoint for Indiekit. Automatically discovers and sends webmentions for published posts.

## What it does

When triggered, this plugin:

1. Finds posts that haven't had webmentions sent yet
2. Extracts external links from post content
3. Discovers webmention endpoints on target URLs (via Link header or HTML)
4. Sends webmentions (or pingbacks as fallback)
5. Marks posts as processed to avoid duplicate sends

## Installation

```bash
npm install @rmdes/indiekit-endpoint-webmention-sender
```

## Usage

Add `@rmdes/indiekit-endpoint-webmention-sender` to your Indiekit config:

```js
export default {
  plugins: [
    "@rmdes/indiekit-endpoint-webmention-sender",
    // ... other plugins
  ],

  "@rmdes/indiekit-endpoint-webmention-sender": {
    mountPath: "/webmention-sender", // Optional, defaults to /webmention-sender
    timeout: 10000, // Optional, endpoint discovery timeout in ms
    userAgent: "My Site Webmention Sender", // Optional
  },
};
```

## API

### GET /webmention-sender

Returns status information about pending and sent webmentions.

**Response:**
```json
{
  "pending": 5,
  "sent": 42
}
```

### POST /webmention-sender

Processes pending posts and sends webmentions. Requires authentication.

**Headers:**
- `Authorization: Bearer <token>` (must have `update` scope)

**Query Parameters:**
- `source_url` (optional) - Process only a specific post URL

**Response:**
```json
{
  "success": "OK",
  "success_description": "Processed 2 posts: 5 sent, 1 failed, 3 skipped",
  "results": [
    {
      "url": "https://example.com/posts/hello",
      "sent": [
        { "target": "https://other.site/article", "endpoint": "https://other.site/webmention", "type": "webmention", "status": 202 }
      ],
      "failed": [],
      "skipped": [
        { "target": "https://no-webmention.site/", "reason": "No webmention endpoint found" }
      ]
    }
  ]
}
```

## Automatic Processing

For automatic webmention sending, add a polling loop to your deployment. Example for Cloudron's `start.sh`:

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
                RESULT=$(curl -s -X POST "http://localhost:8080/webmention-sender?token=${TOKEN}" 2>&1)
                echo "[webmention] $(date '+%Y-%m-%d %H:%M:%S') - $RESULT"
            fi
        fi

        sleep 300  # 5 minutes
    done
) &
```

## How it works

1. **Link Extraction**: Uses Cheerio to parse HTML and extract all external links (excluding internal links and share intents)

2. **Endpoint Discovery**: For each target URL:
   - Checks `Link` HTTP header for `rel="webmention"`
   - Checks `X-Pingback` header (fallback)
   - Parses HTML for `<link rel="webmention">` or `<a rel="webmention">`

3. **Sending**: Sends a POST request with `source` and `target` parameters:
   ```
   POST /webmention HTTP/1.1
   Content-Type: application/x-www-form-urlencoded

   source=https://your.site/post&target=https://their.site/article
   ```

4. **Tracking**: Stores `webmention-sent: true` on processed posts in MongoDB to prevent duplicate sends

## License

MIT
