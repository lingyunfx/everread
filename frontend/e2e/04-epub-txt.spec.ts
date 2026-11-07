import { expect, test, type Frame, type Page } from "@playwright/test";
import path from "node:path";
import { GENERATED, apiGet, dragSelect, findBookId, newUserPage, upload, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await newUserPage(browser, "alice");
});

async function epubFrame(): Promise<Frame> {
  const handle = await page.locator("[data-testid=epub-host] iframe").first().elementHandle();
  const frame = await handle!.contentFrame();
  return frame!;
}

test("EPUB：渲染、翻页、主题与字号、位置恢复", async () => {
  await upload(page, path.join(GENERATED, "示例中文.epub"));
  const id = await findBookId(page, "永读示例 EPUB");
  await page.goto(`/read/${id}`);
  let frame = await epubFrame();
  await expect(frame.locator("h1")).toContainText("第1章");

  // 目录跳到第 3 章
  await page.getByRole("button", { name: "切换左侧栏" }).click();
  await page.getByRole("tab", { name: "目录" }).click();
  await page.getByRole("button", { name: "第3章 示例" }).click();
  await expect(page.getByTestId("location-label")).toContainText("第3章");
  await page.getByRole("button", { name: "下一页" }).click();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByTestId("location-label")).toContainText("%", { timeout: 30_000 });

  // 暗色主题：正文颜色跟随
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("radio", { name: "暗色" }).click();
  frame = await epubFrame();
  await expect
    .poll(async () => frame.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(27, 28, 31)");
  await page.getByRole("button", { name: "增大字号" }).click();
  await page.getByRole("button", { name: "增大字号" }).click();
  await expect(page.getByTestId("font-size-value")).toHaveText("20");
  await page.getByRole("radio", { name: "亮色" }).click();
  await page.keyboard.press("Escape");
  await waitSaved(page);
  const before = await apiGet<{ locator: { cfi: string } }>(page, `/api/v1/books/${id}/progress`);
  expect(before.locator.cfi).toMatch(/^epubcfi\(/);

  // 改字号后重开，仍回到同一章
  await page.reload();
  await expect(page.getByTestId("location-label")).toContainText("第3章");
});

test("EPUB：选段高亮、写笔记、正文搜索跳转", async () => {
  const frame = await epubFrame();
  // Playwright 在禁用脚本的沙箱 iframe 中按住鼠标拖动会卡住（其拖放检测需要在帧内执行脚本），
  // 这里直接在 iframe 内设置选区；epub.js 监听 selectionchange，走的是同一条选区处理流程。
  const host = (await page.getByTestId("epub-host").boundingBox())!;
  const frameBox = (await page.locator("[data-testid=epub-host] iframe").first().boundingBox())!;
  const picked = await frame.evaluate(
    ([dx, w]) => {
      // 分页排版下同一章的段落大多在其他页，挑出当前页上可见的一段
      const p = Array.from(document.querySelectorAll("p")).find((el) => {
        const r = el.getBoundingClientRect();
        return r.left + dx >= 0 && r.right + dx <= w && el.textContent!.includes("第3章");
      });
      if (!p) return null;
      const text = p.firstChild!;
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 12);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return range.toString();
    },
    [frameBox.x - host.x, host.width] as const,
  );
  expect(picked).toBeTruthy();
  await expect(page.getByTestId("selection-menu")).toBeVisible();
  await page.getByRole("button", { name: "写笔记" }).click();
  const card = page.getByTestId("note-card").last();
  await card.getByLabel("笔记内容").fill("EPUB 笔记");
  await expect(card.getByTestId("note-status")).toHaveText("已保存");
  await expect(frame.locator("body")).toBeAttached();
  await expect(page.locator("[data-testid=epub-host] svg g.ever-hl, [data-testid=epub-host] g.ever-hl").first()).toBeAttached();

  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByLabel("搜索关键词").fill("琉璃灯盏");
  await page.getByLabel("搜索关键词").press("Enter");
  const hit = page.getByTestId("search-hit").first();
  await expect(hit).toContainText("琉璃灯盏");
  await hit.click();
  const f2 = await epubFrame();
  await expect(f2.getByText("这里藏着一个特别的词：琉璃灯盏")).toBeVisible();
});

test("EPUB：书中脚本被清理且不会执行", async () => {
  await upload(page, path.join(GENERATED, "带脚本的书.epub"));
  const id = await findBookId(page, "带脚本的书");
  await page.goto(`/read/${id}`);
  const frame = await epubFrame();
  await expect(frame.locator("h1")).toContainText("第1章");
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked)).toBeUndefined();
  expect(await frame.locator("script").count()).toBe(0);
  expect(await frame.locator("img[src*='tracker']").count()).toBe(0);
});

test("TXT：GB18030 编码识别、段落定位、emoji 选段高亮", async () => {
  await upload(page, path.join(GENERATED, "示例GB18030.txt"));
  const id = await findBookId(page, "示例GB18030");
  await page.goto(`/read/${id}`);
  const p = page.locator("p[data-para='3']");
  await expect(p).toContainText("这是第1章的第3段");
  await expect(p).toContainText("😀");
  // 选中包含 emoji 的末尾部分
  const box = (await p.boundingBox())!;
  // 第二行是“合坐在窗边读一本书。😀”，从行首拖到 emoji 之后
  const y2 = box.y + box.height - 14;
  await dragSelect(page, { x: box.x + 1, y: y2 }, { x: box.x + 240, y: y2 });
  await page.getByRole("button", { name: "粉色高亮" }).click();
  await expect(page.locator("p[data-para='3'] mark.hl-pink")).toBeVisible();
  const anns = await apiGet<{ quote: string; locator: { para: number; offset: number; end: { para: number; offset: number } } }[]>(
    page,
    `/api/v1/books/${id}/annotations`,
  );
  const a = anns[0];
  expect(a.locator.para).toBe(3);
  // 码点偏移与原文一致：按偏移切出来的文字就是引用原文
  const content = await apiGet<{ paragraphs: string[] }>(page, `/api/v1/books/${id}/txt`);
  const chars = Array.from(content.paragraphs[3]);
  expect(chars.slice(a.locator.offset, a.locator.end.offset).join("")).toBe(a.quote);
  await page.reload();
  await expect(page.locator("p[data-para='3'] mark.hl-pink")).toHaveText(a.quote);
});

test("TXT：长文本目录跳转、搜索、字号变化后保持位置", async () => {
  await upload(page, path.join(GENERATED, "示例UTF8.txt"));
  const id = await findBookId(page, "示例UTF8");
  await page.goto(`/read/${id}`);
  await page.getByRole("button", { name: "切换左侧栏" }).click();
  await page.getByRole("tab", { name: "目录" }).click();
  await page.getByRole("button", { name: "第6章 起风了" }).click();
  await expect(page.getByTestId("location-label")).toContainText("第6章");
  await waitSaved(page);

  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("button", { name: "增大字号" }).click();
  await page.getByRole("button", { name: "增大字号" }).click();
  await page.getByRole("button", { name: "增大字号" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("location-label")).toContainText("第6章");

  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByLabel("搜索关键词").fill("琉璃灯盏");
  await page.getByLabel("搜索关键词").press("Enter");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await page.getByTestId("search-hit").click();
  await expect(page.getByTestId("location-label")).toContainText("第7章");
  await expect(page.locator("mark.hl-flash")).toHaveText("琉璃灯盏");
  await page.getByTestId("jump-back").click();
  await expect(page.getByTestId("location-label")).toContainText("第6章");

  await page.reload();
  await expect(page.getByTestId("location-label")).toContainText("第6章");
});
