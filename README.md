# Family Photo Evidence

A web app that turns family photos into one PDF. You pick the photos from a thumbnail grid, add one caption line each, and get a PDF in which every photo is printed with "Figure 3. 14 March 2025. Your sentence." under it, set in a TrueType conversion of Latin Modern, the default LaTeX typeface. The PDF holds nothing else besides page numbers.

It was built to show a family relationship in a visa application. Nothing in it is specific to one visa.

## Privacy

The app is static HTML & JavaScript served from GitHub Pages. It makes no network requests except to load its own files. Photos and captions are stored in the browser's IndexedDB on the device you use, and the PDF is built on that device with pdf-lib. Nothing is uploaded. Removing photos in the app never touches your originals.

## Use

1. **Choose.** Tap **Add photos** and select everything you might use; on a laptop, **Add folder** takes a whole folder. The photos appear as one grid sorted by date, with a month label on the first photo of each month. Tap a photo to include it in the PDF. ⤢ shows it full screen, where you can swipe or use the arrow keys and include or exclude with one button.
2. **Captions.** Only the included photos, in date order, each with a large preview, the date and one caption line. The date comes from the photo's EXIF data, or from file names such as `IMG-20250302-WA0007.jpg` (WhatsApp). Change it if it is wrong. Enter jumps to the next caption.
3. **Create PDF.** Every included photo needs a date & a caption. With the default maximum file size of 10 MB, the app builds the PDF at high image quality and steps down through standard, small and very small until it fits. **PDF options** at the bottom of the captions step sets photos per page (1 or 2), paper (A4 or US Letter) and the maximum size.

On Android, install the app from the browser menu ("Install app" or "Add to Home screen"). It then appears in the gallery's share sheet, and shared photos arrive already included. iOS Safari does not support the Web Share Target API, so on iPhone use **Add photos**.

## Files

- `index.html` and `styles.css` hold the page.
- `app.js` handles photo intake, EXIF and filename dates, the grid, the viewer, captions and storage.
- `pdf.js` does the typesetting, such as line breaking and LaTeX-style captions (centred when short, justified when longer).
- `db.js` wraps IndexedDB.
- `sw.js` and `manifest.webmanifest` provide offline support and the Android share target.
- `vendor/` holds pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, exifr 7.1.3 (lite build), heic2any 0.0.4 (loaded only when a desktop browser cannot decode a HEIC file).
- `fonts/` holds FPE Roman, derived from Latin Modern Roman 10 v2.004 under the GUST Font License (see `fonts/README.txt`).

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or HTTPS.
