import { devices, expect, test } from "@playwright/test";
import path from "node:path";
import { GENERATED, SAMPLES, findBookId, expectPdfPage, gotoPdfPage, newUserPage, upload, waitSaved } from "./helpers";

test("多设备同时阅读：进度冲突时提示选择", async ({ browser }) => {
  const a = await newUserPage(browser, "bob");
  await upload(a, path.join(GENERATED, "示例文本书.pdf"));
  const id = await findBookId(a, "永读示例文本书");
  const b = await newUserPage(browser, "bob");

  await a.goto(`/read/${id}`);
  await gotoPdfPage(a, 5);
  await waitSaved(a);
  // 设备 B 打开时读到第 5 页
  await b.goto(`/read/${id}`);
  await expectPdfPage(b, 5);
  // 设备 A 继续读到第 30 页
  await gotoPdfPage(a, 30);
  await waitSaved(a);
  // 设备 B 翻到第 8 页：基于旧版本保存，触发冲突
  await gotoPdfPage(b, 8);
  await expect(b.getByTestId("progress-conflict")).toContainText("第 30 / 120 页");
  await b.getByRole("button", { name: "跳到该位置" }).click();
  await expectPdfPage(b, 30);
  await expect(b.getByTestId("progress-conflict")).toHaveCount(0);

  // 再次冲突时选择保留本机
  await gotoPdfPage(a, 50);
  await waitSaved(a);
  await gotoPdfPage(b, 33);
  await expect(b.getByTestId("progress-conflict")).toBeVisible();
  await b.getByRole("button", { name: "保留本机位置" }).click();
  await waitSaved(b);
  await a.reload();
  await expectPdfPage(a, 33);
  await a.context().close();
  await b.context().close();
});

test("断网时本机暂存进度，恢复网络后自动同步", async ({ browser }) => {
  const p = await newUserPage(browser, "bob");
  const id = await findBookId(p, "永读示例文本书");
  await p.goto(`/read/${id}`);
  await expect(p.getByTestId("location-label")).toContainText("/ 120 页");
  await p.context().setOffline(true);
  await gotoPdfPage(p, 12);
  await expect(p.getByTestId("sync-status")).toContainText("未同步", { timeout: 20_000 });
  const pending = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("everread:pending-progress")));
  expect(pending.length).toBe(1);
  await p.context().setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitSaved(p);
  await p.reload();
  await expectPdfPage(p, 12);
  await p.context().close();
});

test("手机浏览器：书架可用，笔记栏为抽屉", async ({ browser }) => {
  const p = await newUserPage(browser, "bob", { ...devices["Pixel 7"] });
  await expect(p.getByTestId("shelf-card").first()).toBeVisible();
  const id = await findBookId(p, "永读示例文本书");
  await p.goto(`/read/${id}`);
  await expect(p.getByTestId("location-label")).toContainText("/ 120 页");
  // 手机默认不展开侧栏，正文占满宽度
  await expect(p.getByTestId("notes-panel")).toHaveCount(0);
  await p.getByRole("button", { name: "切换笔记栏" }).click();
  const panel = p.getByTestId("notes-panel");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(p.viewportSize()!.width);
  await p.mouse.click(10, 300); // 点遮罩关闭
  await expect(panel).toHaveCount(0);
  await p.context().close();
});

test("用户提供的真实 PDF：上传、渲染与中文正文搜索", async ({ browser }) => {
  test.setTimeout(300_000);
  const p = await newUserPage(browser, "bob");
  const files = ["GitHub入门与实践 .pdf", "Nginx教程从入门到精通.pdf", "Flask-Web开发：基于Python的Web应用开发实战.pdf"];
  for (const f of files) await upload(p, path.join(SAMPLES, f));

  const id = await findBookId(p, "Nginx");
  await p.goto(`/read/${id}`);
  await expect(p.getByTestId("location-label")).toContainText("/ 201 页");
  await expect(p.locator("[data-testid=pdf-page-1] canvas")).toBeVisible();
  // 渲染出非空白画面
  await expect
    .poll(async () =>
      p.locator("[data-testid=pdf-page-1] canvas").evaluate((c: HTMLCanvasElement) => {
        const ctx = c.getContext("2d")!;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4 * 50) if (d[i] < 128) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(50);
  await p.getByRole("button", { name: "搜索" }).click();
  await p.getByLabel("搜索关键词").fill("反向代理");
  await p.getByLabel("搜索关键词").press("Enter");
  await expect(p.getByTestId("search-hit").first()).toBeVisible({ timeout: 120_000 });
  await p.getByTestId("search-hit").first().click();
  await expect(p.locator(".hl-flash").first()).toBeAttached();

  const gid = await findBookId(p, "GitHub");
  await p.goto(`/read/${gid}`);
  await expect(p.getByTestId("location-label")).toContainText("/ 286 页");
  await gotoPdfPage(p, 150);
  await expect(p.locator("[data-testid=pdf-page-150] .textLayer span").first()).toBeAttached();
  await p.context().close();
});
