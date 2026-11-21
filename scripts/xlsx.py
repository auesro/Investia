"""Minimal .xlsx reader using only the standard library.

read(data: bytes) -> {sheet_name: [(row_number, {"A": "value", ...}), ...]}
Cell values are returned as strings (numbers in their raw stored form).
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"


def _text(node) -> str:
    return "".join(t.text or "" for t in node.iter(f"{{{M}}}t"))


def read(data: bytes) -> dict[str, list[tuple[int, dict[str, str]]]]:
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    shared = []
    if "xl/sharedStrings.xml" in names:
        shared = [_text(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{{{M}}}si")]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels.findall(f"{{{PR}}}Relationship")}

    out = {}
    for sheet in wb.find(f"{{{M}}}sheets"):
        target = targets[sheet.get(f"{{{R}}}id")].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        rows = []
        for row in ET.fromstring(z.read(target)).iter(f"{{{M}}}row"):
            cells = {}
            for c in row.findall(f"{{{M}}}c"):
                col = re.match(r"[A-Z]+", c.get("r", "")).group()
                kind, v = c.get("t"), c.find(f"{{{M}}}v")
                if kind == "inlineStr":
                    cells[col] = _text(c)
                elif v is None or v.text is None:
                    continue
                elif kind == "s":
                    cells[col] = shared[int(v.text)]
                else:
                    cells[col] = v.text
            rows.append((int(row.get("r")), cells))
        out[sheet.get("name").strip()] = rows
    return out
