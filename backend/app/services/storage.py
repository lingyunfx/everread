"""书籍文件的私有存储布局：DATA_DIR/books/<book_id>/ 下保存原文件与解析产物。"""

import shutil
import uuid
from pathlib import Path

from app.core.config import settings
from app.models import Book, BookFormat


def books_root() -> Path:
    return settings.DATA_DIR / "books"


def tmp_root() -> Path:
    p = settings.DATA_DIR / "tmp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def book_dir(book_id: uuid.UUID) -> Path:
    return books_root() / str(book_id)


def original_path(book: Book) -> Path:
    return book_dir(book.id) / f"original.{book.format.value}"


def reading_file_path(book: Book) -> Path:
    """阅读器实际获取的文件：EPUB 使用清理过脚本的副本。"""
    if book.format == BookFormat.epub:
        sanitized = book_dir(book.id) / "sanitized.epub"
        if sanitized.exists():
            return sanitized
    return original_path(book)


def cover_path(book_id: uuid.UUID) -> Path:
    return book_dir(book_id) / "cover.jpg"


def txt_content_path(book_id: uuid.UUID) -> Path:
    return book_dir(book_id) / "content.json"


def remove_book_files(book_id: uuid.UUID) -> None:
    shutil.rmtree(book_dir(book_id), ignore_errors=True)


def remove_derived_files(book_id: uuid.UUID) -> None:
    """重新解析前删除派生产物，保留原文件。"""
    d = book_dir(book_id)
    for name in ("sanitized.epub", "cover.jpg", "content.json"):
        (d / name).unlink(missing_ok=True)
