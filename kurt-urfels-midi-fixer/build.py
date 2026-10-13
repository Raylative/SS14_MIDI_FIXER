#!/usr/bin/env python3
"""Builds index.html, a single self-contained page, from src/ and assets/.

Usage: python3 build.py
Needs only the Python standard library.
"""
import base64
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def data_uri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


page = (ROOT / "src/page.html").read_text(encoding="utf-8")
core = (ROOT / "src/core.js").read_text(encoding="utf-8")
presets = (ROOT / "src/presets.json").read_text(encoding="utf-8")
for marker in ("/*CORE*/", "/*PRESETS*/", "/*SPRITE*/"):
    assert marker in page, f"{marker} missing from src/page.html"
assert "</script" not in core.lower() and "</script" not in presets.lower()

body = (page.replace("/*CORE*/", core)
            .replace("/*PRESETS*/", presets)
            .replace("/*SPRITE*/", data_uri(ROOT / "assets/kurt-sprite.png", "image/png")))
head_end = body.index("</style>") + len("</style>")
html = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        f"<link rel=\"icon\" href=\"{data_uri(ROOT / 'assets/favicon.png', 'image/png')}\">\n"
        + body[:head_end] + "\n</head>\n<body>\n" + body[head_end:] + "\n</body>\n</html>\n")
(ROOT / "index.html").write_text(html, encoding="utf-8")
print(f"wrote index.html ({len(html) // 1024} KB)")
