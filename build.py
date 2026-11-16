#!/usr/bin/env python3
"""Build dist/AVRIS_Visit_Report.html: one self-contained file (screens, report engine and Python runtime).

    python3 build.py
"""
import base64
import gzip
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC, VENDOR, DIST = ROOT / "src", ROOT / "vendor" / "pyodide", ROOT / "dist"


def pack(path, compress=True):
    data = path.read_bytes()
    if compress:
        data = gzip.compress(data, 9, mtime=0)
    return base64.b64encode(data).decode("ascii")


def runtime_script():
    """The two Pyodide loader files as one classic script (no modules, no blob URLs, no dynamic import)."""
    asm = (VENDOR / "pyodide.asm.mjs").read_text(encoding="utf-8")
    ldr = (VENDOR / "pyodide.mjs").read_text(encoding="utf-8")
    ldr = ldr.split("//# sourceMappingURL")[0]
    assert asm.rstrip().endswith("export default _createPyodideModule;")
    asm = asm.rstrip()[: -len("export default _createPyodideModule;")]
    tail = "export{dt as loadPyodide,U as version};"
    assert ldr.rstrip().endswith(tail)
    ldr = ldr.rstrip()[: -len(tail)]
    needle = "let t=`${e.indexURL}pyodide.asm.mjs`;return(await O(t)).default"
    assert ldr.count(needle) == 1
    ldr = ldr.replace(needle, "return globalThis.__avrisCreateModule")
    url = "globalThis.__avrisBase"
    asm, ldr = asm.replace("import.meta.url", url), ldr.replace("import.meta.url", url)
    assert "import.meta" not in asm + ldr
    return ("globalThis.__avrisBase = 'https://avris.invalid/pyodide/pyodide.js';\n"
            "globalThis.__avrisCreateModule = (function(){\n" + asm + "\nreturn _createPyodideModule;})();\n"
            "globalThis.__avrisLoadPyodide = (function(){\n" + ldr + "\nreturn dt;})();\n")


def main():
    parts = {
        "d-wasm": pack(VENDOR / "pyodide.asm.wasm"), "d-lock": pack(VENDOR / "pyodide-lock.json"),
        "d-core": pack(SRC / "py" / "avris_core.py"), "d-engine": pack(SRC / "py" / "engine.py"),
        "d-stdlib": pack(VENDOR / "python_stdlib.zip", compress=False),   # already a zip
    }
    payloads = "\n".join(f'  <script id="{k}" type="text/plain">{v}</script>' for k, v in parts.items())
    html = (SRC / "index.template.html").read_text(encoding="utf-8")
    for key, val in (("/*STYLE*/", (SRC / "app.css").read_text(encoding="utf-8")),
                     ("<!--PAYLOADS-->", payloads),
                     ("/*RUNTIME*/", runtime_script()),
                     ("/*CLOUD*/", (SRC / "cloud.js").read_text(encoding="utf-8")),
                     ("/*LOCAL*/", (SRC / "local.js").read_text(encoding="utf-8")),
                     ("/*APP*/", (SRC / "app.js").read_text(encoding="utf-8"))):
        assert html.count(key) == 1, key
        assert key == "<!--PAYLOADS-->" or "</script" not in val.lower(), f"{key} contains a closing script tag"
        html = html.replace(key, val)
    DIST.mkdir(exist_ok=True)
    out = DIST / "AVRIS_Visit_Report.html"
    out.write_text(html, encoding="utf-8")
    print(f"{out}  {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
