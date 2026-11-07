"""按部署配置初始化首个管理员账号（数据库中不存在时才创建）。"""

import logging

from sqlmodel import Session, select

from app.core.config import settings
from app.core.db import engine
from app.core.security import hash_password
from app.models import User

log = logging.getLogger(__name__)


def ensure_first_superuser() -> None:
    if not settings.FIRST_SUPERUSER or not settings.FIRST_SUPERUSER_PASSWORD:
        return
    email = settings.FIRST_SUPERUSER.strip().lower()
    with Session(engine) as session:
        if session.exec(select(User).where(User.email == email)).first():
            return
        session.add(User(email=email, hashed_password=hash_password(settings.FIRST_SUPERUSER_PASSWORD), is_admin=True))
        session.commit()
        log.info("已创建首个管理员账号 %s", email)
