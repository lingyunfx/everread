"""书籍上传、管理与受鉴权的文件读取。"""

import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from sqlmodel import col, delete, select

from app.api.convert import book_detail, book_public
from app.api.deps import CurrentUser, SessionDep, can_read, get_book, get_owned_book, get_readable_book
from app.models import (
    Annotation,
    Book,
    BookFormat,
    Bookmark,
    BookshelfEntry,
    BookStatus,
    Note,
    ReadingProgress,
)
from app.schemas import BookDetail, BookPublic, BookUpdate, DeleteImpact, DuplicateError, Message, RetryRequest
from app.services import importer, storage

router = APIRouter(prefix="/books", tags=["books"])

# 阅读器按二进制读取文件，不依赖 Content-Type。不使用 application/pdf、application/epub+zip
# 等常见类型，避免 IDM 之类的下载工具按类型拦截阅读器的请求并弹出下载提示。
READER_MEDIA_TYPE = "application/x-everread-book"


@router.post(
    "",
    response_model=BookPublic,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": DuplicateError}},
)
async def upload_book(file: UploadFile, user: CurrentUser, session: SessionDep, background: BackgroundTasks):
    filename = Path(file.filename or "未命名").name
    tmp, digest, size = await importer.save_upload(file)
    try:
        fmt = importer.detect_format(filename, tmp)
        existing = session.exec(
            select(Book).where(Book.owner_id == user.id, Book.file_hash == digest, Book.is_deleted == False)  # noqa: E712
        ).first()
        if existing is not None:
            tmp.unlink(missing_ok=True)
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"detail": f"你已上传过这本书：《{existing.title}》", "book_id": str(existing.id)},
            )
        book = Book(
            owner_id=user.id,
            title=Path(filename).stem[:500] or "未命名",
            format=fmt,
            file_hash=digest,
            file_size=size,
            original_filename=filename[:500],
            meta={"title_from": "filename"},
        )
        importer.place_original(tmp, book)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    session.add(book)
    session.add(BookshelfEntry(user_id=user.id, book_id=book.id))
    session.commit()
    session.refresh(book)
    background.add_task(importer.run_parse, book.id)
    return book_public(book, user)


@router.get("/mine", response_model=list[BookPublic])
def my_uploads(user: CurrentUser, session: SessionDep) -> list[BookPublic]:
    books = session.exec(
        select(Book).where(Book.owner_id == user.id, Book.is_deleted == False).order_by(col(Book.created_at).desc())  # noqa: E712
    ).all()
    return [book_public(b, user) for b in books]


@router.get("/{book_id}", response_model=BookDetail)
def read_book(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> BookDetail:
    book = get_book(session, book_id)
    # 不可访问时，只有书架里出现过它的人才能看到基本信息
    if not can_read(user, book) and book.owner_id != user.id:
        has_entry = session.exec(
            select(BookshelfEntry).where(BookshelfEntry.user_id == user.id, BookshelfEntry.book_id == book.id)
        ).first()
        if has_entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "书籍不存在或暂不可访问")
    return book_detail(book, user)


@router.patch("/{book_id}", response_model=BookPublic)
def update_book(book_id: uuid.UUID, body: BookUpdate, user: CurrentUser, session: SessionDep) -> BookPublic:
    book = get_owned_book(session, user, book_id)
    data = body.model_dump(exclude_unset=True)
    if "title" in data:
        book.title = data["title"].strip() or book.title
        book.meta = {**book.meta, "title_from": "user"}
    if "author" in data:
        book.author = (data["author"] or "").strip() or None
    if data.get("visibility"):
        if book.status != BookStatus.ready:
            raise HTTPException(status.HTTP_409_CONFLICT, "书籍解析完成后才能设为公开")
        book.visibility = data["visibility"]
    session.add(book)
    session.commit()
    session.refresh(book)
    return book_public(book, user)


@router.post("/{book_id}/retry", response_model=BookPublic)
def retry_parse(
    book_id: uuid.UUID, body: RetryRequest, user: CurrentUser, session: SessionDep, background: BackgroundTasks
) -> BookPublic:
    book = get_owned_book(session, user, book_id)
    if book.status == BookStatus.processing:
        raise HTTPException(status.HTTP_409_CONFLICT, "正在解析中")
    if body.encoding and book.format != BookFormat.txt:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只有 TXT 可以指定编码")
    if book.status == BookStatus.ready and not body.encoding:
        raise HTTPException(status.HTTP_409_CONFLICT, "书籍已解析完成")
    storage.remove_derived_files(book.id)
    book.status = BookStatus.processing
    book.error = None
    session.add(book)
    session.commit()
    session.refresh(book)
    background.add_task(importer.run_parse, book.id, body.encoding)
    return book_public(book, user)


@router.get("/{book_id}/delete-impact", response_model=DeleteImpact)
def delete_impact(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> DeleteImpact:
    book = get_owned_book(session, user, book_id)
    readers: set[uuid.UUID] = set()
    for model, field in (
        (BookshelfEntry, BookshelfEntry.user_id),
        (ReadingProgress, ReadingProgress.user_id),
        (Annotation, Annotation.owner_id),
        (Note, Note.owner_id),
        (Bookmark, Bookmark.owner_id),
    ):
        readers.update(session.exec(select(field).where(model.book_id == book.id).distinct()).all())
    readers.discard(user.id)
    return DeleteImpact(other_readers=len(readers))


@router.delete("/{book_id}", response_model=Message)
def delete_book(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    """删除原书：标记删除并清理文件；保留每位读者的个人记录（不可再跳转原文）。"""
    book = get_owned_book(session, user, book_id)
    book.is_deleted = True
    book.deleted_at = datetime.now(UTC)
    book.has_cover = False
    session.add(book)
    own_entry = session.exec(
        select(BookshelfEntry).where(BookshelfEntry.user_id == user.id, BookshelfEntry.book_id == book.id)
    ).first()
    if own_entry is not None:
        own_entry.on_shelf = False
        session.add(own_entry)
    session.commit()
    storage.remove_book_files(book.id)
    return Message(message="原书已删除")


@router.delete("/{book_id}/my-records", response_model=Message)
def delete_my_records(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    """删除自己在这本书上的全部个人记录（进度、笔记、标注、书签与书架条目）。"""
    get_book(session, book_id)
    session.exec(delete(Note).where(Note.owner_id == user.id, Note.book_id == book_id))
    session.exec(delete(Annotation).where(Annotation.owner_id == user.id, Annotation.book_id == book_id))
    session.exec(delete(Bookmark).where(Bookmark.owner_id == user.id, Bookmark.book_id == book_id))
    session.exec(delete(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book_id))
    session.exec(delete(BookshelfEntry).where(BookshelfEntry.user_id == user.id, BookshelfEntry.book_id == book_id))
    session.commit()
    return Message(message="已清除个人记录")


@router.get("/{book_id}/file")
def book_file(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> FileResponse:
    """受鉴权的文件读取，支持 Range 分段请求；每次请求都检查权限。"""
    book = get_readable_book(session, user, book_id)
    path = storage.reading_file_path(book)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在")
    if book.format == BookFormat.txt:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "TXT 请使用 /txt 接口读取")
    return FileResponse(
        path,
        media_type=READER_MEDIA_TYPE,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{book_id}/txt")
def book_txt(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> FileResponse:
    """TXT 规范化后的段落 JSON：{encoding, paragraphs: [...]}，段落下标即稳定段落 ID。"""
    book = get_readable_book(session, user, book_id)
    if book.format != BookFormat.txt:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不是 TXT 书籍")
    path = storage.txt_content_path(book.id)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "内容不存在")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "private, no-store"})


@router.get("/{book_id}/cover")
def book_cover(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> FileResponse:
    book = get_readable_book(session, user, book_id, require_ready=False)
    path = storage.cover_path(book.id)
    if not book.has_cover or not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有封面")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
