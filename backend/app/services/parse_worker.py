"""书籍解析子进程。

以 `python -m app.services.parse_worker <格式> <原文件> <输出目录> <编码> <EPUB解压上限> <EPUB文件数上限>`
方式运行，结果以 JSON 写到标准输出。放在独立子进程中，便于超时强制结束，且不阻塞 API。
"""

import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path

from defusedxml import ElementTree as ET


class ParseError(Exception):
    """可直接展示给用户的解析错误。"""


# ---------- PDF ----------


def parse_pdf(src: Path, out: Path) -> dict:
    import pymupdf

    try:
        doc = pymupdf.open(src)
    except Exception as e:  # noqa: BLE001
        raise ParseError("PDF 文件已损坏或无法解析") from e
    if doc.needs_pass:
        raise ParseError("PDF 有密码保护，暂不支持打开")
    if doc.page_count == 0:
        raise ParseError("PDF 没有任何页面")

    # 均匀抽样若干页判断是否有文字层
    n = doc.page_count
    sample = sorted({int(i * (n - 1) / 9) for i in range(10)}) if n > 1 else [0]
    text_pages = sum(1 for i in sample if doc[i].get_text().strip())
    has_text = text_pages >= max(1, len(sample) // 3)

    pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(0.6, 0.6))
    pix.save(out / "cover.jpg", jpg_quality=80)

    toc = [
        {"level": lvl, "title": title.strip(), "page": page}
        for lvl, title, page, *_ in doc.get_toc(simple=True)
        if page >= 1
    ]
    md = doc.metadata or {}
    return {
        "title": (md.get("title") or "").strip() or None,
        "author": (md.get("author") or "").strip() or None,
        "page_count": n,
        "has_text_layer": has_text,
        "has_cover": True,
        "meta": {"toc": toc[:2000]},
    }


# ---------- EPUB ----------

# Adobe 等字体混淆算法不算 DRM
FONT_OBFUSCATION = {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}
NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "enc": "http://www.w3.org/2001/04/xmlenc#",
}

SCRIPT_RE = re.compile(rb"<script\b[^>]*?(/>|>.*?</script\s*>)", re.I | re.S)
EVENT_ATTR_RE = re.compile(rb"""\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.I)
EXTERNAL_REF_RE = re.compile(
    rb"""(\s(?:src|href|xlink:href|poster|data)\s*=\s*)(["'])\s*(?:https?:|//|javascript:)[^"']*\2""", re.I
)
CSS_EXTERNAL_RE = re.compile(rb"""(url\(\s*["']?)(?:https?:|//)[^)"']*""", re.I)
CSS_IMPORT_RE = re.compile(rb"""@import\s+(?:url\()?["']?(?:https?:|//)[^;]*;""", re.I)


def sanitize_markup(data: bytes) -> bytes:
    """去掉脚本、事件属性和外部资源引用。阅读器 iframe 同时禁用脚本，这里是第二道防线。"""
    data = SCRIPT_RE.sub(b"", data)
    data = EVENT_ATTR_RE.sub(b"", data)
    data = EXTERNAL_REF_RE.sub(rb"\1\2#\2", data)
    return sanitize_css(data)


def sanitize_css(data: bytes) -> bytes:
    data = CSS_IMPORT_RE.sub(b"", data)
    return CSS_EXTERNAL_RE.sub(rb"\1about:blank", data)


def parse_epub(src: Path, out: Path, max_uncompressed: int, max_files: int) -> dict:
    try:
        zf = zipfile.ZipFile(src)
        infos = zf.infolist()
    except (zipfile.BadZipFile, OSError) as e:
        raise ParseError("EPUB 文件已损坏或不是有效的 EPUB") from e

    if len(infos) > max_files:
        raise ParseError("EPUB 内文件数量过多，已拒绝解析")
    if sum(i.file_size for i in infos) > max_uncompressed:
        raise ParseError("EPUB 解压后体积过大，已拒绝解析")
    names = {i.filename for i in infos}
    for name in names:
        if name.startswith("/") or "\\" in name or ".." in name.split("/"):
            raise ParseError("EPUB 内含非法路径，已拒绝解析")

    if "META-INF/rights.xml" in names:
        raise ParseError("EPUB 受 DRM 保护，暂不支持打开")
    if "META-INF/encryption.xml" in names:
        enc = ET.fromstring(zf.read("META-INF/encryption.xml"))
        for em in enc.iter(f"{{{NS['enc']}}}EncryptionMethod"):
            if em.get("Algorithm") not in FONT_OBFUSCATION:
                raise ParseError("EPUB 受 DRM 保护，暂不支持打开")

    if "META-INF/container.xml" not in names:
        raise ParseError("EPUB 缺少 container.xml，文件已损坏")
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(".//c:rootfile", NS)
    if rootfile is None or rootfile.get("full-path") not in names:
        raise ParseError("EPUB 缺少内容清单，文件已损坏")
    opf_path = rootfile.get("full-path")
    opf_dir = posixpath.dirname(opf_path)
    opf = ET.fromstring(zf.read(opf_path))

    def text_of(tag: str) -> str | None:
        el = opf.find(f".//dc:{tag}", NS)
        return el.text.strip() if el is not None and el.text and el.text.strip() else None

    manifest = {it.get("id"): it for it in opf.iterfind(".//opf:manifest/opf:item", NS)}
    spine = [
        manifest[r.get("idref")] for r in opf.iterfind(".//opf:spine/opf:itemref", NS) if r.get("idref") in manifest
    ]
    if not spine:
        raise ParseError("EPUB 没有可阅读的章节")

    # 封面：EPUB3 properties=cover-image，或 EPUB2 <meta name="cover">
    cover_item = next((it for it in manifest.values() if "cover-image" in (it.get("properties") or "")), None)
    if cover_item is None:
        meta = opf.find(".//opf:meta[@name='cover']", NS)
        if meta is not None:
            cover_item = manifest.get(meta.get("content"))
    has_cover = False
    if cover_item is not None and (cover_item.get("media-type") or "").startswith("image/"):
        cover_name = posixpath.normpath(posixpath.join(opf_dir, cover_item.get("href")))
        if cover_name in names:
            has_cover = save_cover_image(zf.read(cover_name), out / "cover.jpg")

    # 生成清理过脚本和外部资源的副本供阅读器使用
    with zipfile.ZipFile(out / "sanitized.epub", "w") as dst:
        if "mimetype" in names:
            dst.writestr("mimetype", zf.read("mimetype"), compress_type=zipfile.ZIP_STORED)
        for info in infos:
            if info.filename == "mimetype" or info.is_dir():
                continue
            data = zf.read(info.filename)
            low = info.filename.lower()
            if low.endswith((".xhtml", ".html", ".htm", ".svg", ".xml", ".opf", ".ncx")):
                data = sanitize_markup(data)
            elif low.endswith(".css"):
                data = sanitize_css(data)
            elif low.endswith(".js"):
                data = b""
            dst.writestr(info.filename, data, compress_type=zipfile.ZIP_DEFLATED)

    return {
        "title": text_of("title"),
        "author": text_of("creator"),
        "page_count": None,
        "has_text_layer": True,
        "has_cover": has_cover,
        "meta": {"chapters": len(spine)},
    }


def save_cover_image(data: bytes, dest: Path) -> bool:
    import pymupdf

    try:
        pix = pymupdf.Pixmap(data)
        if pix.alpha or pix.n > 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        if pix.width > 400:
            pix = pymupdf.Pixmap(pix, 400, int(pix.height * 400 / pix.width), None)
        pix.save(dest, jpg_quality=80)
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------- TXT ----------

CHAPTER_RE = re.compile(
    r"^\s*(第[0-9零一二三四五六七八九十百千两〇]{1,12}[章节回卷部篇集]|序章|序言|楔子|前言|后记|尾声|番外|Chapter\s+\d+)",
    re.I,
)


def decode_text(raw: bytes, encoding: str | None) -> tuple[str, str]:
    if encoding:
        try:
            return raw.decode(encoding), encoding
        except (UnicodeDecodeError, LookupError) as e:
            raise ParseError(f"无法使用 {encoding} 解码该文本") from e
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16"), "utf-16"
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc), "utf-8" if enc == "utf-8-sig" else enc
        except UnicodeDecodeError:
            continue
    from charset_normalizer import from_bytes

    best = from_bytes(raw).best()
    if best is None:
        raise ParseError("无法识别文本编码，请在书籍管理中手动选择编码后重试")
    return str(best), best.encoding


def parse_txt(src: Path, out: Path, encoding: str | None) -> dict:
    raw = src.read_bytes()
    if b"\x00" in raw[:4096] and not raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ParseError("文件看起来不是纯文本")
    text, used = decode_text(raw, encoding)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [p for p in (line.strip() for line in text.split("\n")) if p]
    if not paragraphs:
        raise ParseError("文本内容为空")
    toc = [
        {"level": 1, "title": p[:60], "para": i}
        for i, p in enumerate(paragraphs)
        if len(p) <= 60 and CHAPTER_RE.match(p)
    ]
    (out / "content.json").write_text(
        json.dumps({"encoding": used, "paragraphs": paragraphs}, ensure_ascii=False), encoding="utf-8"
    )
    return {
        "title": None,
        "author": None,
        "page_count": None,
        "has_text_layer": True,
        "has_cover": False,
        "meta": {
            "encoding": used,
            "paragraphs": len(paragraphs),
            "chars": sum(len(p) for p in paragraphs),
            "toc": toc[:3000],
        },
    }


def main(argv: list[str]) -> dict:
    fmt, src, out = argv[0], Path(argv[1]), Path(argv[2])
    encoding = argv[3] if len(argv) > 3 and argv[3] else None
    max_uncompressed = int(argv[4]) if len(argv) > 4 else 500 * 1024 * 1024
    max_files = int(argv[5]) if len(argv) > 5 else 5000
    try:
        if fmt == "pdf":
            result = parse_pdf(src, out)
        elif fmt == "epub":
            result = parse_epub(src, out, max_uncompressed, max_files)
        elif fmt == "txt":
            result = parse_txt(src, out, encoding)
        else:
            raise ParseError("不支持的格式")
        return {"ok": True, **result}
    except ParseError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析失败：{type(e).__name__}"}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(main(sys.argv[1:]), ensure_ascii=False))
