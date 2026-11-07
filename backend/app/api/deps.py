"""公共依赖：数据库会话、当前用户与书籍访问权限。"""

import uuid
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session

from app.core.config import settings
from app.core.db import get_session
from app.core.security import decode_access_token
from app.models import Book, BookStatus, User, Visibility

oauth2 = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/login/access-token")

SessionDep = Annotated[Session, Depends(get_session)]
TokenDep = Annotated[str, Depends(oauth2)]

CREDENTIALS_ERROR = HTTPException(
    status.HTTP_401_UNAUTHORIZED, "登录已失效，请重新登录", headers={"WWW-Authenticate": "Bearer"}
)


def get_current_user_any(session: SessionDep, token: TokenDep) -> User:
    """已登录且启用的用户；允许处于“需修改密码”状态。"""
    try:
        payload = decode_access_token(token)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise CREDENTIALS_ERROR from None
    user = session.get(User, user_id)
    if user is None or not user.is_active or payload.get("ver") != user.token_version:
        raise CREDENTIALS_ERROR
    return user


def get_current_user(user: Annotated[User, Depends(get_current_user_any)]) -> User:
    """普通业务接口：首次登录必须先修改临时密码。"""
    if user.must_change_password:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "请先修改临时密码")
    return user


CurrentUserAny = Annotated[User, Depends(get_current_user_any)]
CurrentUser = Annotated[User, Depends(get_current_user)]


# ---------- 书籍权限 ----------


def can_read(user: User, book: Book) -> bool:
    """书籍内容读取权限：未删除，且是上传者或已公开（公开仅面向已登录成员）。"""
    if book.is_deleted:
        return False
    return book.owner_id == user.id or book.visibility == Visibility.public


def unavailable_reason(user: User, book: Book) -> str | None:
    if book.is_deleted:
        return "deleted"
    if book.owner_id != user.id and book.visibility != Visibility.public:
        return "private"
    if book.status != BookStatus.ready:
        return book.status.value
    return None


def get_book(session: Session, book_id: uuid.UUID) -> Book:
    book = session.get(Book, book_id)
    if book is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "书籍不存在")
    return book


def get_readable_book(session: Session, user: User, book_id: uuid.UUID, *, require_ready: bool = True) -> Book:
    book = get_book(session, book_id)
    # 无权访问时与不存在返回相同结果，避免通过 ID 探测私有书籍
    if not can_read(user, book):
        if book.is_deleted and book.owner_id == user.id:
            raise HTTPException(status.HTTP_410_GONE, "原书已删除")
        raise HTTPException(status.HTTP_404_NOT_FOUND, "书籍不存在或暂不可访问")
    if require_ready and book.status != BookStatus.ready:
        raise HTTPException(status.HTTP_409_CONFLICT, "书籍尚未解析完成")
    return book


def get_owned_book(session: Session, user: User, book_id: uuid.UUID) -> Book:
    book = get_book(session, book_id)
    if book.owner_id != user.id:
        if can_read(user, book):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "只有上传者可以管理这本书")
        raise HTTPException(status.HTTP_404_NOT_FOUND, "书籍不存在或暂不可访问")
    if book.is_deleted:
        raise HTTPException(status.HTTP_410_GONE, "原书已删除")
    return book


def like_pattern(q: str) -> str:
    """把用户输入转成 LIKE 子串模式并转义通配符，配合 ilike(..., escape="\\\\") 使用。"""
    escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
