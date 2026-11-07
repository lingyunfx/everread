import { expect, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES = path.resolve(here, "../../samples");
export const GENERATED = path.join(SAMPLES, "generated");

export const USERS = {
  alice: { email: "alice@everread.test", password: process.env.E2E_ALICE_PASSWORD ?? "alice-password-1" },
  bob: { email: "bob@everread.test", password: process.env.E2E_BOB_PASSWORD ?? "bob-password-1" },
};

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function newUserPage(browser: Browser, who: keyof typeof USERS, opts: Parameters<Browser["newContext"]>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await login(page, USERS[who].email, USERS[who].password);
  return page;
}

/** 在书架上传文件，等待解析结果；返回上传项的最终文字 */
export async function upload(page: Page, file: string, expectText: string | RegExp = "已加入书架") {
  await page.goto("/");
  await page.getByTestId("upload-input").setInputFiles(file);
  const item = page.getByTestId("upload-item").filter({ hasText: path.basename(file) }).first();
  await expect(item).toContainText(expectText, { timeout: 60_000 });
  return item;
}

export async function token(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("everread:token") ?? "");
}

/** 通过 API 取书籍列表，按书名找到 ID */
export async function findBookId(page: Page, titlePart: string): Promise<string> {
  const t = await token(page);
  const res = await page.request.get("/api/v1/shelf", { headers: { Authorization: `Bearer ${t}` } });
  const items = (await res.json()) as { book: { id: string; title: string } }[];
  const hit = items.find((i) => i.book.title.includes(titlePart));
  if (!hit) throw new Error(`书架上没有：${titlePart}`);
  return hit.book.id;
}

export async function apiGet<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url, { headers: { Authorization: `Bearer ${await token(page)}` } });
  return (await res.json()) as T;
}

/** PDF 是翻页式单/双页：在底部页码框输入页码跳转 */
export async function gotoPdfPage(page: Page, n: number) {
  const input = page.getByTestId("page-jump");
  await input.fill(String(n));
  await input.press("Enter");
  await expectPdfPage(page, n);
}

/** 位置标签包含第 n 页（双页时为“第 a–b / 总 页”） */
export async function expectPdfPage(page: Page, n: number) {
  await expect(page.getByTestId("location-label")).toHaveText(new RegExp(`^第 (${n}|${n}–\\d+|\\d+–${n}) / `));
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId("sync-status")).toContainText("已保存", { timeout: 20_000 });
}

/** 拖动鼠标选中一段区域 */
export async function dragSelect(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

export function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
