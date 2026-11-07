"""应用配置：全部通过环境变量（或 .env）注入，不在代码里写真实密钥。"""

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    PROJECT_NAME: str = "永读 EverRead"
    API_V1_STR: str = "/api/v1"

    DATABASE_URL: str = "postgresql+psycopg://everread:everread@localhost:5432/everread"

    # JWT 签名密钥，生产必须改成随机长字符串
    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    # 允许的前端来源（逗号分隔），反向代理同域部署时可以留空
    CORS_ORIGINS: list[str] = []

    # 书籍与解析产物的存放目录（持久卷）
    DATA_DIR: Path = Path("./data")

    MAX_UPLOAD_MB: int = 100
    EPUB_MAX_UNCOMPRESSED_MB: int = 500
    EPUB_MAX_FILES: int = 5000
    PARSE_TIMEOUT_SECONDS: int = 180
    PARSE_CONCURRENCY: int = 2

    # 每个 IP 每分钟允许的登录尝试次数
    LOGIN_RATE_LIMIT_PER_MINUTE: int = 10

    # 首个管理员账号，仅在数据库中不存在时创建
    FIRST_SUPERUSER: str | None = None
    FIRST_SUPERUSER_PASSWORD: str | None = None

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
