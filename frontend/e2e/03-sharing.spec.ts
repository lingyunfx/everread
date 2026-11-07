import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { GENERATED, apiGet, findBookId, expectPdfPage, gotoPdfPage, newUserPage, upload, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

let alice: Page;
let bob: Page;
let bookId: string;

test.beforeAll(async ({ browser }) => {
  alice = await newUserPage(browser, "alice");
  bob = await newUserPage(browser, "bob");
  await upload(alice, path.join(GENERATED, "示例扫描件.pdf"));
  bookId = await findBookId(alice, "示例扫描件");
});

test("私有书：其他成员看不到也无法读取文件", async () => {
  await bob.goto("/library");
  await expect(bob.getByTestId("library-card")).toHaveCount(0);
  await bob.goto(`/read/${bookId}`);
  await expect(bob.getByText("书籍不存在或暂不可访问")).toBeVisible();
  const t = await bob.evaluate(() => localStorage.getItem("everread:token"));
  const res = await bob.request.get(`/api/v1/books/${bookId}/file`, { headers: { Authorization: `Bearer ${t}` } });
  expect(res.status()).toBe(404);
});

test("公开后进入图书馆；成员加入书架，进度与笔记互相独立", async () => {
  await alice.goto("/manage");
  const row = alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" });
  await row.getByRole("button", { name: "私有" }).click();
  await expect(row.getByRole("button", { name: "已公开" })).toBeVisible();

  await bob.goto("/library");
  const card = bob.getByTestId("library-card").filter({ hasText: "示例扫描件" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "加入书架" }).click();
  await expect(card.getByText("已在书架")).toBeVisible();

  await bob.goto(`/read/${bookId}`);
  await expect(bob.getByTestId("scanned-notice")).toBeVisible();
  await gotoPdfPage(bob, 4);
  await waitSaved(bob);
  await bob.getByRole("button", { name: "此处" }).click();
  await bob.getByTestId("note-card").last().getByLabel("笔记内容").fill("小博的页级笔记");
  await expect(bob.getByTestId("note-card").last().getByTestId("note-status")).toHaveText("已保存");

  await alice.goto(`/read/${bookId}`);
  await gotoPdfPage(alice, 2);
  await waitSaved(alice);
  // 互不可见、互不影响
  await expect(alice.getByTestId("note-card")).toHaveCount(0);
  const bp = await apiGet<{ locator: { page: number } }>(bob, `/api/v1/books/${bookId}/progress`);
  const ap = await apiGet<{ locator: { page: number } }>(alice, `/api/v1/books/${bookId}/progress`);
  expect(bp.locator.page).toBe(4);
  expect(ap.locator.page).toBe(2);
});

test("非上传者不能修改或删除原书", async () => {
  const t = await bob.evaluate(() => localStorage.getItem("everread:token"));
  const h = { Authorization: `Bearer ${t}` };
  expect((await bob.request.patch(`/api/v1/books/${bookId}`, { headers: h, data: { visibility: "private" } })).status()).toBe(403);
  expect((await bob.request.delete(`/api/v1/books/${bookId}`, { headers: h })).status()).toBe(403);
  await bob.goto("/manage");
  await expect(bob.getByTestId("manage-row")).toHaveCount(0);
});

test("改回私有：成员书架显示暂不可访问，笔记保留；再次公开后恢复进度", async () => {
  await alice.goto("/manage");
  await alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" }).getByRole("button", { name: "已公开" }).click();
  await expect(alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" }).getByRole("button", { name: "私有" })).toBeVisible();

  await bob.goto("/");
  await expect(bob.getByTestId("shelf-card").filter({ hasText: "示例扫描件" })).toContainText("暂不可访问");
  await bob.goto(`/read/${bookId}`);
  await expect(bob.getByTestId("unavailable-reason")).toContainText("设为私有");
  await expect(bob.getByTestId("note-card").getByLabel("笔记内容")).toHaveValue("小博的页级笔记");

  await alice.goto("/manage");
  await alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" }).getByRole("button", { name: "私有" }).click();
  await bob.goto(`/read/${bookId}`);
  await expectPdfPage(bob, 4);
});

test("删除原书：显示影响人数；成员的笔记保留但不可跳转，可自行清除", async () => {
  await alice.goto("/manage");
  await alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" }).getByTitle("删除原书").click();
  await expect(alice.getByRole("dialog")).toContainText("另有 1 位成员");
  await alice.getByRole("button", { name: "确认删除" }).click();
  await expect(alice.getByTestId("manage-row").filter({ hasText: "示例扫描件" })).toHaveCount(0);

  await bob.goto("/");
  const card = bob.getByTestId("shelf-card").filter({ hasText: "示例扫描件" });
  await expect(card).toContainText("原书已删除");
  await bob.goto(`/read/${bookId}`);
  await expect(bob.getByTestId("unavailable-reason")).toContainText("删除");
  await expect(bob.getByTestId("note-card").getByLabel("笔记内容")).toHaveValue("小博的页级笔记");
  bob.once("dialog", (d) => d.accept());
  await bob.getByRole("button", { name: "清除我的记录" }).click();
  await expect(bob).toHaveURL(/\/$/);
  await expect(bob.getByTestId("shelf-card").filter({ hasText: "示例扫描件" })).toHaveCount(0);
});
