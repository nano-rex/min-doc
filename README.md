# min-doc

A minimal PDF viewer and editor that runs in the browser. It is plain HTML, CSS, and JavaScript with no build step, no server, and no network calls: the PDF never leaves your device.

## Use

Open `index.html` in a browser (double-click it, or serve the folder with any static file server), then click **Open** or drop a PDF on the page.

## Features

View:

- Continuous scrolling, zoom in/out, fit to width, jump to a page.
- Password-protected PDFs can be viewed after entering the password.

Edit:

- **Form fields**: text boxes, checkboxes, radio buttons, dropdowns, and lists that the PDF already has are filled in place. Click a field with Select or Text and type. They stay real, fillable fields in the saved file.
- **Text**: click on a page and type. Double-click existing added text to change it.
- **Draw**: freehand pen with a chosen color and width.
- **Highlight**: drag over an area to mark it in translucent color.
- **Whiteout**: drag over an area to cover it with white, then type new text on top.
- **Image**: place a PNG, JPEG, or other browser-readable image, such as a signature. Images can also be dropped on the page.
- **Select**: move any added item, resize boxes and images by the corner handle, change color and size, delete.
- Undo and redo for every change.

Pages (buttons above each page):

- Move up or down, rotate left or right, delete, insert a blank page.
- **Add PDF** appends the pages of another PDF (merge).

**Save** downloads the result as `<name>-edited.pdf`. The original file is not changed.

Shortcuts: `Ctrl+O` open, `Ctrl+S` save, `Ctrl+Z` undo, `Ctrl+Y` redo, `Del` delete the selected item, `Esc` back to Select.

## Limits

- Ordinary page text (not a form field) cannot be changed in place. Cover it with Whiteout and type over it.
- Whiteout hides content but does not remove it from the file. Do not use it to redact secrets.
- Added text in Latin characters is saved as real, selectable text. Text in other scripts (Chinese, Japanese, Korean, and so on) is saved as an image of the text.
- The first PDF you open keeps its form fields, bookmarks, and properties. Pages added with **Add PDF** get their form values printed on the page and are no longer fillable.
- Form field changes are not part of undo/redo. Signature fields and push buttons are not editable.
- Encrypted PDFs can be viewed but not saved.
- When opened straight from disk (`file://`), PDFs that use non-embedded CJK fonts may show missing glyphs, because browsers block the character map files there. Serving the folder over HTTP avoids this, for example `python3 -m http.server`.

## Layout

- `index.html`, `styles.css`, `app.js`: the app
- `vendor/pdfjs`: [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache-2.0), renders pages
- `vendor/pdf-lib`: [pdf-lib](https://pdf-lib.js.org/) 1.17.1 (MIT), writes the edited PDF
- `tests/test_editor.py`: browser test

## Test

```sh
pip install playwright
python -m playwright install chromium
python tests/test_editor.py
```

The test opens a generated PDF, uses every tool and page operation, saves, and reads the saved file back.

## License

GPL-3.0. See `LICENSE`. Vendored libraries keep their own licenses in `vendor/`.
