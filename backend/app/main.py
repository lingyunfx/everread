import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.core.config import settings
from app.initial_data import ensure_first_superuser
from app.services.importer import mark_interrupted_jobs

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    mark_interrupted_jobs()
    ensure_first_superuser()
    yield


app = FastAPI(title=settings.PROJECT_NAME, openapi_url=f"{settings.API_V1_STR}/openapi.json", lifespan=lifespan)

if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/api/health", include_in_schema=False)
def health() -> dict:
    return {"status": "ok"}
