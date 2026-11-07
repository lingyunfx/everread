from sqlmodel import Session, select

from app.core.db import engine
from app.models import User
from tests.conftest import login, make_user

API = "/api/v1"


def test_first_superuser_created(client):
    with Session(engine) as s:
        admin = s.exec(select(User).where(User.email == "admin@example.com")).one()
        assert admin.is_admin


def test_login_and_me(client):
    u, pw = make_user()
    h = login(client, u.email.upper(), pw)  # 邮箱不区分大小写
    me = client.get(f"{API}/users/me", headers=h).json()
    assert me["email"] == u.email
    assert me["preferences"]["theme"] == "light"


def test_wrong_password_and_anonymous(client):
    u, _ = make_user()
    r = client.post(f"{API}/login/access-token", data={"username": u.email, "password": "nope"})
    assert r.status_code == 400
    assert client.get(f"{API}/users/me").status_code == 401
    assert client.get(f"{API}/library").status_code == 401
    assert client.get(f"{API}/users/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_no_public_signup(client):
    for path in ("/users/signup", "/users", "/register"):
        r = client.post(f"{API}{path}", json={"email": "x@example.com", "password": "password-123"})
        assert r.status_code in (404, 405)


def test_must_change_password_flow(client):
    u, pw = make_user(must_change=True)
    h = login(client, u.email, pw)
    assert client.get(f"{API}/users/me", headers=h).json()["must_change_password"] is True
    # 修改密码前业务接口不可用
    assert client.get(f"{API}/shelf", headers=h).status_code == 403
    r = client.post(
        f"{API}/users/me/password", headers=h, json={"current_password": pw, "new_password": "new-password-1"}
    )
    assert r.status_code == 200
    new_h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get(f"{API}/shelf", headers=new_h).status_code == 200
    # 旧令牌失效
    assert client.get(f"{API}/users/me", headers=h).status_code == 401


def test_disabled_user_loses_access(client):
    u, pw = make_user()
    h = login(client, u.email, pw)
    with Session(engine) as s:
        db_user = s.get(User, u.id)
        db_user.is_active = False
        db_user.token_version += 1
        s.add(db_user)
        s.commit()
    assert client.get(f"{API}/users/me", headers=h).status_code == 401
    r = client.post(f"{API}/login/access-token", data={"username": u.email, "password": pw})
    assert r.status_code == 400


def test_preferences(client, alice):
    r = client.patch(f"{API}/users/me/preferences", headers=alice, json={"theme": "sepia", "font_size": 20})
    assert r.status_code == 200
    assert r.json()["preferences"]["theme"] == "sepia"
    assert r.json()["preferences"]["page_layout"] == "double"  # 默认双页
    r = client.patch(f"{API}/users/me/preferences", headers=alice, json={"page_layout": "single"})
    assert r.json()["preferences"]["page_layout"] == "single"
    assert client.patch(f"{API}/users/me/preferences", headers=alice, json={"theme": "pink"}).status_code == 422


def test_login_rate_limit(client):
    u, _ = make_user()
    codes = [
        client.post(f"{API}/login/access-token", data={"username": u.email, "password": "bad"}).status_code
        for _ in range(12)
    ]
    assert 429 in codes


def test_reserved_domain_email_works(client):
    """NAS 上常用 .local/.test 等内部域名邮箱，响应模型不能拒绝它们"""
    from app.core.security import hash_password

    with Session(engine) as s:
        s.add(User(email="friend@nas.local", hashed_password=hash_password("password-123")))
        s.commit()
    h = login(client, "friend@nas.local", "password-123")
    assert client.get(f"{API}/users/me", headers=h).json()["email"] == "friend@nas.local"
