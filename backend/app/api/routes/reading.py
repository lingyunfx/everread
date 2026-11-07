"""个人阅读记录：进度、标注、笔记、书签，以及当前书内的记录搜索。

所有记录的归属都由当前登录身份决定，只有记录所有者可以读取和修改。
创建记录需要当前对书籍有阅读权限；书籍被删除或改回私有后，已有记录仍可查看和清理。
"""

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy import func
from sqlmodel import Session, SQLModel, col, select

from app.api.deps import CurrentUser, SessionDep, get_book, get_readable_book, like_pattern
from app.models import Annotation, Bookmark, Note, ReadingProgress, User, utcnow
from app.schemas import (
    AnnotationCreate,
    AnnotationPublic,
    AnnotationUpdate,
    BookmarkCreate,
    BookmarkPublic,
    BookmarkUpdate,
    Message,
    NoteCreate,
    NotePublic,
    NoteUpdate,
    ProgressConflict,
    ProgressPublic,
    ProgressUpdate,
    RecordHit,
    RecordSearchResult,
)

router = APIRouter(tags=["reading"])

def _own[T: SQLModel](session: Session, model: type[T], record_id: uuid.UUID, user: User) -> T:
    obj = session.get(model, record_id)
    if obj is None or obj.owner_id != user.id:  # type: ignore[attr-defined]
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    return obj


# ---------- 进度 ----------


@router.get("/books/{book_id}/progress", response_model=ProgressPublic | None)
def get_progress(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> ReadingProgress | None:
    get_book(session, book_id)
    return session.exec(
        select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book_id)
    ).first()


@router.put(
    "/books/{book_id}/progress",
    response_model=ProgressPublic,
    responses={409: {"model": ProgressConflict}},
)
def save_progress(book_id: uuid.UUID, body: ProgressUpdate, user: CurrentUser, session: SessionDep):
    """带版本号保存进度：客户端基于的版本落后时返回 409，避免迟到请求或其他设备覆盖新进度。"""
    book = get_readable_book(session, user, book_id)
    if body.locator["type"] != book.format.value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "位置格式与书籍格式不符")
    prog = session.exec(
        select(ReadingProgress)
        .where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book_id)
        .with_for_update()
    ).first()
    if prog is None:
        prog = ReadingProgress(user_id=user.id, book_id=book_id, locator=body.locator, percent=body.percent)
    elif prog.locator == body.locator:
        # 位置未变（如另一台设备只是打开了书）：不递增版本，避免让其他设备误判冲突
        return prog
    else:
        if not body.force and body.base_revision != prog.revision:
            current = ProgressPublic.model_validate(prog, from_attributes=True)
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"detail": "其他设备更新了阅读进度", "current": current.model_dump(mode="json")},
            )
        prog.locator = body.locator
        prog.percent = body.percent
        prog.revision += 1
        prog.updated_at = utcnow()
    prog.device = body.device
    session.add(prog)
    session.commit()
    session.refresh(prog)
    return prog


# ---------- 标注 ----------


@router.get("/books/{book_id}/annotations", response_model=list[AnnotationPublic])
def list_annotations(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> list[Annotation]:
    return list(
        session.exec(
            select(Annotation)
            .where(Annotation.owner_id == user.id, Annotation.book_id == book_id)
            .order_by(col(Annotation.created_at))
        ).all()
    )


@router.post("/books/{book_id}/annotations", response_model=AnnotationPublic, status_code=status.HTTP_201_CREATED)
def create_annotation(book_id: uuid.UUID, body: AnnotationCreate, user: CurrentUser, session: SessionDep) -> Annotation:
    book = get_readable_book(session, user, book_id)
    if body.locator["type"] != book.format.value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "位置格式与书籍格式不符")
    if body.id is not None and (existing := session.get(Annotation, body.id)) is not None:
        if existing.owner_id != user.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "ID 冲突")
        return existing  # 重试请求：返回已创建的记录
    ann = Annotation(owner_id=user.id, book_id=book_id, **body.model_dump(exclude_none=True))
    session.add(ann)
    session.commit()
    session.refresh(ann)
    return ann


@router.patch("/annotations/{annotation_id}", response_model=AnnotationPublic)
def update_annotation(
    annotation_id: uuid.UUID, body: AnnotationUpdate, user: CurrentUser, session: SessionDep
) -> Annotation:
    ann = _own(session, Annotation, annotation_id, user)
    # 同组（跨页拆分）的标注一起改色
    targets = [ann]
    if ann.group_id:
        targets = list(
            session.exec(select(Annotation).where(Annotation.owner_id == user.id, Annotation.group_id == ann.group_id))
        )
    for a in targets:
        a.color = body.color
        a.updated_at = utcnow()
        session.add(a)
    session.commit()
    session.refresh(ann)
    return ann


@router.delete("/annotations/{annotation_id}", response_model=Message)
def delete_annotation(annotation_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    """删除标注（含同组），关联笔记保留，其位置与引用原文快照仍在。"""
    ann = _own(session, Annotation, annotation_id, user)
    targets = [ann]
    if ann.group_id:
        targets = list(
            session.exec(select(Annotation).where(Annotation.owner_id == user.id, Annotation.group_id == ann.group_id))
        )
    ids = [a.id for a in targets]
    for note in session.exec(select(Note).where(col(Note.annotation_id).in_(ids))):
        note.annotation_id = None
        session.add(note)
    session.flush()
    for a in targets:
        session.delete(a)
    session.commit()
    return Message(message="已删除标注")


# ---------- 笔记 ----------


@router.get("/books/{book_id}/notes", response_model=list[NotePublic])
def list_notes(book_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> list[Note]:
    return list(
        session.exec(
            select(Note).where(Note.owner_id == user.id, Note.book_id == book_id).order_by(col(Note.created_at))
        ).all()
    )


@router.post("/books/{book_id}/notes", response_model=NotePublic, status_code=status.HTTP_201_CREATED)
def create_note(book_id: uuid.UUID, body: NoteCreate, user: CurrentUser, session: SessionDep) -> Note:
    get_readable_book(session, user, book_id)
    if body.id is not None and (existing := session.get(Note, body.id)) is not None:
        if existing.owner_id != user.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "ID 冲突")
        return existing
    data = body.model_dump(exclude_none=True)
    if body.annotation_id is not None:
        ann = session.get(Annotation, body.annotation_id)
        if ann is None or ann.owner_id != user.id or ann.book_id != book_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "关联的标注不存在")
        # 保存位置与原文快照，删除标注后笔记仍能定位
        data.setdefault("locator", ann.locator)
        data.setdefault("quote", ann.quote)
    note = Note(owner_id=user.id, book_id=book_id, **data)
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.patch("/notes/{note_id}", response_model=NotePublic, responses={409: {"model": NotePublic}})
def update_note(note_id: uuid.UUID, body: NoteUpdate, user: CurrentUser, session: SessionDep):
    note = _own(session, Note, note_id, user)
    if body.base_revision is not None and body.base_revision != note.revision:
        current = NotePublic.model_validate(note, from_attributes=True)
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=current.model_dump(mode="json"))
    note.body = body.body
    note.revision += 1
    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.delete("/notes/{note_id}", response_model=Message)
def delete_note(note_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    session.delete(_own(session, Note, note_id, user))
    session.commit()
    return Message(message="已删除笔记")


# ---------- 书签 ----------


@router.get("/books/{book_id}/bookmarks", response_model=list[BookmarkPublic])
def list_bookmarks(book_id: uuid.UUID, user: CurrentUser, session: SessionDep, q: str | None = None) -> list[Bookmark]:
    stmt = select(Bookmark).where(Bookmark.owner_id == user.id, Bookmark.book_id == book_id)
    if q and q.strip():
        like = like_pattern(q)
        stmt = stmt.where(col(Bookmark.name).ilike(like, escape="\\") | col(Bookmark.memo).ilike(like, escape="\\"))
    return list(session.exec(stmt.order_by(col(Bookmark.sort_key), col(Bookmark.created_at))).all())


@router.post("/books/{book_id}/bookmarks", response_model=BookmarkPublic, status_code=status.HTTP_201_CREATED)
def create_bookmark(book_id: uuid.UUID, body: BookmarkCreate, user: CurrentUser, session: SessionDep) -> Bookmark:
    book = get_readable_book(session, user, book_id)
    if body.locator["type"] != book.format.value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "位置格式与书籍格式不符")
    if body.id is not None and (existing := session.get(Bookmark, body.id)) is not None:
        if existing.owner_id != user.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "ID 冲突")
        return existing
    bm = Bookmark(owner_id=user.id, book_id=book_id, **body.model_dump(exclude_none=True))
    session.add(bm)
    session.commit()
    session.refresh(bm)
    return bm


@router.patch("/bookmarks/{bookmark_id}", response_model=BookmarkPublic)
def update_bookmark(bookmark_id: uuid.UUID, body: BookmarkUpdate, user: CurrentUser, session: SessionDep) -> Bookmark:
    bm = _own(session, Bookmark, bookmark_id, user)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(bm, k, v)
    session.add(bm)
    session.commit()
    session.refresh(bm)
    return bm


@router.delete("/bookmarks/{bookmark_id}", response_model=Message)
def delete_bookmark(bookmark_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    session.delete(_own(session, Bookmark, bookmark_id, user))
    session.commit()
    return Message(message="已删除书签")


# ---------- 记录搜索 ----------


def _snippet(text: str, q: str, width: int = 40) -> str:
    i = text.lower().find(q.lower())
    if i < 0:
        return text[: width * 2]
    start = max(0, i - width)
    end = min(len(text), i + len(q) + width)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


@router.get("/books/{book_id}/records/search", response_model=RecordSearchResult)
def search_records(
    book_id: uuid.UUID,
    user: CurrentUser,
    session: SessionDep,
    q: str = Query(min_length=1, max_length=200),
    kind: Literal["note", "annotation"] = "note",
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> RecordSearchResult:
    """在当前书内搜索自己的笔记或标注；子串匹配，只返回当前用户的记录。"""
    like = like_pattern(q)
    hits: list[RecordHit] = []
    if kind == "note":
        cond = (
            (Note.owner_id == user.id)
            & (Note.book_id == book_id)
            & (col(Note.body).ilike(like, escape="\\") | col(Note.quote).ilike(like, escape="\\"))
        )
        total = session.exec(select(func.count()).select_from(Note).where(cond)).one()
        rows = session.exec(
            select(Note).where(cond).order_by(col(Note.updated_at).desc()).offset(offset).limit(limit)
        ).all()
        for n in rows:
            source = n.body if q.lower() in n.body.lower() else (n.quote or "")
            hits.append(
                RecordHit(
                    kind="note",
                    id=n.id,
                    snippet=_snippet(source, q),
                    quote=n.quote,
                    locator=n.locator,
                    updated_at=n.updated_at,
                )
            )
    else:
        cond = (
            (Annotation.owner_id == user.id)
            & (Annotation.book_id == book_id)
            & col(Annotation.quote).ilike(like, escape="\\")
        )
        total = session.exec(select(func.count()).select_from(Annotation).where(cond)).one()
        rows = session.exec(
            select(Annotation).where(cond).order_by(col(Annotation.created_at)).offset(offset).limit(limit)
        ).all()
        for a in rows:
            hits.append(
                RecordHit(
                    kind="annotation",
                    id=a.id,
                    snippet=_snippet(a.quote, q),
                    quote=a.quote,
                    locator=a.locator,
                    updated_at=a.updated_at,
                )
            )
    return RecordSearchResult(total=total, items=hits)
