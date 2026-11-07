"""管理员命令行：创建、停用、启用账号和重置临时密码。

用法（在 backend 目录或容器内）：
    python -m app.cli create-user friend@example.com --name 小明
    python -m app.cli create-user me@example.com --admin --password '自定义密码'
    python -m app.cli reset-password friend@example.com
    python -m app.cli disable-user friend@example.com
    python -m app.cli enable-user friend@example.com
    python -m app.cli list-users
"""

import argparse
import secrets
import sys

from sqlmodel import Session, select

from app.core.db import engine
from app.core.security import hash_password
from app.models import User


def _temp_password() -> str:
    return secrets.token_urlsafe(9)


def _find(session: Session, email: str) -> User:
    user = session.exec(select(User).where(User.email == email.strip().lower())).first()
    if user is None:
        sys.exit(f"账号不存在：{email}")
    return user


def create_user(args: argparse.Namespace) -> None:
    email = args.email.strip().lower()
    with Session(engine) as session:
        if session.exec(select(User).where(User.email == email)).first():
            sys.exit(f"账号已存在：{email}")
        password = args.password or _temp_password()
        session.add(
            User(
                email=email,
                full_name=args.name,
                hashed_password=hash_password(password),
                is_admin=args.admin,
                # 由管理员生成的临时密码，首次登录必须修改
                must_change_password=args.password is None,
            )
        )
        session.commit()
    print(f"已创建账号 {email}")
    if args.password is None:
        print(f"临时密码：{password}（首次登录需修改）")


def reset_password(args: argparse.Namespace) -> None:
    with Session(engine) as session:
        user = _find(session, args.email)
        password = _temp_password()
        user.hashed_password = hash_password(password)
        user.must_change_password = True
        user.token_version += 1
        session.add(user)
        session.commit()
    print(f"已重置 {user.email} 的密码，临时密码：{password}（首次登录需修改）")


def set_active(args: argparse.Namespace, active: bool) -> None:
    with Session(engine) as session:
        user = _find(session, args.email)
        user.is_active = active
        user.token_version += 1
        session.add(user)
        session.commit()
    print(f"已{'启用' if active else '停用'}账号 {user.email}")


def list_users(_: argparse.Namespace) -> None:
    with Session(engine) as session:
        for u in session.exec(select(User).order_by(User.created_at)):
            flags = [
                f
                for f, on in (("管理员", u.is_admin), ("已停用", not u.is_active), ("待改密", u.must_change_password))
                if on
            ]
            print(f"{u.email:<36} {u.full_name or '':<12} {' '.join(flags)}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="EverRead 账号管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create-user", help="创建账号")
    p.add_argument("email")
    p.add_argument("--name")
    p.add_argument("--admin", action="store_true", help="设为管理员")
    p.add_argument("--password", help="指定密码；不指定则生成临时密码并要求首次登录修改")
    p.set_defaults(func=create_user)

    p = sub.add_parser("reset-password", help="重置为临时密码")
    p.add_argument("email")
    p.set_defaults(func=reset_password)

    p = sub.add_parser("disable-user", help="停用账号（立即使已登录设备失效）")
    p.add_argument("email")
    p.set_defaults(func=lambda a: set_active(a, False))

    p = sub.add_parser("enable-user", help="重新启用账号")
    p.add_argument("email")
    p.set_defaults(func=lambda a: set_active(a, True))

    p = sub.add_parser("list-users", help="列出账号")
    p.set_defaults(func=list_users)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
