import uuid

import pytest

from tests.conftest import upload_ready

API = "/api/v1"


@pytest.fixture
def pdf_book(client, alice, samples):
    # 每个用户的同一文件只能上传一次，这里用不同用户各自上传
    return upload_ready(client, alice, samples / "示例文本书.pdf")


def test_progress_revision_and_conflict(client, alice, pdf_book):
    bid = pdf_book["id"]
    assert client.get(f"{API}/books/{bid}/progress", headers=alice).json() is None
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 9, "y": 0.3}, "percent": 7.5},
    )
    assert r.json()["revision"] == 1
    # 设备 A 基于版本 1 继续保存
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 10, "y": 0}, "percent": 8, "base_revision": 1, "device": "A"},
    )
    assert r.json()["revision"] == 2
    # 位置未变的保存（如另一台设备只是打开了书）不递增版本，即使基于旧版本
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 10, "y": 0}, "percent": 8, "base_revision": 1},
    )
    assert r.status_code == 200 and r.json()["revision"] == 2
    # 设备 B 仍基于版本 1：冲突，返回当前进度
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 3, "y": 0}, "percent": 2, "base_revision": 1, "device": "B"},
    )
    assert r.status_code == 409
    assert r.json()["current"]["locator"]["page"] == 10 and r.json()["current"]["device"] == "A"
    # 用户选择以本机为准
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "pdf", "page": 3, "y": 0}, "percent": 2, "force": True},
    )
    assert r.status_code == 200 and r.json()["revision"] == 3
    # 格式不符
    r = client.put(
        f"{API}/books/{bid}/progress",
        headers=alice,
        json={"locator": {"type": "txt", "para": 1}, "percent": 1, "force": True},
    )
    assert r.status_code == 400
    r = client.put(f"{API}/books/{bid}/progress", headers=alice, json={"locator": {"type": "bad"}, "percent": 1})
    assert r.status_code == 422


def test_annotations_and_notes(client, alice, pdf_book):
    bid = pdf_book["id"]
    group = str(uuid.uuid4())
    a1 = {
        "id": str(uuid.uuid4()),
        "locator": {"type": "pdf", "page": 5, "rects": [[50, 100, 300, 112]]},
        "quote": "第一段琉璃",
        "group_id": group,
    }
    a2 = {
        "id": str(uuid.uuid4()),
        "locator": {"type": "pdf", "page": 6, "rects": [[50, 60, 200, 72]]},
        "quote": "第二段",
        "group_id": group,
    }
    assert client.post(f"{API}/books/{bid}/annotations", headers=alice, json=a1).status_code == 201
    # 重试同一个 ID 不重复创建
    assert client.post(f"{API}/books/{bid}/annotations", headers=alice, json=a1).status_code == 201
    client.post(f"{API}/books/{bid}/annotations", headers=alice, json=a2)
    assert len(client.get(f"{API}/books/{bid}/annotations", headers=alice).json()) == 2

    # 改色作用于同组
    client.patch(f"{API}/annotations/{a1['id']}", headers=alice, json={"color": "green"})
    assert {a["color"] for a in client.get(f"{API}/books/{bid}/annotations", headers=alice).json()} == {"green"}

    note_id = str(uuid.uuid4())
    r = client.post(
        f"{API}/books/{bid}/notes", headers=alice, json={"id": note_id, "annotation_id": a1["id"], "body": "我的想法"}
    )
    note = r.json()
    assert note["locator"] == a1["locator"] and note["quote"] == "第一段琉璃"
    client.post(f"{API}/books/{bid}/notes", headers=alice, json={"id": note_id, "body": "重复提交"})
    assert len(client.get(f"{API}/books/{bid}/notes", headers=alice).json()) == 1

    # 带版本号更新与冲突
    r = client.patch(f"{API}/notes/{note_id}", headers=alice, json={"body": "改一次", "base_revision": 1})
    assert r.json()["revision"] == 2
    r = client.patch(f"{API}/notes/{note_id}", headers=alice, json={"body": "旧设备", "base_revision": 1})
    assert r.status_code == 409 and r.json()["body"] == "改一次"

    # 删除标注（含同组），笔记保留快照
    assert client.delete(f"{API}/annotations/{a1['id']}", headers=alice).status_code == 200
    assert client.get(f"{API}/books/{bid}/annotations", headers=alice).json() == []
    n = client.get(f"{API}/books/{bid}/notes", headers=alice).json()[0]
    assert n["annotation_id"] is None and n["locator"]["page"] == 5 and n["quote"] == "第一段琉璃"

    # 整书笔记无位置
    r = client.post(f"{API}/books/{bid}/notes", headers=alice, json={"body": "整本书的感想"})
    assert r.json()["locator"] is None
    assert client.delete(f"{API}/notes/{note_id}", headers=alice).status_code == 200


def test_bookmarks(client, alice, pdf_book):
    bid = pdf_book["id"]
    for page, name in ((100, "第一百页"), (10, "第十页")):
        r = client.post(
            f"{API}/books/{bid}/bookmarks",
            headers=alice,
            json={
                "locator": {"type": "pdf", "page": page, "y": 0},
                "position_label": f"第 {page} 页",
                "sort_key": page,
                "name": name,
            },
        )
        assert r.status_code == 201
    marks = client.get(f"{API}/books/{bid}/bookmarks", headers=alice).json()
    assert [m["locator"]["page"] for m in marks] == [10, 100]  # 按位置排序
    found = client.get(f"{API}/books/{bid}/bookmarks", headers=alice, params={"q": "一百"}).json()
    assert len(found) == 1 and found[0]["locator"]["page"] == 100
    mid = found[0]["id"]
    r = client.patch(f"{API}/bookmarks/{mid}", headers=alice, json={"name": "重要", "memo": "备注"})
    assert r.json()["name"] == "重要"
    assert client.delete(f"{API}/bookmarks/{mid}", headers=alice).status_code == 200
    assert len(client.get(f"{API}/books/{bid}/bookmarks", headers=alice).json()) == 1


def test_record_search_and_isolation(client, alice, bob, samples):
    book = upload_ready(client, alice, samples / "示例中文.epub")
    bid = book["id"]
    client.patch(f"{API}/books/{bid}", headers=alice, json={"visibility": "public"})
    loc = {"type": "epub", "cfi": "epubcfi(/6/8!/4/2/1:0)"}
    client.post(f"{API}/books/{bid}/annotations", headers=alice, json={"locator": loc, "quote": "琉璃灯盏在这里"})
    client.post(f"{API}/books/{bid}/notes", headers=alice, json={"body": "关于琉璃的笔记", "locator": loc})
    client.post(f"{API}/books/{bid}/notes", headers=bob, json={"body": "B 也写了琉璃"})

    r = client.get(f"{API}/books/{bid}/records/search", headers=alice, params={"q": "琉璃", "kind": "note"}).json()
    assert r["total"] == 1 and "琉璃" in r["items"][0]["snippet"]
    r = client.get(
        f"{API}/books/{bid}/records/search", headers=alice, params={"q": "灯盏", "kind": "annotation"}
    ).json()
    assert r["total"] == 1 and r["items"][0]["locator"] == loc
    r = client.get(f"{API}/books/{bid}/records/search", headers=bob, params={"q": "琉璃", "kind": "annotation"}).json()
    assert r["total"] == 0

    # 猜测他人记录 ID：一律 404
    alice_note = client.get(f"{API}/books/{bid}/notes", headers=alice).json()[0]
    alice_ann = client.get(f"{API}/books/{bid}/annotations", headers=alice).json()[0]
    assert client.patch(f"{API}/notes/{alice_note['id']}", headers=bob, json={"body": "x"}).status_code == 404
    assert client.delete(f"{API}/notes/{alice_note['id']}", headers=bob).status_code == 404
    assert client.delete(f"{API}/annotations/{alice_ann['id']}", headers=bob).status_code == 404
    # 用他人记录的 ID 创建：拒绝，不泄露内容
    r = client.post(f"{API}/books/{bid}/notes", headers=bob, json={"id": alice_note["id"], "body": "x"})
    assert r.status_code == 409
    # 关联他人的标注：拒绝
    r = client.post(f"{API}/books/{bid}/notes", headers=bob, json={"annotation_id": alice_ann["id"], "body": "x"})
    assert r.status_code == 400
