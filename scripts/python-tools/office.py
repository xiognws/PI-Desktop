"""Read, write, and convert Office documents on behalf of Pi-Workspace host-core.

The host runs this file with the Python runtime the installer ships, one short
lived process per tool call. Keeping the Office work here rather than in Rust
has two payoffs: the libraries that actually understand these formats
(openpyxl, python-docx, python-pptx, pypdf, pandas) are Python-only, and a
malformed document can only crash this process, never the host.

Protocol: one JSON request object on stdin, one JSON response object on stdout.
Anything the libraries print goes to stderr so it cannot corrupt the response.
Every response carries "ok"; a failure carries "code" and "error".
"""
from __future__ import annotations

import json
import os
import sys
import traceback


def fail(code: str, message: str, **extra) -> dict:
    return {"ok": False, "code": code, "error": message, **extra}


def require_path(args: dict, key: str = "path") -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def import_or_fail(module: str, code: str):
    try:
        return __import__(module)
    except ImportError as error:  # pragma: no cover - depends on the bundle
        raise RuntimeError(
            f"{module} is not available in the bundled Python runtime ({error}). "
            "Rebuild it with scripts/bundle-python-runtime.mjs."
        ) from error


def describe(path: str) -> dict:
    info = os.stat(path)
    return {"path": path, "bytes": info.st_size}


# ---------------------------------------------------------------- xlsx


def xlsx_read(args: dict) -> dict:
    openpyxl = import_or_fail("openpyxl", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    sheet_name = args.get("sheet")
    max_rows = int(args.get("maxRows") or 200)
    max_cols = int(args.get("maxCols") or 60)
    # data_only reads the cached values Excel stored; a workbook built
    # programmatically has none, so the caller can ask for formulas instead.
    data_only = bool(args.get("valuesOnly", True))
    workbook = openpyxl.load_workbook(path, data_only=data_only, read_only=True)
    try:
        names = list(workbook.sheetnames)
        wanted = [sheet_name] if sheet_name else names[:1]
        sheets = []
        for name in wanted:
            if name not in names:
                return fail("SHEET_NOT_FOUND", f"no sheet named {name!r}", sheets=names)
            sheet = workbook[name]
            rows = []
            truncated = False
            for row_index, row in enumerate(sheet.iter_rows(max_row=max_rows, max_col=max_cols)):
                if row_index >= max_rows:
                    truncated = True
                    break
                values = [cell.value for cell in row]
                # Trailing cells Excel never wrote are padding from the column
                # bound, not data: dropping them keeps a three-column sheet
                # readable instead of 60 nulls per row.
                while values and values[-1] is None:
                    values.pop()
                rows.append(values)
            sheets.append(
                {
                    "name": name,
                    "rows": rows,
                    "rowCount": sheet.max_row,
                    "columnCount": sheet.max_column,
                    "truncated": truncated or sheet.max_row > len(rows),
                }
            )
        return {"ok": True, "format": "xlsx", **describe(path), "sheets": names, "data": sheets}
    finally:
        workbook.close()


def xlsx_write(args: dict) -> dict:
    openpyxl = import_or_fail("openpyxl", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    sheet_name = args.get("sheet") or "Sheet1"
    rows = args.get("rows")
    if not isinstance(rows, list):
        raise ValueError("rows must be an array of arrays")
    if os.path.exists(path) and args.get("mode") == "append":
        workbook = openpyxl.load_workbook(path)
        sheet = workbook[sheet_name] if sheet_name in workbook.sheetnames else workbook.create_sheet(sheet_name)
    else:
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = sheet_name
    for row in rows:
        sheet.append(list(row))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    workbook.save(path)
    return {"ok": True, "format": "xlsx", **describe(path), "sheet": sheet_name, "rowsWritten": len(rows)}


# ---------------------------------------------------------------- docx


def docx_read(args: dict) -> dict:
    docx = import_or_fail("docx", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    max_blocks = int(args.get("maxBlocks") or 400)
    document = docx.Document(path)
    blocks = []
    truncated = False
    for paragraph in document.paragraphs:
        if len(blocks) >= max_blocks:
            truncated = True
            break
        text = paragraph.text
        if text.strip():
            blocks.append({"type": "paragraph", "style": paragraph.style.name, "text": text})
    for index, table in enumerate(document.tables):
        if len(blocks) >= max_blocks:
            truncated = True
            break
        rows = [[cell.text for cell in row.cells] for row in table.rows]
        blocks.append({"type": "table", "index": index, "rows": rows})
    return {
        "ok": True,
        "format": "docx",
        **describe(path),
        "blocks": blocks,
        "truncated": truncated,
        "paragraphCount": len(document.paragraphs),
        "tableCount": len(document.tables),
    }


def docx_write(args: dict) -> dict:
    docx = import_or_fail("docx", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    blocks = args.get("blocks")
    if not isinstance(blocks, list):
        raise ValueError("blocks must be an array")
    document = docx.Document(path) if os.path.exists(path) and args.get("mode") == "append" else docx.Document()
    for block in blocks:
        kind = block.get("type", "paragraph")
        if kind == "paragraph":
            paragraph = document.add_paragraph(block.get("text", ""))
            if block.get("style"):
                try:
                    paragraph.style = block["style"]
                except Exception:
                    # An unknown style name must not lose the text.
                    pass
        elif kind == "heading":
            document.add_heading(block.get("text", ""), level=int(block.get("level", 1)))
        elif kind == "table":
            rows = block.get("rows") or []
            if rows:
                table = document.add_table(rows=len(rows), cols=max(len(row) for row in rows))
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        table.cell(r, c).text = str(value)
        else:
            return fail("INVALID_ARGUMENT", f"unknown block type {kind!r}")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    document.save(path)
    return {"ok": True, "format": "docx", **describe(path), "blocksWritten": len(blocks)}


# ---------------------------------------------------------------- pptx


def pptx_read(args: dict) -> dict:
    pptx = import_or_fail("pptx", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    presentation = pptx.Presentation(path)
    slides = []
    for index, slide in enumerate(presentation.slides):
        shapes = []
        for shape in slide.shapes:
            entry = {"name": shape.name, "shapeType": str(shape.shape_type)}
            if shape.has_text_frame:
                entry["text"] = shape.text_frame.text
            if getattr(shape, "has_table", False) and shape.has_table:
                entry["table"] = [[cell.text for cell in row.cells] for row in shape.table.rows]
            shapes.append(entry)
        slides.append({"index": index, "layout": slide.slide_layout.name, "shapes": shapes})
    return {"ok": True, "format": "pptx", **describe(path), "slides": slides, "slideCount": len(slides)}


def pptx_write(args: dict) -> dict:
    pptx = import_or_fail("pptx", "PYTHON_MISSING_MODULE")
    from pptx.util import Inches  # noqa: F401  (kept for layout blocks)

    path = require_path(args)
    slides = args.get("slides")
    if not isinstance(slides, list):
        raise ValueError("slides must be an array")
    presentation = pptx.Presentation() if not (os.path.exists(path) and args.get("mode") == "append") else pptx.Presentation(path)
    layout_index = int(args.get("layout") or 5)
    for spec in slides:
        layout = presentation.slide_layouts[min(layout_index, len(presentation.slide_layouts) - 1)]
        slide = presentation.slides.add_slide(layout)
        title = spec.get("title")
        if title and slide.shapes.title is not None:
            slide.shapes.title.text = str(title)
        body = spec.get("body")
        if body:
            for shape in slide.placeholders:
                if shape.placeholder_format.idx == 1:
                    shape.text_frame.text = str(body)
                    break
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    presentation.save(path)
    return {"ok": True, "format": "pptx", **describe(path), "slidesWritten": len(slides)}


# ---------------------------------------------------------------- pdf


def pdf_read(args: dict) -> dict:
    pypdf = import_or_fail("pypdf", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    max_pages = int(args.get("maxPages") or 50)
    reader = pypdf.PdfReader(path)
    pages = []
    for index, page in enumerate(reader.pages[:max_pages]):
        try:
            text = page.extract_text() or ""
        except Exception as error:
            text = f"[text extraction failed: {error}]"
        pages.append({"index": index, "text": text})
    return {
        "ok": True,
        "format": "pdf",
        **describe(path),
        "pages": pages,
        "pageCount": len(reader.pages),
        "truncated": len(reader.pages) > max_pages,
    }


def pdf_write(args: dict) -> dict:
    pypdf = import_or_fail("pypdf", "PYTHON_MISSING_MODULE")
    path = require_path(args)
    sources = args.get("sources")
    if not sources:
        raise ValueError("sources must list at least one PDF path")
    writer = pypdf.PdfWriter()
    for source in sources:
        reader = pypdf.PdfReader(source)
        for page in reader.pages:
            writer.add_page(page)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as handle:
        writer.write(handle)
    return {"ok": True, "format": "pdf", **describe(path), "mergedFrom": sources}


# ---------------------------------------------------------------- dispatch

OPERATIONS = {
    ("xlsx", "read"): xlsx_read,
    ("xlsx", "write"): xlsx_write,
    ("docx", "read"): docx_read,
    ("docx", "write"): docx_write,
    ("pptx", "read"): pptx_read,
    ("pptx", "write"): pptx_write,
    ("pdf", "read"): pdf_read,
    ("pdf", "write"): pdf_write,
}


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        json.dump(fail("INVALID_ARGUMENT", f"request is not JSON: {error}"), sys.stdout)
        return 2

    document_format = str(request.get("format", "")).lower()
    operation = str(request.get("operation", "read")).lower()
    args = request.get("args") or {}
    handler = OPERATIONS.get((document_format, operation))
    if handler is None:
        json.dump(
            fail(
                "INVALID_ARGUMENT",
                f"unsupported format/operation: {document_format}/{operation}",
                supported=[f"{f}/{o}" for f, o in OPERATIONS],
            ),
            sys.stdout,
        )
        return 2

    try:
        result = handler(args)
    except ValueError as error:
        result = fail("INVALID_ARGUMENT", str(error))
    except FileNotFoundError as error:
        result = fail("FILE_NOT_FOUND", str(error))
    except RuntimeError as error:
        result = fail("PYTHON_RUNTIME_UNAVAILABLE", str(error))
    except Exception as error:  # a malformed document must not look like a host crash
        result = fail(
            "DOCUMENT_UNREADABLE",
            f"{type(error).__name__}: {error}",
            trace=traceback.format_exc(limit=3),
        )

    json.dump(result, sys.stdout, ensure_ascii=False, default=str)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
