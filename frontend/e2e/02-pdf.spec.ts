import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { GENERATED, apiGet, dragSelect, findBookId, expectPdfPage, gotoPdfPage, newUserPage, overlaps, upload, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;
let bookId: string;

test.beforeAll(async ({ browser }) => {
  page = await newUserPage(browser, "alice");
});

test("上传 PDF：显示解析状态并进入书架", async () => {
  await upload(page, path.join(GENERATED, "示例文本书.pdf"));
  await page.reload();
  await expect(page.getByTestId("shelf-card").filter({ hasText: "永读示例文本书" })).toBeVisible();
  bookId = await findBookId(page, "永读示例文本书");
});

test("重复上传同一文件给出提示", async () => {
  const item = await upload(page, path.join(GENERATED, "示例文本书.pdf"), "已上传过");
  await expect(item.getByRole("link", { name: "打开已有的书" })).toBeVisible();
});

test("加密与损坏的文件给出可理解的错误", async () => {
  await upload(page, path.join(GENERATED, "加密.pdf"), "密码保护");
  await upload(page, path.join(GENERATED, "损坏.pdf"), "已损坏");
});

test("读到第 9 页后刷新、重新登录、第二设备都能续读", async ({ browser }) => {
  await page.goto(`/read/${bookId}`);
  await expect(page.getByTestId("pdf-page-1")).toBeVisible();
  await gotoPdfPage(page, 9);
  await waitSaved(page);
  await page.reload();
  await expectPdfPage(page, 9);

  const other = await newUserPage(browser, "alice", { viewport: { width: 1280, height: 800 } });
  await other.goto(`/read/${bookId}`);
  await expectPdfPage(other, 9);
  // 双页时记录这一组的左页（封面单独，之后 8-9 成对）
  const progress = await apiGet<{ locator: { page: number } }>(other, `/api/v1/books/${bookId}/progress`);
  expect([8, 9]).toContain(progress.locator.page);
  await other.context().close();
});

test("在第 10 页和第 100 页添加书签，按名称筛选后精确跳转", async () => {
  await gotoPdfPage(page, 10);
  await page.getByRole("button", { name: "添加书签" }).click();
  await gotoPdfPage(page, 100);
  await page.getByRole("button", { name: "添加书签" }).click();
  await page.getByRole("button", { name: "切换左侧栏" }).click();
  await page.getByRole("tab", { name: /书签/ }).click();
  await expect(page.getByTestId("bookmark-item")).toHaveCount(2);

  // 重命名第 100 页书签
  const row100 = page.getByTestId("bookmark-item").filter({ hasText: "第 100–101 / 120 页" });
  await row100.hover();
  await row100.getByRole("button", { name: "编辑书签" }).click();
  await page.getByPlaceholder("书签名称").fill("重要的一页");
  await page.getByPlaceholder("备注").fill("回头再看");
  await page.getByRole("button", { name: "保存书签" }).click();

  await gotoPdfPage(page, 3);
  await page.getByPlaceholder("按名称筛选书签").fill("重要");
  await expect(page.getByTestId("bookmark-item")).toHaveCount(1);
  await page.getByTestId("bookmark-item").getByText("重要的一页").click();
  await expectPdfPage(page, 100);
  await page.getByPlaceholder("按名称筛选书签").fill("");
  await page.getByTestId("bookmark-item").filter({ hasText: "第 10–11 / 120 页" }).locator("button").first().click();
  await expectPdfPage(page, 10);
});

async function spanBox(n: number, text: string) {
  const span = page.locator(`[data-testid=pdf-page-${n}] .textLayer span`).filter({ hasText: text }).first();
  await expect(span).toBeVisible();
  return (await span.boundingBox())!;
}

test("选中句子高亮，缩放和旋转后仍定位在原文上", async () => {
  await gotoPdfPage(page, 42);
  const box = await spanBox(42, "琉璃灯盏");
  await dragSelect(page, { x: box.x + 2, y: box.y + box.height / 2 }, { x: box.x + box.width - 2, y: box.y + box.height / 2 });
  await expect(page.getByTestId("selection-menu")).toBeVisible();
  await page.getByRole("button", { name: "黄色高亮" }).click();
  const hl = page.locator("[data-testid=pdf-page-42] .pdf-hl-layer > div.hl-yellow");
  await expect(hl).toHaveCount(1);
  expect(overlaps((await hl.boundingBox())!, box)).toBe(true);

  // 放大两档
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("button", { name: "增大缩放" }).click();
  await page.getByRole("button", { name: "增大缩放" }).click();
  await expect(page.getByTestId("zoom-value")).toHaveText("120%");
  await gotoPdfPage(page, 42);
  const zoomed = await spanBox(42, "琉璃灯盏");
  await expect(hl).toHaveCount(1);
  const hlZoomed = (await hl.boundingBox())!;
  expect(overlaps(hlZoomed, zoomed)).toBe(true);
  expect(hlZoomed.width).toBeGreaterThan(box.width * 0.9);

  // 旋转 90°
  await page.getByRole("button", { name: /旋转页面/ }).click();
  await gotoPdfPage(page, 42);
  const rotated = await spanBox(42, "琉璃灯盏");
  await expect(hl).toHaveCount(1);
  expect(overlaps((await hl.boundingBox())!, rotated)).toBe(true);
  // 恢复
  await page.getByRole("button", { name: /旋转页面/ }).click();
  await page.getByRole("button", { name: /旋转页面/ }).click();
  await page.getByRole("button", { name: /旋转页面/ }).click();
  await page.getByRole("button", { name: "减小缩放" }).click();
  await page.getByRole("button", { name: "减小缩放" }).click();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);
});

test("多行选区与跨页选区：保存为同组标注，重开后仍在", async () => {
  await gotoPdfPage(page, 20);
  const a = await spanBox(20, "（20-6）");
  const b = await spanBox(21, "（21-1）");
  await dragSelect(page, { x: a.x + 2, y: a.y + a.height / 2 }, { x: b.x + b.width - 2, y: b.y + b.height / 2 });
  await expect(page.getByTestId("selection-menu")).toBeVisible();
  await page.getByRole("button", { name: "绿色高亮" }).click();
  await expect(page.locator("[data-testid=pdf-page-20] .hl-green").first()).toBeVisible();
  await expect(page.locator("[data-testid=pdf-page-21] .hl-green").first()).toBeVisible();

  const anns = await apiGet<{ locator: { page: number; rects: number[][] }; group_id: string | null; color: string }[]>(
    page,
    `/api/v1/books/${bookId}/annotations`,
  );
  const green = anns.filter((x) => x.color === "green");
  expect(green.map((x) => x.locator.page).sort()).toEqual([20, 21]);
  expect(green[0].group_id).toBeTruthy();
  expect(green[0].group_id).toBe(green[1].group_id);
  expect(green.find((x) => x.locator.page === 20)!.locator.rects.length).toBeGreaterThanOrEqual(2); // 多行

  await page.reload();
  await gotoPdfPage(page, 20);
  await expect(page.locator("[data-testid=pdf-page-20] .hl-green").first()).toBeVisible();
});

test("选段写笔记：自动保存，重开后保留；删除标注时笔记保留", async () => {
  await gotoPdfPage(page, 30);
  const box = await spanBox(30, "（30-2）");
  await dragSelect(page, { x: box.x + 4, y: box.y + box.height / 2 }, { x: box.x + box.width - 2, y: box.y + box.height / 2 });
  await page.getByRole("button", { name: "写笔记" }).click();
  const card = page.getByTestId("note-card").last();
  await card.getByLabel("笔记内容").fill("第三十页的读书笔记");
  await expect(card.getByTestId("note-status")).toHaveText("已保存");
  await page.reload();
  const saved = page.getByTestId("note-card").filter({ hasText: "（30-2）" });
  await expect(saved.getByLabel("笔记内容")).toHaveValue("第三十页的读书笔记");

  // 点击笔记引用跳转
  await gotoPdfPage(page, 1);
  await saved.getByTitle("跳转到原文").click();
  await expectPdfPage(page, 30);

  // 点击高亮 → 删除标注
  const hl = page.locator("[data-testid=pdf-page-30] .pdf-hl-layer > div").first();
  const hb = (await hl.boundingBox())!;
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await expect(page.getByTestId("annotation-menu")).toBeVisible();
  await page.getByTestId("annotation-menu").getByRole("button", { name: "删除" }).click();
  await expect(page.locator("[data-testid=pdf-page-30] .pdf-hl-layer > div")).toHaveCount(0);
  await expect(page.getByTestId("note-card").filter({ hasText: "（30-2）" })).toBeVisible();
});

test("整书笔记与当前位置笔记", async () => {
  await page.getByRole("button", { name: "整书" }).click();
  const card = page.getByTestId("note-card").last();
  await expect(card).toContainText("整书笔记");
  await card.getByLabel("笔记内容").fill("这本书总体不错");
  await expect(card.getByTestId("note-status")).toHaveText("已保存");
});

test("搜索正文、我的笔记、我的标注，并可返回跳转前位置", async () => {
  await gotoPdfPage(page, 5);
  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByLabel("搜索关键词").fill("琉璃灯盏");
  await page.getByLabel("搜索关键词").press("Enter");
  const hit = page.getByTestId("search-hit").first();
  await expect(hit).toContainText("第 42 页");
  await hit.click();
  await expectPdfPage(page, 42);
  await expect(page.locator("[data-testid=pdf-page-42] .hl-flash")).toHaveCount(1);
  await page.getByTestId("jump-back").click();
  await expectPdfPage(page, 5);

  await page.getByRole("tab", { name: "我的笔记" }).click();
  await page.getByLabel("搜索关键词").fill("三十页");
  await page.getByLabel("搜索关键词").press("Enter");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await page.getByRole("tab", { name: "我的标注" }).click();
  await page.getByLabel("搜索关键词").fill("琉璃");
  await page.getByLabel("搜索关键词").press("Enter");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await page.getByTestId("search-hit").click();
  await expectPdfPage(page, 42);
});

test("主题切换与 PDF 暖色/暗色显示", async () => {
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("radio", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await expect(page.getByTestId("pdf-scroll")).toHaveClass(/pdf-filter-dark/);
  await page.getByRole("button", { name: "原稿" }).click();
  await page.getByRole("radio", { name: "暖黄" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  // 偏好保存在服务端
  const me = await apiGet<{ preferences: { theme: string } }>(page, "/api/v1/users/me");
  expect(me.preferences.theme).toBe("sepia");
  await page.getByRole("radio", { name: "亮色" }).click();
  await page.keyboard.press("Escape");
});
