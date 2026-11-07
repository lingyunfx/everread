"""登录、当前用户、修改密码与阅读偏好。不提供公开注册接口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import select

from app.api.convert import user_public
from app.api.deps import CurrentUserAny, SessionDep
from app.core.config import settings
from app.core.ratelimit import RateLimiter
from app.core.security import create_access_token, hash_password, verify_password
from app.models import User
from app.schemas import Message, PasswordChange, Preferences, PreferencesUpdate, Token, UserPublic

router = APIRouter(tags=["auth"])
login_limiter = RateLimiter(settings.LOGIN_RATE_LIMIT_PER_MINUTE)

# 用户不存在时也做一次哈希校验，避免通过响应时间判断账号是否存在
_DUMMY_HASH = hash_password("dummy-password-for-timing")


@router.post("/login/access-token", response_model=Token)
def login(request: Request, session: SessionDep, form: Annotated[OAuth2PasswordRequestForm, Depends()]) -> Token:
    client = request.client.host if request.client else "unknown"
    if not login_limiter.allow(client):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "登录尝试过于频繁，请稍后再试")
    user = session.exec(select(User).where(User.email == form.username.strip().lower())).first()
    if user is None:
        verify_password(form.password, _DUMMY_HASH)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱或密码错误")
    if not verify_password(form.password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱或密码错误")
    if not user.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "账号已停用")
    return Token(access_token=create_access_token(user.id, user.token_version))


@router.get("/users/me", response_model=UserPublic)
def read_me(user: CurrentUserAny) -> UserPublic:
    return user_public(user)


@router.post("/users/me/password", response_model=Token)
def change_password(body: PasswordChange, user: CurrentUserAny, session: SessionDep) -> Token:
    if not verify_password(body.current_password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "当前密码不正确")
    if body.current_password == body.new_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "新密码不能与当前密码相同")
    user.hashed_password = hash_password(body.new_password)
    user.must_change_password = False
    # 使其他设备上的旧令牌失效，并给当前设备签发新令牌
    user.token_version += 1
    session.add(user)
    session.commit()
    return Token(access_token=create_access_token(user.id, user.token_version))


@router.patch("/users/me/preferences", response_model=UserPublic)
def update_preferences(body: PreferencesUpdate, user: CurrentUserAny, session: SessionDep) -> UserPublic:
    current = Preferences(**(user.preferences or {}))
    merged = current.model_copy(update=body.model_dump(exclude_none=True))
    user.preferences = merged.model_dump()
    session.add(user)
    session.commit()
    session.refresh(user)
    return user_public(user)


@router.post("/logout", response_model=Message)
def logout(user: CurrentUserAny) -> Message:
    # 令牌无状态，前端清除即可；这里保留接口便于以后扩展
    return Message(message="已退出")
