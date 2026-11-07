from fastapi import APIRouter

from app.api.routes import auth, books, reading, shelf

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(books.router)
api_router.include_router(shelf.router)
api_router.include_router(reading.router)
