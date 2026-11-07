import { expect, test } from "@playwright/test";
import { USERS, login } from "./helpers";

test("未登录访问会跳转到登录页，且没有注册入口", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("不开放注册")).toBeVisible();
  await expect(page.getByRole("link", { name: /注册/ })).toHaveCount(0);
  // 后端也没有注册接口
  const res = await page.request.post("/api/v1/users/signup", { data: { email: "x@y.com", password: "12345678" } });
  expect([404, 405]).toContain(res.status());
  // 匿名无法读取图书馆
  expect((await page.request.get("/api/v1/library")).status()).toBe(401);
});

test("密码错误时提示", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(USERS.alice.email);
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("邮箱或密码错误")).toBeVisible();
});

test("临时密码首次登录必须修改密码", async ({ page }) => {
  const temp = process.env.E2E_TEMP_PASSWORD;
  test.skip(!temp, "未提供 E2E_TEMP_PASSWORD");
  await login(page, "carol@everread.test", temp!);
  await expect(page).toHaveURL(/change-password/);
  // 修改前访问书架会被拦回
  await page.goto("/");
  await expect(page).toHaveURL(/change-password/);
  await page.getByLabel("当前密码").fill(temp!);
  await page.getByLabel("新密码（至少 8 位）").fill("carol-new-password");
  await page.getByLabel("确认新密码").fill("carol-new-password");
  await page.getByRole("button", { name: "修改密码" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("书架还是空的")).toBeVisible();
});

test("退出登录后清理本地缓存", async ({ page }) => {
  await login(page, USERS.bob.email, USERS.bob.password);
  await page.evaluate(() => localStorage.setItem("everread:pending-progress:x:y", "{}"));
  await page.getByTitle(/退出/).click();
  await expect(page).toHaveURL(/\/login/);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("everread:")));
  expect(keys).toEqual([]);
});
