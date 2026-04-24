# Logo assets

Drop your PNGs (and optionally SVG) in this folder. After you push them I'll wire favicons, apple-touch-icon, PWA manifest icons, OG image, and swap the `[B]` placeholder in the UI.

## What to provide

### Option A — minimum (fastest for you)

| File | Size | Notes |
|------|------|-------|
| `logo-master.png` | **1024 × 1024** | Transparent background. Bear logomark only (no wordmark). Keep ~10 % padding around the bear so it reads at small sizes. |

That's it — I'll generate every other size from this master with a script.

### Option B — full set (if you'd rather export them yourself from Paper)

Drop each of these as transparent PNGs (square, centered):

| File | Size | Purpose |
|------|------|---------|
| `logo-1024.png` | 1024 × 1024 | Master, archive |
| `icon-512.png` | 512 × 512 | PWA install / Android home screen |
| `icon-192.png` | 192 × 192 | PWA / Chrome tabs |
| `apple-touch-icon.png` | 180 × 180 | iOS add to home screen |
| `favicon-32.png` | 32 × 32 | Browser tab |
| `favicon-16.png` | 16 × 16 | Browser tab (fallback) |

### Optional but great

| File | Size | Notes |
|------|------|-------|
| `logo.svg` | any | Vector logomark — lets the UI render crisp at any size. If you can export with `currentColor` strokes/fills, even better (adapts to dark mode). |
| `og-image.png` | **1200 × 630** | Social share card (Twitter, LinkedIn, iMessage preview). Include the bear + `>the comp.ai` wordmark + maybe the tagline *"Your own AI infrastructure, on every device."* on a navy `#0F2F4F` background. |
| `logo-white.svg` or `logo-white-1024.png` | — | White / light variant if the main logo has dark parts, for use on dark surfaces. |

## What happens after you drop the files

1. I detect what's there.
2. If Option A: I run a small script (`scripts/gen-logo-assets.js` with `sharp`) to derive the 6 raster sizes from the master.
3. Wire everything in `index.html` (`<link rel="icon" …>`, `<meta property="og:image">`, etc.) and add `public/manifest.webmanifest` for PWA.
4. Replace the `[B]` placeholder in `src/components/Wordmark.tsx` and the sidebar avatar with the real logo (SVG preferred, PNG fallback).
5. Ship to `dev.thecomp.ai` so you can see it live.

No need to touch anything else — just drop the files and tell me.
