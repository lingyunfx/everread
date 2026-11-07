import io
import zipfile

from app.core.config import settings
from tests.conftest import upload, upload_ready

API = "/api/v1"


def test_upload_all_formats(client, alice, samples):
    pdf = upload_ready(client, alice, samples / "示例文本书.pdf")
    assert pdf["format"] == "pdf" and pdf["page_count"] == 120 and pdf["has_text_layer"] is True
    assert pdf["title"] == "永读示例文本书"  # 取自元数据
    assert pdf["meta"]["toc"][0]["title"] == "开始"

    scan = upload_ready(client, alice, samples / "示例扫描件.pdf")
    assert scan["has_text_layer"] is False
    assert scan["title"] == "示例扫描件"  # 无元数据时用文件名

    epub = upload_ready(client, alice, samples / "示例中文.epub")
    assert epub["format"] == "epub" and epub["has_cover"] is True

    txt = upload_ready(client, alice, samples / "示例UTF8.txt")
    assert txt["meta"]["encoding"] == "utf-8"
    assert txt["meta"]["toc"][0]["title"] == "第1章 起风了"

    gb = upload_ready(client, alice, samples / "示例GB18030.txt")
    assert gb["meta"]["encoding"] == "gb18030"
    content = client.get(f"{API}/books/{gb['id']}/txt", headers=alice).json()
    assert content["paragraphs"][0] == "第1章 起风了"
    assert "😀" in content["paragraphs"][1]

    shelf = client.get(f"{API}/shelf", headers=alice).json()
    assert {i["book"]["id"] for i in shelf} >= {pdf["id"], scan["id"], epub["id"], txt["id"], gb["id"]}


def test_upload_validation(client, alice, samples):
    r = client.post(f"{API}/books", headers=alice, files={"file": ("a.mobi", b"xxxx")})
    assert r.status_code == 415
    r = client.post(f"{API}/books", headers=alice, files={"file": ("fake.pdf", b"hello world")})
    assert r.status_code == 400
    r = client.post(f"{API}/books", headers=alice, files={"file": ("fake.epub", b"PK\x03\x04garbage")})
    assert r.status_code == 400
    r = client.post(f"{API}/books", headers=alice, files={"file": ("empty.txt", b"")})
    assert r.status_code == 400
    big = b"a" * (settings.max_upload_bytes + 1)
    r = client.post(f"{API}/books", headers=alice, files={"file": ("big.txt", big)})
    assert r.status_code == 413
    # 临时文件被清理
    assert not any((settings.DATA_DIR / "tmp").glob("*.upload"))


def test_failed_parse_and_retry(client, alice, samples):
    r = upload(client, alice, samples / "加密.pdf")
    book = client.get(f"{API}/books/{r.json()['id']}", headers=alice).json()
    assert book["status"] == "failed" and "密码" in book["error"]
    # 失败的书不出现在书架上，但仍在“我上传的书”里可重试/删除
    assert book["id"] not in {i["book"]["id"] for i in client.get(f"{API}/shelf", headers=alice).json()}
    assert book["id"] in {b["id"] for b in client.get(f"{API}/books/mine", headers=alice).json()}

    r = upload(client, alice, samples / "损坏.pdf")
    book = client.get(f"{API}/books/{r.json()['id']}", headers=alice).json()
    assert book["status"] == "failed" and "损坏" in book["error"]
    r = client.post(f"{API}/books/{book['id']}/retry", headers=alice, json={})
    assert r.status_code == 200
    assert client.get(f"{API}/books/{book['id']}", headers=alice).json()["status"] == "failed"
    # 失败的书不能读取文件
    assert client.get(f"{API}/books/{book['id']}/file", headers=alice).status_code == 409


def test_txt_reparse_with_encoding(client, alice, samples):
    p = samples / "big5.txt"
    p.write_bytes("第一章 開始\n繁體中文內容測試".encode("big5"))
    book = upload_ready(client, alice, p)
    r = client.post(f"{API}/books/{book['id']}/retry", headers=alice, json={"encoding": "big5"})
    assert r.status_code == 200
    book = client.get(f"{API}/books/{book['id']}", headers=alice).json()
    assert book["meta"]["encoding"] == "big5"
    content = client.get(f"{API}/books/{book['id']}/txt", headers=alice).json()
    assert content["paragraphs"][1] == "繁體中文內容測試"


def test_duplicate_upload(client, bob, samples):
    first = upload_ready(client, bob, samples / "示例中文.epub")
    r = upload(client, bob, samples / "示例中文.epub", name="改了名字.epub")
    assert r.status_code == 409
    assert r.json()["book_id"] == first["id"]


def test_epub_is_sanitized(client, alice, samples):
    book = upload_ready(client, alice, samples / "带脚本的书.epub")
    r = client.get(f"{API}/books/{book['id']}/file", headers=alice)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    ch = z.read("OEBPS/ch1.xhtml").decode()
    assert "<script" not in ch and "onload" not in ch and "tracker.example.com" not in ch
    assert "第1章第1段" in ch
    assert z.read("mimetype") == b"application/epub+zip"


def test_file_range_and_cover(client, alice, samples):
    book = upload_ready(client, alice, samples / "示例文本书.pdf")
    r = client.get(f"{API}/books/{book['id']}/file", headers={**alice, "Range": "bytes=0-99"})
    assert r.status_code == 206
    assert len(r.content) == 100 and r.content.startswith(b"%PDF")
    assert r.headers["content-range"].startswith("bytes 0-99/")
    # 不暴露 application/pdf，避免下载工具拦截
    assert r.headers["content-type"] == "application/x-everread-book"
    assert "content-disposition" not in r.headers
    cover = client.get(f"{API}/books/{book['id']}/cover", headers=alice)
    assert cover.status_code == 200 and cover.headers["content-type"] == "image/jpeg"


def test_private_book_isolation(client, alice, bob, samples):
    book = upload_ready(client, alice, samples / "示例扫描件.pdf")
    bid = book["id"]
    for path in (f"/books/{bid}", f"/books/{bid}/file", f"/books/{bid}/cover"):
        assert client.get(f"{API}{path}", headers=bob).status_code == 404, path
    assert client.post(f"{API}/shelf/{bid}", headers=bob).status_code == 404
    assert client.post(f"{API}/shelf/{bid}/open", headers=bob).status_code == 404
    assert client.patch(f"{API}/books/{bid}", headers=bob, json={"title": "x"}).status_code == 404
    assert client.delete(f"{API}/books/{bid}", headers=bob).status_code == 404
    loc = {"type": "pdf", "page": 1, "y": 0}
    assert client.post(f"{API}/books/{bid}/bookmarks", headers=bob, json={"locator": loc}).status_code == 404
    assert (
        client.put(f"{API}/books/{bid}/progress", headers=bob, json={"locator": loc, "percent": 1}).status_code == 404
    )
    assert bid not in {i["book"]["id"] for i in client.get(f"{API}/library", headers=bob).json()}


def test_public_private_cycle(client, alice, bob, samples):
    book = upload_ready(client, alice, samples / "示例文本书.pdf")
    bid = book["id"]
    r = client.patch(f"{API}/books/{bid}", headers=alice, json={"visibility": "public", "title": "公开的书"})
    assert r.json()["visibility"] == "public" and r.json()["title"] == "公开的书"

    lib = client.get(f"{API}/library", headers=bob, params={"q": "公开的"}).json()
    assert [i["book"]["id"] for i in lib] == [bid] and lib[0]["on_my_shelf"] is False

    # B 直接打开公开书，自动进入书架；进度与 A 互不影响
    assert client.post(f"{API}/shelf/{bid}/open", headers=bob).status_code == 200
    assert client.get(f"{API}/books/{bid}/file", headers=bob).status_code == 200
    loc_b = {"type": "pdf", "page": 30, "y": 0.5}
    client.put(f"{API}/books/{bid}/progress", headers=bob, json={"locator": loc_b, "percent": 25})
    client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 9, "y": 0.1}, "percent": 7},
    )
    assert client.get(f"{API}/books/{bid}/progress", headers=bob).json()["locator"]["page"] == 30
    assert client.get(f"{API}/books/{bid}/progress", headers=alice).json()["locator"]["page"] == 9
    client.post(f"{API}/books/{bid}/notes", headers=bob, json={"body": "B 的笔记"})
    assert client.get(f"{API}/books/{bid}/notes", headers=alice).json() == []

    # 非上传者不能改元数据、可见性或删除
    assert client.patch(f"{API}/books/{bid}", headers=bob, json={"visibility": "private"}).status_code == 403
    assert client.delete(f"{API}/books/{bid}", headers=bob).status_code == 403

    # 改回私有：B 无法获取内容，书架显示不可访问，个人记录保留
    client.patch(f"{API}/books/{bid}", headers=alice, json={"visibility": "private"})
    assert client.get(f"{API}/books/{bid}/file", headers=bob).status_code == 404
    item = next(i for i in client.get(f"{API}/shelf", headers=bob).json() if i["book"]["id"] == bid)
    assert item["accessible"] is False and item["unavailable_reason"] == "private"
    assert len(client.get(f"{API}/books/{bid}/notes", headers=bob).json()) == 1
    assert client.post(f"{API}/books/{bid}/notes", headers=bob, json={"body": "x"}).status_code == 404
    detail = client.get(f"{API}/books/{bid}", headers=bob).json()
    assert detail["accessible"] is False and detail["meta"] == {}

    # 再次公开：B 的进度恢复
    client.patch(f"{API}/books/{bid}", headers=alice, json={"visibility": "public"})
    assert client.get(f"{API}/books/{bid}/progress", headers=bob).json()["locator"] == loc_b
    assert client.get(f"{API}/books/{bid}/file", headers=bob).status_code == 200


def test_delete_book_keeps_others_records(client, alice, bob, samples):
    book = upload_ready(client, alice, samples / "示例UTF8.txt")
    bid = book["id"]
    client.patch(f"{API}/books/{bid}", headers=alice, json={"visibility": "public"})
    client.post(f"{API}/shelf/{bid}", headers=bob)
    loc = {"type": "txt", "para": 3, "offset": 0}
    client.post(f"{API}/books/{bid}/notes", headers=bob, json={"body": "保留我", "locator": loc, "quote": "引用"})
    assert client.get(f"{API}/books/{bid}/delete-impact", headers=alice).json()["other_readers"] == 1

    assert client.delete(f"{API}/books/{bid}", headers=alice).status_code == 200
    assert client.get(f"{API}/books/{bid}/txt", headers=bob).status_code == 404
    assert client.get(f"{API}/books/{bid}/txt", headers=alice).status_code == 410
    assert bid not in {i["book"]["id"] for i in client.get(f"{API}/library", headers=bob).json()}
    assert not (settings.DATA_DIR / "books" / bid).exists()

    item = next(i for i in client.get(f"{API}/shelf", headers=bob).json() if i["book"]["id"] == bid)
    assert item["unavailable_reason"] == "deleted"
    notes = client.get(f"{API}/books/{bid}/notes", headers=bob).json()
    assert notes[0]["body"] == "保留我" and notes[0]["locator"] == loc
    # 上传者自己的书架不再显示
    assert bid not in {i["book"]["id"] for i in client.get(f"{API}/shelf", headers=alice).json()}

    # B 自行清除个人记录
    assert client.delete(f"{API}/books/{bid}/my-records", headers=bob).status_code == 200
    assert client.get(f"{API}/books/{bid}/notes", headers=bob).json() == []
    assert bid not in {i["book"]["id"] for i in client.get(f"{API}/shelf", headers=bob).json()}

    # 删除后可以重新上传同一文件
    assert upload(client, alice, __import__("pathlib").Path(samples / "示例UTF8.txt")).status_code == 201


def test_shelf_operations(client, alice, samples):
    book = upload_ready(client, alice, samples / "示例GB18030.txt")
    bid = book["id"]
    assert client.delete(f"{API}/shelf/{bid}", headers=alice).status_code == 200
    assert bid not in {i["book"]["id"] for i in client.get(f"{API}/shelf", headers=alice).json()}
    assert bid in {i["book"]["id"] for i in client.get(f"{API}/shelf", headers=alice, params={"removed": True}).json()}
    # 移出书架不影响原书
    assert client.get(f"{API}/books/{bid}/txt", headers=alice).status_code == 200
    client.post(f"{API}/shelf/{bid}", headers=alice)
    opened = client.post(f"{API}/shelf/{bid}/open", headers=alice).json()
    assert opened["read_status"] == "reading" and opened["last_read_at"]
    client.patch(f"{API}/shelf/{bid}", headers=alice, json={"read_status": "finished"})
    finished = client.get(f"{API}/shelf", headers=alice, params={"read_status": "finished"}).json()
    assert bid in {i["book"]["id"] for i in finished}
    # 搜索中的通配符按字面匹配
    assert client.get(f"{API}/shelf", headers=alice, params={"q": "%"}).json() == []
