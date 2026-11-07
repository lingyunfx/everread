"""API 请求与响应结构。"""

import json
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.models import BookFormat, BookStatus, ReadStatus, Visibility

Theme = Literal["light", "dark", "sepia"]


def _check_locator(v: dict | None) -> dict | None:
    """位置对象按格式区分字段，这里只做类型与体积的基本约束。"""
    if v is None:
        return v
    if v.get("type") not in ("pdf", "epub", "txt"):
        raise ValueError("locator.type 必须是 pdf / epub / txt")
    if len(json.dumps(v)) > 20000:
        raise ValueError("locator 过大")
    return v


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class Message(BaseModel):
    message: str


# ---------- 用户 ----------


class Preferences(BaseModel):
    theme: Theme = "light"
    font_size: int = Field(default=18, ge=12, le=36)
    line_height: float = Field(default=1.8, ge=1.2, le=2.6)
    # PDF 默认保留原稿颜色；可选暖色覆盖或暗色反相
    pdf_filter: Literal["none", "sepia", "dark"] = "none"
    pdf_zoom: float = Field(default=1.0, ge=0.5, le=3.0)
    # 翻页布局：双页（宽屏默认）或单页；窗口过窄时前端自动按单页显示
    page_layout: Literal["double", "single"] = "double"


class PreferencesUpdate(BaseModel):
    theme: Theme | None = None
    font_size: int | None = Field(default=None, ge=12, le=36)
    line_height: float | None = Field(default=None, ge=1.2, le=2.6)
    pdf_filter: Literal["none", "sepia", "dark"] | None = None
    pdf_zoom: float | None = Field(default=None, ge=0.5, le=3.0)
    page_layout: Literal["double", "single"] | None = None


class UserPublic(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str | None
    is_admin: bool
    must_change_password: bool
    preferences: Preferences


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


# ---------- 书籍 ----------


class BookPublic(BaseModel):
    id: uuid.UUID
    title: str
    author: str | None
    format: BookFormat
    file_size: int
    original_filename: str
    visibility: Visibility
    status: BookStatus
    error: str | None
    page_count: int | None
    has_text_layer: bool | None
    has_cover: bool
    is_owner: bool
    is_deleted: bool
    created_at: datetime


class BookDetail(BookPublic):
    meta: dict[str, Any]
    accessible: bool


class BookUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    author: str | None = Field(default=None, max_length=500)
    visibility: Visibility | None = None


class RetryRequest(BaseModel):
    # TXT 编码识别错误时可手动指定，如 gb18030、big5、utf-16
    encoding: str | None = Field(default=None, max_length=30)


class DeleteImpact(BaseModel):
    other_readers: int


class DuplicateError(BaseModel):
    detail: str
    book_id: uuid.UUID


# ---------- 书架 / 图书馆 ----------


class ShelfItem(BaseModel):
    book: BookPublic
    read_status: ReadStatus
    on_shelf: bool
    added_at: datetime
    last_read_at: datetime | None
    percent: float | None
    accessible: bool
    # 不可访问原因：deleted / private / failed / processing
    unavailable_reason: str | None


class ShelfUpdate(BaseModel):
    read_status: ReadStatus


class LibraryItem(BaseModel):
    book: BookPublic
    on_my_shelf: bool


# ---------- 进度 ----------


class ProgressPublic(BaseModel):
    locator: dict
    percent: float
    revision: int
    device: str | None
    updated_at: datetime


class ProgressUpdate(BaseModel):
    locator: dict
    percent: float = Field(ge=0, le=100)
    # 客户端基于的版本；为 None 表示首次保存
    base_revision: int | None = None
    # 用户在冲突提示中选择“以本机为准”时强制覆盖
    force: bool = False
    device: str | None = Field(default=None, max_length=100)

    _v = field_validator("locator")(_check_locator)


class ProgressConflict(BaseModel):
    detail: str
    current: ProgressPublic


# ---------- 标注 / 笔记 / 书签 ----------


class AnnotationCreate(BaseModel):
    # 客户端生成 ID，重试时不会重复创建
    id: uuid.UUID | None = None
    locator: dict
    quote: str = Field(default="", max_length=10000)
    color: str = Field(default="yellow", max_length=20)
    group_id: uuid.UUID | None = None

    _v = field_validator("locator")(_check_locator)


class AnnotationUpdate(BaseModel):
    color: str = Field(max_length=20)


class AnnotationPublic(BaseModel):
    id: uuid.UUID
    book_id: uuid.UUID
    locator: dict
    quote: str
    color: str
    group_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class NoteCreate(BaseModel):
    id: uuid.UUID | None = None
    annotation_id: uuid.UUID | None = None
    locator: dict | None = None
    quote: str | None = Field(default=None, max_length=10000)
    body: str = Field(default="", max_length=100000)

    _v = field_validator("locator")(_check_locator)


class NoteUpdate(BaseModel):
    body: str = Field(max_length=100000)
    base_revision: int | None = None


class NotePublic(BaseModel):
    id: uuid.UUID
    book_id: uuid.UUID
    annotation_id: uuid.UUID | None
    locator: dict | None
    quote: str | None
    body: str
    revision: int
    created_at: datetime
    updated_at: datetime


class BookmarkCreate(BaseModel):
    id: uuid.UUID | None = None
    locator: dict
    position_label: str = Field(default="", max_length=200)
    sort_key: float = 0.0
    name: str = Field(default="", max_length=200)
    memo: str = Field(default="", max_length=5000)

    _v = field_validator("locator")(_check_locator)


class BookmarkUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    memo: str | None = Field(default=None, max_length=5000)


class BookmarkPublic(BaseModel):
    id: uuid.UUID
    book_id: uuid.UUID
    locator: dict
    position_label: str
    sort_key: float
    name: str
    memo: str
    created_at: datetime


class RecordHit(BaseModel):
    kind: Literal["note", "annotation"]
    id: uuid.UUID
    snippet: str
    quote: str | None
    locator: dict | None
    updated_at: datetime


class RecordSearchResult(BaseModel):
    total: int
    items: list[RecordHit]
