"""个人书架与图书馆。"""

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from sqlmodel import Session, col, select

from app.api.convert import book_public
from app.api.deps import CurrentUser, SessionDep, get_book, get_readable_book, like_pattern, unavailable_reason
from app.models import Book, BookshelfEntry, BookStatus, ReadingProgress, ReadStatus, User, Visibility
from app.schemas import LibraryItem, Message, ShelfItem, ShelfUpdate

router = APIRouter(tags=["shelf"])


def _entry(session: Session, user: User, book_id: uuid.UUID) -> BookshelfEntry | None:
    return session.exec(
        select(BookshelfEntry).where(BookshelfEntry.user_id == user.id, BookshelfEntry.book_id == book_id)
    ).first()


def _shelf_item(entry: BookshelfEntry, book: Book, user: User, percent: float | None) -> ShelfItem:
    reason = unavailable_reason(user, book)
    return ShelfItem(
        book=book_public(book, user),
        read_status=entry.read_status,
        on_shelf=entry.on_shelf,
        added_at=entry.added_at,
        last_read_at=entry.last_read_at,
        percent=percent,
        accessible=reason is None,
        unavailable_reason=reason,
    )


@router.get("/shelf", response_model=list[ShelfItem])
def list_shelf(
    user: CurrentUser,
    session: SessionDep,
    read_status: ReadStatus | None = None,
    q: str | None = None,
    sort: Literal["recent", "added", "title"] = "recent",
    removed: bool = False,
) -> list[ShelfItem]:
    stmt = (
        select(BookshelfEntry, Book, ReadingProgress.percent)
        .join(Book, col(Book.id) == BookshelfEntry.book_id)
        .outerjoin(
            ReadingProgress,
            (col(ReadingProgress.book_id) == BookshelfEntry.book_id) & (col(ReadingProgress.user_id) == user.id),
        )
        .where(BookshelfEntry.user_id == user.id, BookshelfEntry.on_shelf == (not removed))
        # 解析失败的书只在“我上传的书”中处理，不放进可阅读的书架
        .where(Book.status != BookStatus.failed)
    )
    if read_status:
        stmt = stmt.where(BookshelfEntry.read_status == read_status)
    if q and q.strip():
        stmt = stmt.where(col(Book.title).ilike(like_pattern(q), escape="\\"))
    if sort == "title":
        stmt = stmt.order_by(col(Book.title))
    elif sort == "added":
        stmt = stmt.order_by(col(BookshelfEntry.added_at).desc())
    else:
        stmt = stmt.order_by(col(BookshelfEntry.last_read_at).desc().nulls_last(), col(BookshelfEntry.added_at).desc())
    return [_shelf_item(e, b, user, p) for e, b, p in session.exec(stmt).all()]


@router.post("/shelf/{book_id}", response_model=ShelfItem)
def add_to_shelf(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> ShelfItem:
    """加入书架；对曾经移出的条目则恢复，原有阅读状态与记录保留。"""
    book = get_readable_book(session, user, book_id, require_ready=False)
    entry = _entry(session, user, book.id)
    if entry is None:
        entry = BookshelfEntry(user_id=user.id, book_id=book.id)
    entry.on_shelf = True
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return _shelf_item(entry, book, user, None)


@router.delete("/shelf/{book_id}", response_model=Message)
def remove_from_shelf(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    """只移出自己的书架，不删除原书和个人阅读数据。"""
    entry = _entry(session, user, book_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "书架中没有这本书")
    entry.on_shelf = False
    session.add(entry)
    session.commit()
    return Message(message="已移出书架")


@router.patch("/shelf/{book_id}", response_model=ShelfItem)
def update_shelf(book_id: uuid.UUID, body: ShelfUpdate, user: CurrentUser, session: SessionDep) -> ShelfItem:
    entry = _entry(session, user, book_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "书架中没有这本书")
    entry.read_status = body.read_status
    session.add(entry)
    session.commit()
    session.refresh(entry)
    book = get_book(session, book_id)
    return _shelf_item(entry, book, user, None)


@router.post("/shelf/{book_id}/open", response_model=ShelfItem)
def open_book(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> ShelfItem:
    """打开书籍：自动建立/恢复书架条目，记录最近阅读时间。已读状态只能手动设置。"""
    book = get_readable_book(session, user, book_id)
    entry = _entry(session, user, book.id) or BookshelfEntry(user_id=user.id, book_id=book.id)
    entry.on_shelf = True
    entry.last_read_at = datetime.now(UTC)
    if entry.read_status == ReadStatus.unread:
        entry.read_status = ReadStatus.reading
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return _shelf_item(entry, book, user, None)


@router.get("/library", response_model=list[LibraryItem])
def list_library(user: CurrentUser, session: SessionDep, q: str | None = None) -> list[LibraryItem]:
    """图书馆：所有成员公开且已就绪的书。只按书名/作者筛选，不做跨书正文搜索。"""
    stmt = select(Book).where(
        Book.visibility == Visibility.public,
        Book.status == BookStatus.ready,
        Book.is_deleted == False,  # noqa: E712
    )
    if q and q.strip():
        like = like_pattern(q)
        stmt = stmt.where(col(Book.title).ilike(like, escape="\\") | col(Book.author).ilike(like, escape="\\"))
    books = session.exec(stmt.order_by(col(Book.created_at).desc())).all()
    on_shelf = set(
        session.exec(
            select(BookshelfEntry.book_id).where(BookshelfEntry.user_id == user.id, BookshelfEntry.on_shelf == True)  # noqa: E712
        ).all()
    )
    return [LibraryItem(book=book_public(b, user), on_my_shelf=b.id in on_shelf) for b in books]
