"""数据库表模型。个人阅读记录（进度、标注、笔记、书签）都属于阅读者本人。"""

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, Column, DateTime, Index, UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(UTC)


def _ts(**kw: Any) -> Any:
    return Field(default_factory=utcnow, sa_column=Column(DateTime(timezone=True), nullable=False, **kw))


class BookFormat(StrEnum):
    pdf = "pdf"
    epub = "epub"
    txt = "txt"


class BookStatus(StrEnum):
    processing = "processing"
    ready = "ready"
    failed = "failed"


class Visibility(StrEnum):
    private = "private"
    public = "public"


class ReadStatus(StrEnum):
    unread = "unread"
    reading = "reading"
    finished = "finished"


class User(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    email: str = Field(unique=True, index=True, max_length=255)
    full_name: str | None = Field(default=None, max_length=255)
    hashed_password: str
    is_admin: bool = False
    is_active: bool = True
    must_change_password: bool = False
    # 修改密码或停用账号时递增，使旧令牌失效
    token_version: int = 0
    preferences: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    created_at: datetime = _ts()


class Book(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    title: str = Field(max_length=500)
    author: str | None = Field(default=None, max_length=500)
    format: BookFormat
    file_hash: str = Field(index=True, max_length=64)
    file_size: int
    original_filename: str = Field(max_length=500)
    visibility: Visibility = Visibility.private
    status: BookStatus = BookStatus.processing
    error: str | None = None
    page_count: int | None = None
    has_text_layer: bool | None = None
    has_cover: bool = False
    # 解析得到的附加信息：目录、TXT 编码与段落数等
    meta: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    is_deleted: bool = False
    deleted_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    created_at: datetime = _ts()
    updated_at: datetime = _ts(onupdate=utcnow)


class BookshelfEntry(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    book_id: uuid.UUID = Field(foreign_key="book.id", index=True)
    read_status: ReadStatus = ReadStatus.unread
    on_shelf: bool = True
    added_at: datetime = _ts()
    last_read_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))


class ReadingProgress(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    book_id: uuid.UUID = Field(foreign_key="book.id", index=True)
    locator: dict = Field(sa_column=Column(JSON, nullable=False))
    percent: float = 0.0
    revision: int = 1
    device: str | None = Field(default=None, max_length=100)
    updated_at: datetime = _ts(onupdate=utcnow)


class Annotation(SQLModel, table=True):
    __table_args__ = (Index("ix_annotation_owner_book", "owner_id", "book_id"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(foreign_key="user.id")
    book_id: uuid.UUID = Field(foreign_key="book.id")
    locator: dict = Field(sa_column=Column(JSON, nullable=False))
    quote: str = ""
    color: str = Field(default="yellow", max_length=20)
    # 跨页 PDF 选区拆成同组的多条页内标注
    group_id: uuid.UUID | None = None
    created_at: datetime = _ts()
    updated_at: datetime = _ts(onupdate=utcnow)


class Note(SQLModel, table=True):
    __table_args__ = (Index("ix_note_owner_book", "owner_id", "book_id"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(foreign_key="user.id")
    book_id: uuid.UUID = Field(foreign_key="book.id")
    annotation_id: uuid.UUID | None = Field(default=None, foreign_key="annotation.id", ondelete="SET NULL")
    # 位置与引用原文的快照：删除标注或原书后仍保留
    locator: dict | None = Field(default=None, sa_column=Column(JSON))
    quote: str | None = None
    body: str = ""
    revision: int = 1
    created_at: datetime = _ts()
    updated_at: datetime = _ts(onupdate=utcnow)


class Bookmark(SQLModel, table=True):
    __table_args__ = (Index("ix_bookmark_owner_book", "owner_id", "book_id"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(foreign_key="user.id")
    book_id: uuid.UUID = Field(foreign_key="book.id")
    locator: dict = Field(sa_column=Column(JSON, nullable=False))
    # 展示用的位置文字，如“第 10 页”“第三章 · 42%”
    position_label: str = Field(default="", max_length=200)
    sort_key: float = 0.0
    name: str = Field(default="", max_length=200)
    memo: str = ""
    created_at: datetime = _ts()
