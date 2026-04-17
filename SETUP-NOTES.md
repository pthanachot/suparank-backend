# Setup Notes for Team

## After pulling latest changes

### Private B2 Image Storage (presigned URLs)

**Run in the backend repo:**
```
npm install
```

This installs the new `@aws-sdk/s3-request-presigner` package (needed for generating signed URLs for the private B2 bucket).

**New environment variables** (add to your `.env`):
```
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_BUCKET=your-bucket-name
B2_KEY_ID=your-application-key-id
B2_APP_KEY=your-application-key
B2_CDN_URL=                # optional, leave empty if not using a CDN
```

If these are not set, B2 storage is disabled and images fall back to base64 in MongoDB (same as before).

**Bucket must be PRIVATE** — no public read access. Images are served via presigned URLs that expire after 1 hour (auto-refreshed on each request).
