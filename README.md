# junglepickleball.com

One-page site for Jungle Pickleball, the indoor pickleball destination in Ojochal, Costa Rica. Four indoor courts, free WiFi, and a community hub.

## Stack

Static HTML, no build step. Tailwind and Alpine.js load from CDN. Hosted on Cloudflare Pages.

- `index.html` - the full single-page site (hero, features, gallery, about, events, FAQ)
- `404.html` - branded not-found page
- `assets/hero/`, `assets/features/`, `assets/gallery/` - image sets
- `_headers` / `_redirects` - Cloudflare Pages config
- `sitemap.xml`, `robots.txt`

## Deploy

Connect this repo to Cloudflare Pages. Build command: none. Output directory: `.`. Every push to `main` publishes automatically.

## Local preview

Any static server works, for example:

```
python -m http.server 8080
```

Then open http://localhost:8080.
