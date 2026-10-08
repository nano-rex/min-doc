"""Browser test for min-doc: open, edit, rearrange, save, and read the result back.

Needs Playwright for Python with a Chromium build:

    pip install playwright
    python -m playwright install chromium
    python tests/test_editor.py

Set SHOTS=<folder> to keep screenshots of the editor and of the saved file.
"""

import os
import pathlib
import struct
import sys
import tempfile
import zlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = os.environ.get("SHOTS")

MAKE_PDF = """
async () => {
  const { PDFDocument, StandardFonts, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  ['First', 'Second', 'Third'].forEach((word, i) => {
    const page = doc.addPage([400, 500]);
    page.drawText(word + ' page', { x: 40, y: 440, size: 28, font });
    if (i === 1) page.setRotation(degrees(90));
  });
  // Form fields at the bottom of the first page.
  const first = doc.getPage(0);
  const form = doc.getForm();
  const name = form.createTextField('person.name');
  name.setText('old name');
  name.addToPage(first, { x: 40, y: 90, width: 150, height: 20 });
  form.createCheckBox('agree').addToPage(first, { x: 40, y: 60, width: 15, height: 15 });
  const color = form.createDropdown('color');
  color.addOptions(['Red', 'Green', 'Blue']);
  color.addToPage(first, { x: 40, y: 30, width: 150, height: 20 });
  const size = form.createRadioGroup('size');
  size.addOptionToPage('small', first, { x: 220, y: 60, width: 15, height: 15 });
  size.addOptionToPage('large', first, { x: 250, y: 60, width: 15, height: 15 });
  return Array.from(await doc.save());
}
"""

READ_PDF = """
async (bytes) => {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const fields = {};
    for (const a of await page.getAnnotations()) {
      if (a.subtype === 'Widget') fields[a.fieldName] = a.fieldValue;
    }
    pages.push({ rotate: page.rotate, text: content.items.map((item) => item.str).join(' '), fields });
  }
  const lib = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
  const form = lib.getForm();
  return {
    pages,
    fillable: form.getFields().map((field) => field.getName()).sort(),
    name: form.getTextField('person.name').getText(),
    agree: form.getCheckBox('agree').isChecked(),
    size: form.getRadioGroup('size').getSelected(),
  };
}
"""


def png(width, height, rgb):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    rows = (b"\x00" + bytes(rgb) * width) * height
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok  ", message)


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name), full_page=False)


def sheet_box(page, index):
    return page.locator(".sheet").nth(index).bounding_box()


def drag(page, index, start, end):
    box = sheet_box(page, index)
    page.mouse.move(box["x"] + start[0], box["y"] + start[1])
    page.mouse.down()
    page.mouse.move(box["x"] + (start[0] + end[0]) / 2, box["y"] + (start[1] + end[1]) / 2, steps=4)
    page.mouse.move(box["x"] + end[0], box["y"] + end[1], steps=4)
    page.mouse.up()


def type_text(page, index, at, text):
    box = sheet_box(page, index)
    page.click("[data-tool=text]")
    page.mouse.click(box["x"] + at[0], box["y"] + at[1])
    page.keyboard.type(text)
    page.keyboard.press("Escape")


def objects(page):
    return page.evaluate("minDoc.state.pages.map((p) => p.objs.map((o) => o.type))")


def run(page):
    errors = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(ROOT.joinpath("index.html").as_uri())
    data = page.evaluate(MAKE_PDF)
    page.evaluate("(b) => minDoc.loadPdf('sample.pdf', new Uint8Array(b), false)", data)
    page.evaluate("document.getElementById('zoom-label').textContent")
    check(page.locator(".page").count() == 3, "three pages are shown")
    page.wait_for_function("document.querySelector('.sheet canvas').width > 100")
    check(page.locator("#save").is_enabled(), "save is enabled after opening")

    # The form fields of the PDF are filled in place, in Select and in Text mode.
    fields = page.locator(".page").nth(0).locator(".fields > *")
    fields.first.wait_for()
    check(fields.count() == 5, "the five form widgets of page 1 are editable")
    name = page.locator("[data-field='person.name']")
    check(name.input_value() == "old name", "a text field shows its current value")
    page.click("[data-tool=text]")
    name.click()
    name.fill("Ada Lovelace")
    check(objects(page)[0] == [], "clicking a field with the Text tool edits the field, not a new text item")
    page.click("[data-tool=select]")
    page.locator("[data-field=agree]").check()
    page.locator("[data-field=color]").select_option("Green")
    radios = page.locator("[data-field=size]")
    radios.nth(0).check()
    radios.nth(1).check()
    check(not radios.nth(0).is_checked(), "radio buttons of one group exclude each other")

    # Page 1: text, pen, highlight, whiteout.
    type_text(page, 0, (60, 150), "Hello min-doc")
    page.click("[data-tool=draw]")
    drag(page, 0, (60, 220), (220, 260))
    page.click("[data-tool=highlight]")
    drag(page, 0, (40, 40), (220, 90))
    page.click("[data-tool=whiteout]")
    drag(page, 0, (250, 300), (330, 340))
    check(objects(page)[0] == ["text", "path", "highlight", "whiteout"], "four items were added to page 1")

    # Select the text and move it.
    page.click("[data-tool=select]")
    before = page.evaluate("minDoc.state.pages[0].objs[0].x")
    drag(page, 0, (70, 146), (120, 146))
    after = page.evaluate("minDoc.state.pages[0].objs[0].x")
    check(after > before + 10, "dragging moves the selected text")

    # Undo and redo the move.
    page.keyboard.press("Control+z")
    check(abs(page.evaluate("minDoc.state.pages[0].objs[0].x") - before) < 0.01, "undo restores the position")
    page.keyboard.press("Control+y")
    check(abs(page.evaluate("minDoc.state.pages[0].objs[0].x") - after) < 0.01, "redo applies it again")

    # Delete the whiteout with the keyboard.
    box = sheet_box(page, 0)
    page.mouse.click(box["x"] + 290, box["y"] + 320)
    page.keyboard.press("Delete")
    check(objects(page)[0] == ["text", "path", "highlight"], "delete removes the selected item")

    # Place an image, resize it by its handle, then rotate the page twice.
    page.set_input_files("#file-image", {"name": "stamp.png", "mimeType": "image/png", "buffer": png(80, 40, (200, 30, 30))})
    page.wait_for_function("minDoc.state.pages[0].objs.length === 4")
    image = page.evaluate("minDoc.state.pages[0].objs[3]")
    check(image["type"] == "image" and abs(image["w"] / image["h"] - 2) < 0.01, "image is placed with its aspect ratio")
    scale = page.evaluate("minDoc.state.scale")
    corner = ((image["x"] + image["w"]) * scale, (image["y"] + image["h"]) * scale)
    drag(page, 0, corner, (corner[0] + 50, corner[1] + 10))
    resized = page.evaluate("minDoc.state.pages[0].objs[3]")
    check(resized["w"] > image["w"] + 20 and abs(resized["w"] / resized["h"] - 2) < 0.01, "the handle resizes the image")
    page.locator(".page").nth(0).get_by_title("Rotate right").click()
    turned = page.evaluate("minDoc.state.pages[0].objs[3]")
    check(abs(turned["h"] / turned["w"] - 2) < 0.01, "rotating the page turns the image with it")
    page.locator(".page").nth(0).get_by_title("Rotate left").click()
    back = page.evaluate("minDoc.state.pages[0].objs[3]")
    check(abs(back["x"] - resized["x"]) < 0.01 and abs(back["y"] - resized["y"]) < 0.01, "rotating back returns it to the same place")

    # Page 2 is rotated in the file: latin text and text the built in font cannot encode.
    page.locator(".page").nth(1).scroll_into_view_if_needed()
    type_text(page, 1, (60, 200), "Rotated note")
    type_text(page, 1, (60, 260), "你好 PDF")
    shot(page, "editor-page2.png")

    # Page operations: rotate page 3, move it to the front, add a blank page, merge.
    page.click("[data-tool=select]")
    page.locator(".page").nth(2).get_by_title("Rotate right").click()
    page.locator(".page").nth(2).get_by_title("Move page up").click()
    page.locator(".page").nth(1).get_by_title("Move page up").click()
    page.locator(".page").nth(0).get_by_title("Insert a blank page after this one").click()
    page.evaluate("(b) => minDoc.loadPdf('more.pdf', new Uint8Array(b), true)", data)
    check(page.locator(".page").count() == 7, "seven pages after blank page and merge")
    page.locator(".page").nth(6).get_by_title("Delete page").click()
    page.locator(".page").nth(5).get_by_title("Delete page").click()
    check(page.locator(".page").count() == 5, "five pages after deleting two")

    with page.expect_download() as info:
        page.click("#save")
    download = info.value
    check(download.suggested_filename == "sample-edited.pdf", "download is named sample-edited.pdf")
    saved = pathlib.Path(tempfile.mkdtemp()) / "out.pdf"
    download.save_as(saved)
    raw = saved.read_bytes()
    check(raw.startswith(b"%PDF-"), "saved file is a PDF")

    read = page.evaluate(READ_PDF, list(raw))
    result = read["pages"]
    check(len(result) == 5, "saved file has five pages")
    check([p["rotate"] for p in result] == [90, 0, 0, 90, 0], "page rotations are kept")
    check("Third page" in result[0]["text"], "moved page comes first")
    check(result[1]["text"] == "", "blank page is empty")
    check("First page" in result[2]["text"] and "Hello min-doc" in result[2]["text"], "added text is real text in the file")
    check("Second page" in result[3]["text"] and "Rotated note" in result[3]["text"], "text on the rotated page is saved")
    check("First page" in result[4]["text"], "merged page is kept")
    check(read["fillable"] == ["agree", "color", "person.name", "size"], "the form fields are still fillable fields")
    check(read["name"] == "Ada Lovelace" and read["agree"] and read["size"] == "large", "the new field values are saved")
    check(result[2]["fields"].get("color") == ["Green"], "the dropdown choice is saved on the moved page")
    check(result[4]["fields"] == {}, "the merged copy of the form page has no clashing fields")

    # Open the saved file in the editor again to compare by eye.
    page.evaluate("(b) => { minDoc.state.dirty = false; return minDoc.loadPdf('out.pdf', new Uint8Array(b), false); }", list(raw))
    page.locator(".page").nth(3).scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    shot(page, "saved-page2.png")
    page.locator(".page").nth(2).scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    shot(page, "saved-page1.png")
    check(not errors, "no script errors: %s" % errors)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        try:
            run(page)
        finally:
            browser.close()
    print("all checks passed")


if __name__ == "__main__":
    sys.exit(main())
