"""数据库模型 → 响应结构。"""

from app.api.deps import can_read
from app.models import Book, User
from app.schemas import BookDetail, BookPublic, Preferences, UserPublic


def user_public(user: User) -> UserPublic:
    return UserPublic(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        is_admin=user.is_admin,
        must_change_password=user.must_change_password,
        preferences=Preferences(**(user.preferences or {})),
    )


def book_public(book: Book, user: User) -> BookPublic:
    return BookPublic(
        id=book.id,
        title=book.title,
        author=book.author,
        format=book.format,
        file_size=book.file_size,
        original_filename=book.original_filename,
        visibility=book.visibility,
        status=book.status,
        error=book.error,
        page_count=book.page_count,
        has_text_layer=book.has_text_layer,
        has_cover=book.has_cover and not book.is_deleted,
        is_owner=book.owner_id == user.id,
        is_deleted=book.is_deleted,
        created_at=book.created_at,
    )


def book_detail(book: Book, user: User) -> BookDetail:
    accessible = can_read(user, book)
    meta = {k: v for k, v in (book.meta or {}).items() if k != "title_from"} if accessible else {}
    return BookDetail(**book_public(book, user).model_dump(), meta=meta, accessible=accessible)
