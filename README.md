# Family Photo Evidence

A web app that turns family photos into one PDF. Each photo is printed with its date, place, the people in it and a sentence describing it. The PDF is typeset in a TrueType conversion of Latin Modern, the default LaTeX typeface, so it reads like a LaTeX document with numbered figures and a list of photographs on page 1.

It was built to show a family relationship in a visa application. Nothing in it is specific to one visa.

## Privacy

The app is static HTML & JavaScript served from GitHub Pages. It makes no network requests except to load its own files. Photos and text are stored in the browser's IndexedDB on the device you use, and the PDF is built on that device with pdf-lib. Nothing is uploaded. "Delete all photos and text from this browser" at the bottom of the page clears the stored data.

## Use

1. Open the page on a phone or laptop.
2. Tap **Add photos**. On iPhone and Android this opens the photo library or camera. On a laptop you can also drag photos onto the page or paste a screenshot.
3. Check the date on each photo. The app reads the camera date from the photo's EXIF data. If EXIF is missing, it reads the date from file names such as `IMG-20250302-WA0007.jpg` (WhatsApp) or `PXL_20250302_...` (Pixel). If neither works, enter the date yourself. Tick **Month only** if you know only the month.
4. Write a description for each photo. Place and people are optional. **Sort by date** puts the oldest photo first.
5. Fill in **Document details** (title, names, optional reference number) and set the size limit to the limit of the form you upload to.
6. Tap **Create PDF**. With "Best quality under size limit", the app builds the PDF at high quality and steps down through standard, small and very small until the file fits the limit.

Every photo needs a date & a description before the PDF is created.

On Android, install the app from the browser menu ("Install app" or "Add to Home screen"). It then appears in the share sheet of the gallery, so you can share photos straight into it. iOS Safari does not support the Web Share Target API, so on iPhone use **Add photos**.

## Files

- `index.html` and `styles.css` hold the page.
- `app.js` handles photo intake, EXIF and filename dates, editing and storage.
- `pdf.js` does the typesetting, such as line breaking, justified captions, the list of photographs with dot leaders, and page headers & footers.
- `db.js` wraps IndexedDB.
- `sw.js` and `manifest.webmanifest` provide offline support and the Android share target.
- `vendor/` holds pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, exifr 7.1.3 (lite build), heic2any 0.0.4 (loaded only when a desktop browser cannot decode a HEIC file).
- `fonts/` holds FPE Roman, derived from Latin Modern Roman 10 v2.004 under the GUST Font License (see `fonts/README.txt`).

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or HTTPS.
