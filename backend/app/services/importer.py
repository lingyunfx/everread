"""导入流程：上传到临时文件 → 校验 → 建立 processing 记录 → 子进程解析 → ready / failed。"""

import asyncio
import hashlib
import json
import logging
import shutil
import subprocess
import sys
import uuid
import zipfile
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from sqlmodel import Session, select

from app.core.config import settings
from app.core.db import engine
from app.models import Book, BookFormat, BookStatus
from app.services import storage

log = logging.getLogger(__name__)

ALLOWED_EXT = {".pdf": BookFormat.pdf, ".epub": BookFormat.epub, ".txt": BookFormat.txt}
CHUNK = 1024 * 1024

_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(settings.PARSE_CONCURRENCY)
    return _semaphore


async def save_upload(file: UploadFile) -> tuple[Path, str, int]:
    """把上传流写入临时文件，同时计算 sha256 并检查大小上限。"""
    tmp = storage.tmp_root() / f"{uuid.uuid4()}.upload"
    digest = hashlib.sha256()
    size = 0
    try:
        with tmp.open("wb") as fh:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"文件超过 {settings.MAX_UPLOAD_MB} MB 上限")
                digest.update(chunk)
                fh.write(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return tmp, digest.hexdigest(), size


def detect_format(filename: str, path: Path) -> BookFormat:
    """同时检查扩展名和文件实际内容，不单靠文件名判断。"""
    ext = Path(filename).suffix.lower()
    fmt = ALLOWED_EXT.get(ext)
    if fmt is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "仅支持 PDF、EPUB、TXT 格式")
    with path.open("rb") as fh:
        head = fh.read(4096)
    if not head:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件为空")
    if fmt == BookFormat.pdf and b"%PDF-" not in head[:1024]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件内容不是有效的 PDF")
    if fmt == BookFormat.epub:
        if not zipfile.is_zipfile(path):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件内容不是有效的 EPUB")
        with zipfile.ZipFile(path) as zf:
            try:
                mimetype = zf.read("mimetype").strip()
            except KeyError:
                mimetype = b""
        if mimetype != b"application/epub+zip":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件内容不是有效的 EPUB")
    if fmt == BookFormat.txt and head.startswith((b"%PDF-", b"PK\x03\x04")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件内容不是纯文本")
    return fmt


async def run_parse(book_id: uuid.UUID, encoding: str | None = None) -> None:
    """在受限并发的子进程中解析书籍，并把结果写回数据库。"""
    async with _get_semaphore():
        with Session(engine) as session:
            book = session.get(Book, book_id)
            if book is None or book.is_deleted:
                return
            src = storage.original_path(book)
            fmt = book.format.value
        out = storage.book_dir(book_id)
        args = [
            sys.executable,
            "-m",
            "app.services.parse_worker",
            fmt,
            str(src),
            str(out),
            encoding or "",
            str(settings.EPUB_MAX_UNCOMPRESSED_MB * 1024 * 1024),
            str(settings.EPUB_MAX_FILES),
        ]
        result: dict
        try:
            # subprocess.run 超时会强制结束子进程；放到线程里执行，兼容各平台的事件循环
            proc = await asyncio.to_thread(
                subprocess.run,
                args,
                capture_output=True,
                timeout=settings.PARSE_TIMEOUT_SECONDS,
                cwd=str(Path(__file__).resolve().parents[2]),
            )
            try:
                result = json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
            except (ValueError, IndexError):
                log.error("解析进程输出异常: %s", proc.stderr.decode("utf-8", "replace")[-2000:])
                result = {"ok": False, "error": "解析进程异常退出"}
        except subprocess.TimeoutExpired:
            result = {"ok": False, "error": "解析超时，文件可能过大或结构异常"}
        except Exception:
            log.exception("启动解析进程失败")
            result = {"ok": False, "error": "解析进程启动失败"}

        with Session(engine) as session:
            book = session.get(Book, book_id)
            if book is None or book.is_deleted:
                return
            if result.get("ok"):
                book.status = BookStatus.ready
                book.error = None
                # 用户已经手动改过的书名/作者不被元数据覆盖
                if result.get("title") and book.meta.get("title_from") == "filename":
                    book.title = result["title"][:500]
                    book.meta = {**book.meta, "title_from": "metadata"}
                if result.get("author") and not book.author:
                    book.author = result["author"][:500]
                book.page_count = result.get("page_count")
                book.has_text_layer = result.get("has_text_layer")
                book.has_cover = bool(result.get("has_cover"))
                book.meta = {**book.meta, **result.get("meta", {})}
            else:
                book.status = BookStatus.failed
                book.error = result.get("error") or "解析失败"
            session.add(book)
            session.commit()


def place_original(tmp: Path, book: Book) -> None:
    dest = storage.original_path(book)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(tmp), dest)


def mark_interrupted_jobs() -> None:
    """服务重启时，把中断的解析任务标为失败（可重试），并清理残留临时文件。"""
    with Session(engine) as session:
        for book in session.exec(select(Book).where(Book.status == BookStatus.processing)):
            book.status = BookStatus.failed
            book.error = "解析被中断，可点击重试"
            session.add(book)
        session.commit()
    shutil.rmtree(storage.tmp_root(), ignore_errors=True)
