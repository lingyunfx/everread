import { expect, test, type Page } from "@playwright/test";
import { apiGet, expectPdfPage, findBookId, gotoPdfPage, newUserPage, token } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await newUserPage(browser, "alice");
});

async function setLayout(p: Page, label: "单页" | "双页") {
  await p.getByRole("button", { name: "阅读设置" }).click();
  await p.getByRole("radio", { name: label }).click();
  await p.keyboard.press("Escape");
  await p.mouse.move(0, 0);
}

test("上传入口在书架工具栏，点开为弹窗", async () => {
  await page.goto("/");
  await page.getByTestId("upload-button").click();
  const dialog = page.getByRole("dialog", { name: "上传书籍" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("点击选择文件");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("书籍文件不以 application/pdf 返回，避免下载工具拦截", async () => {
  const id = await findBookId(page, "永读示例文本书");
  const res = await page.request.get(`/api/v1/books/${id}/file`, {
    headers: { Authorization: `Bearer ${await token(page)}`, Range: "bytes=0-9" },
  });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-type"]).toBe("application/x-everread-book");
  expect(res.headers()["content-disposition"]).toBeUndefined();
});

test("PDF 默认双页：封面单独，之后两两成对；点击两侧与方向键翻页", async () => {
  const id = await findBookId(page, "永读示例文本书");
  await page.goto(`/read/${id}`);
  const me = await apiGet<{ preferences: { page_layout: string } }>(page, "/api/v1/users/me");
  expect(me.preferences.page_layout).toBe("double");

  await gotoPdfPage(page, 1);
  await expect(page.getByTestId("location-label")).toHaveText("第 1 / 120 页");
  const stage = page.getByTestId("pdf-scroll");
  await expect(stage).toHaveAttribute("data-spread", "1");

  // 点击右侧区域 → 下一组 2-3
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(stage).toHaveAttribute("data-spread", "2,3");
  await expect(page.getByTestId("location-label")).toHaveText("第 2–3 / 120 页");
  await expect(page.getByTestId("pdf-page-2")).toBeVisible();
  await expect(page.getByTestId("pdf-page-3")).toBeVisible();

  // 方向键
  await page.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("data-spread", "4,5");
  await page.keyboard.press("ArrowLeft");
  await expect(stage).toHaveAttribute("data-spread", "2,3");
  // 点击左侧区域
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
  await expect(stage).toHaveAttribute("data-spread", "1");
  // 滚轮
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(stage).toHaveAttribute("data-spread", "2,3");

  // 最后一页
  await gotoPdfPage(page, 120);
  await expect(stage).toHaveAttribute("data-spread", "120");
});

test("切换为单页后每次一页，偏好保存到账号；切回双页保持当前位置", async () => {
  await gotoPdfPage(page, 9);
  await setLayout(page, "单页");
  const stage = page.getByTestId("pdf-scroll");
  await expect(stage).toHaveAttribute("data-spread", /^(8|9)$/);
  const me = await apiGet<{ preferences: { page_layout: string } }>(page, "/api/v1/users/me");
  expect(me.preferences.page_layout).toBe("single");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("location-label")).toHaveText(/^第 (9|10) \/ 120 页$/);
  await setLayout(page, "双页");
  await expect(stage).toHaveAttribute("data-spread", /^(8,9|10,11)$/);
});

test("TXT 双页：两栏排版，翻页与章节衔接", async () => {
  const id = await findBookId(page, "示例UTF8");
  await page.goto(`/read/${id}`);
  await page.getByRole("button", { name: "切换左侧栏" }).click();
  await page.getByRole("tab", { name: "目录" }).click();
  await page.getByRole("button", { name: "第2章 起风了" }).click();
  await page.getByRole("button", { name: "切换左侧栏" }).click();
  await expect(page.getByTestId("location-label")).toContainText("第2章");
  const view = page.getByTestId("txt-scroll");
  await expect(view).toHaveAttribute("data-page", /:0$/);
  const content = page.locator(".txt-body");
  await expect(content).toHaveCSS("column-count", "2");

  // 一直往后翻，跨过第 2 章末尾进入第 3 章
  for (let i = 0; i < 15; i++) {
    const label = await page.getByTestId("location-label").textContent();
    if (label?.includes("第3章")) break;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId("location-label")).toContainText("第3章");
  // 往前翻一页回到第 2 章末尾
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("location-label")).toContainText("第2章");

  await setLayout(page, "单页");
  await expect(content).toHaveCSS("column-count", "1");
  await expect(page.getByTestId("location-label")).toContainText("第2章");
  await setLayout(page, "双页");
});

test("EPUB 双页：左右两页并排", async () => {
  const id = await findBookId(page, "永读示例 EPUB");
  await page.goto(`/read/${id}`);
  const host = page.getByTestId("epub-host");
  await expect(host.locator("iframe").first()).toBeAttached();
  await expect(page.getByTestId("location-label")).not.toHaveText("加载中…");
  // 双页时可见区域里同时有左右两栏正文
  const frame = (await host.locator("iframe").first().elementHandle())!;
  const f = (await frame.contentFrame())!;
  const hostBox = (await host.boundingBox())!;
  const frameBox = (await frame.boundingBox())!;
  const lefts = await f.evaluate(
    ([dx, w]) =>
      Array.from(document.querySelectorAll("p"))
        .map((p) => p.getBoundingClientRect().left + dx)
        .filter((x) => x >= 0 && x < w),
    [frameBox.x - hostBox.x, hostBox.width] as const,
  );
  const columns = new Set(lefts.map((x) => Math.round(x / 50)));
  expect(columns.size).toBeGreaterThanOrEqual(2);
  // 点击右侧翻页
  const before = await page.getByTestId("location-label").textContent();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByTestId("location-label")).not.toHaveText(before ?? "");
});

test("窄窗口自动按单页显示", async ({ browser }) => {
  const p = await newUserPage(browser, "alice", { viewport: { width: 700, height: 900 } });
  const id = await findBookId(p, "永读示例文本书");
  await p.goto(`/read/${id}`);
  await gotoPdfPage(p, 6);
  await expect(p.getByTestId("pdf-scroll")).toHaveAttribute("data-spread", "6");
  await expectPdfPage(p, 6);
  await p.context().close();
});
