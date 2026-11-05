# Family Photo Evidence

A web app that turns family photos into one PDF. You pick the photos from a thumbnail grid, add one caption line each, and get a PDF in which every photo is printed with "Figure 3. 14 March 2025. Your sentence." under it, set in DejaVu Sans and laid out like a LaTeX figure page. The PDF holds nothing else besides page numbers.

It was built to show a family relationship in a visa application. Nothing in it is specific to one visa.

## Privacy

The app is static HTML & JavaScript served from GitHub Pages. It makes no network requests except to load its own files. Photos and captions are stored in the browser's IndexedDB on the device you use, and the PDF is built on that device with pdf-lib. Nothing is uploaded. Removing photos in the app never touches your originals.

## Use

1. **Choose.** Tap **Add photos** and select everything you might use; on a laptop, **Add folder** takes a whole folder. Add from as many sources as you like. The photos appear as one grid sorted by date, with a month label on the first photo of each month. Tap a photo to include it in the PDF. ⤢ shows it full screen, where you can swipe or use the arrow keys and include or exclude with one button.
2. **Captions.** Only the included photos, in date order, each with a large preview, the date and one caption line. Enter jumps to the next caption.
3. **Create PDF.** Works at any stage. With captions or dates still missing, the PDF is a preview and the status line says how many are left. The app builds the PDF at high image quality and steps down through standard, small and very small until it fits the maximum file size (10 MB unless changed under **PDF options**, where you also set 1 or 2 photos per page and A4 or US Letter).

## Prefilled fields

When a photo is added, the app reads what the file holds:

- The date from EXIF (`DateTimeOriginal`, `CreateDate`, `DateTimeDigitized`), XMP or IPTC.
- If there is none, the date in file names such as `IMG-20250302-WA0007.jpg` (WhatsApp) or `PXL_20250302_...` (Pixel), marked "from file name, check".
- If there is none, the file's modified date, marked "file date, check", and only when it is older than one day, because a freshly copied file carries the copy time.
- A caption written into the file: XMP `dc:description`, IPTC caption, EXIF `ImageDescription`, Windows `XPComment` or `XPTitle`. Camera placeholders such as "OLYMPUS DIGITAL CAMERA" are ignored.

GPS positions are not turned into place names, because that needs an online lookup service.

## Project file

**Project file** (top right) saves everything into one ZIP file: every photo at working quality (2000 px on the long edge), a preview of each, and `project.json` with dates, captions and selections. **Share** opens the system share sheet (AirDrop, Telegram and the rest); **Download** saves the file. On a laptop the ZIP opens like any archive, with the photos named by date.

**Open project file** merges one or more project files into what is already in the app:

- The same photo is recognised by what it looks like, not by its file name. The app keeps a 256-bit difference hash of each preview; two photos within 14 bits and at most one day apart count as the same photo. A WhatsApp copy and the camera original of the same picture match; different pictures differ by about 100 bits.
- Date, caption and selection are merged field by field, and the most recent edit wins.
- When both copies exist, the one with more pixels is kept.
- Everything stays sorted by date.

This covers moving to another device, combining two people's sets, and keeping a backup. On iPhone, Safari deletes a website's stored data after 7 days of Safari use without a visit to that site; a site added to the Home Screen is exempt. Add the app to the Home Screen and save a project file now and then.

On Android, install the app from the browser menu ("Install app" or "Add to Home screen"). It then appears in the share sheet: shared photos arrive already included, and a shared project file is merged. iOS Safari does not support the Web Share Target API, so on iPhone use **Add photos** and **Open project file**.

## Files

- `index.html` and `styles.css` hold the page.
- `app.js` handles photo intake, metadata, the grid, the viewer, captions, storage and merging.
- `project.js` writes and reads project files (ZIP, store method, built from Blob parts so large projects are not held in memory).
- `pdf.js` does the typesetting, such as line breaking and LaTeX-style captions (centred when short, justified when longer).
- `db.js` wraps IndexedDB.
- `sw.js` and `manifest.webmanifest` provide offline support and the Android share target.
- `vendor/` holds pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, exifr 7.1.3 (full build, for XMP and IPTC), heic2any 0.0.4 (loaded only when a desktop browser cannot decode a HEIC file).
- `fonts/` holds DejaVu Sans 2.37 (regular, bold, oblique), unmodified from the official release, with its license.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or HTTPS.
