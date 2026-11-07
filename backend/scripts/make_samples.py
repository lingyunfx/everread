"""生成测试样本书籍（内容为自行编写的文字，无版权问题）。

用法：uv run python scripts/make_samples.py <输出目录>
生成：文本 PDF（120 页）、扫描 PDF（无文字层）、中文 EPUB、UTF-8 TXT、GB18030 TXT、
带脚本的 EPUB（验证清理）、加密 PDF 与损坏文件（验证错误提示）。
"""

import io
import sys
import zipfile
from pathlib import Path

import pymupdf

PARAGRAPH = "永读是一个可以一直读书的地方。今天的天气很好，适合坐在窗边读一本书。"


def text_pdf(pages: int = 120) -> bytes:
    doc = pymupdf.open()
    for i in range(1, pages + 1):
        page = doc.new_page(width=420, height=595)
        page.insert_text((50, 70), f"第 {i} 页 示例章节", fontname="china-s", fontsize=16)
        y = 110
        for j in range(8):
            page.insert_text((50, y), f"{PARAGRAPH[:22]}（{i}-{j}）", fontname="china-s", fontsize=11)
            y += 22
        if i == 42:
            page.insert_text((50, y + 20), "这里藏着一个特别的词：琉璃灯盏", fontname="china-s", fontsize=11)
    doc.set_toc([[1, "开始", 1], [1, "中段", max(1, pages // 2)], [1, "结尾", pages]])
    doc.set_metadata({"title": "永读示例文本书", "author": "EverRead"})
    return doc.tobytes()


def scanned_pdf(pages: int = 6) -> bytes:
    """把文本页渲染成图片后再放回 PDF，模拟无文字层的扫描件。"""
    src = pymupdf.open(stream=text_pdf(pages), filetype="pdf")
    out = pymupdf.open()
    for p in src:
        pix = p.get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2))
        page = out.new_page(width=p.rect.width, height=p.rect.height)
        page.insert_image(page.rect, stream=pix.tobytes("jpeg", jpg_quality=70))
    return out.tobytes()


def encrypted_pdf() -> bytes:
    doc = pymupdf.open(stream=text_pdf(2), filetype="pdf")
    return doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="secret")


def _cover_png() -> bytes:
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 300, 420), False)
    pix.set_rect(pix.irect, (180, 140, 90))
    return pix.tobytes("png")


def epub(chapters: int = 5, with_script: bool = False, title: str = "永读示例 EPUB") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        items, refs, navs = [], [], []
        for i in range(1, chapters + 1):
            body = "".join(f"<p>第{i}章第{j}段：{PARAGRAPH}🌙</p>" for j in range(1, 31))
            if i == 3:
                body += "<p>这里藏着一个特别的词：琉璃灯盏</p>"
            script = "<script>window.parent.hacked = true;</script>" if with_script else ""
            evil = ' onload="alert(1)"' if with_script else ""
            img = '<img src="https://tracker.example.com/pixel.gif"/>' if with_script else ""
            z.writestr(
                f"OEBPS/ch{i}.xhtml",
                f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第{i}章</title>{script}</head>'
                f"<body{evil}><h1>第{i}章 示例</h1>{img}{body}</body></html>",
            )
            items.append(f'<item id="ch{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>')
            refs.append(f'<itemref idref="ch{i}"/>')
            navs.append(f'<li><a href="ch{i}.xhtml">第{i}章 示例</a></li>')
        z.writestr(
            "OEBPS/nav.xhtml",
            '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            f'<head><title>目录</title></head><body><nav epub:type="toc"><ol>{"".join(navs)}</ol></nav></body></html>',
        )
        z.writestr("OEBPS/cover.png", _cover_png())
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:identifier id="id">everread-sample</dc:identifier><dc:title>{title}</dc:title><dc:creator>EverRead</dc:creator><dc:language>zh</dc:language>'
            "</metadata><manifest>"
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
            f"{''.join(items)}</manifest><spine>{''.join(refs)}</spine></package>",
        )
    return buf.getvalue()


def txt_text(chapters: int = 10) -> str:
    lines = []
    for i in range(1, chapters + 1):
        lines.append(f"第{i}章 起风了")
        for j in range(1, 41):
            lines.append(f"　　这是第{i}章的第{j}段。{PARAGRAPH}😀")
        if i == 7:
            lines.append("　　这里藏着一个特别的词：琉璃灯盏")
        lines.append("")
    return "\r\n".join(lines)


def write_all(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "示例文本书.pdf").write_bytes(text_pdf())
    (out / "示例扫描件.pdf").write_bytes(scanned_pdf())
    (out / "示例中文.epub").write_bytes(epub())
    (out / "带脚本的书.epub").write_bytes(epub(2, with_script=True, title="带脚本的书"))
    (out / "示例UTF8.txt").write_text(txt_text(), encoding="utf-8")
    (out / "示例GB18030.txt").write_bytes(txt_text(4).encode("gb18030"))
    (out / "加密.pdf").write_bytes(encrypted_pdf())
    (out / "损坏.pdf").write_bytes(b"%PDF-1.4\n this is not really a pdf")


if __name__ == "__main__":
    write_all(Path(sys.argv[1] if len(sys.argv) > 1 else "../samples/generated"))
    print("样本已生成")
