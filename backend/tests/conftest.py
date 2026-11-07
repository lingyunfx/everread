"""测试环境：独立的 SQLite 数据库与临时数据目录。"""

import os
import shutil
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="everread-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_tmp / 'test.db').as_posix()}"
os.environ["DATA_DIR"] = str(_tmp / "data")
os.environ["SECRET_KEY"] = "test-secret-key-that-is-long-enough-for-hs256"
os.environ["FIRST_SUPERUSER"] = "admin@example.com"
os.environ["FIRST_SUPERUSER_PASSWORD"] = "admin-password"
os.environ["MAX_UPLOAD_MB"] = "5"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, SQLModel  # noqa: E402

from app.api.routes.auth import login_limiter  # noqa: E402
from app.core.db import engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402
from scripts import make_samples  # noqa: E402

SAMPLES = _tmp / "samples"


@pytest.fixture(scope="session", autouse=True)
def _setup():
    SQLModel.metadata.create_all(engine)
    make_samples.write_all(SAMPLES)
    yield
    engine.dispose()
    shutil.rmtree(_tmp, ignore_errors=True)


@pytest.fixture(scope="session")
def client(_setup):
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_limiter():
    login_limiter.reset()


@pytest.fixture(scope="session")
def samples() -> Path:
    return SAMPLES


_counter = 0


def make_user(*, must_change: bool = False, password: str = "password-123") -> tuple[User, str]:
    global _counter
    _counter += 1
    with Session(engine) as s:
        u = User(
            email=f"user{_counter}@example.com",
            hashed_password=hash_password(password),
            must_change_password=must_change,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        return u, password


def login(client: TestClient, email: str, password: str) -> dict:
    r = client.post("/api/v1/login/access-token", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def alice(client) -> dict:
    u, pw = make_user()
    return login(client, u.email, pw)


@pytest.fixture
def bob(client) -> dict:
    u, pw = make_user()
    return login(client, u.email, pw)


def upload(client: TestClient, headers: dict, path: Path, name: str | None = None):
    with path.open("rb") as fh:
        return client.post("/api/v1/books", headers=headers, files={"file": (name or path.name, fh)})


def upload_ready(client: TestClient, headers: dict, path: Path) -> dict:
    r = upload(client, headers, path)
    assert r.status_code == 201, r.text
    # TestClient 在响应后同步执行后台任务，此时解析已完成
    book = client.get(f"/api/v1/books/{r.json()['id']}", headers=headers).json()
    assert book["status"] == "ready", book
    return book
