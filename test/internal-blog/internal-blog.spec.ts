import { expect, test } from "@playwright/test";
import { authViaApi } from "../e2e/helpers.ts";

test("internal blog is auth-gated, reachable from Help, URL-backed, and complete", async ({ page }) => {
  await page.goto("/blog");
  await expect(page.getByTestId("blog-view")).toHaveCount(0);

  await authViaApi(page, "field-notes-reader@example.invalid");

  const help = page.getByTestId("help-menu-trigger");
  const account = page.getByTestId("account-menu-trigger");
  await expect(help).toBeVisible();
  const [helpBox, accountBox] = await Promise.all([help.boundingBox(), account.boundingBox()]);
  expect(helpBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(accountBox!.y + 1);

  await help.click();
  const blogLink = page.getByTestId("open-blog");
  await expect(blogLink).toHaveAttribute("href", "/blog");
  await expect(blogLink).toHaveAttribute("target", "_blank");

  await page.goto("/blog");
  await expect(page.getByTestId("blog-view")).toBeVisible();
  await expect(page.getByTestId("blog-note-list").locator("a")).toHaveCount(9);
  await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  await expect(page.getByTestId("top-header")).toHaveCount(0);

  await page.getByTestId("blog-note-semantic-completion-not-eof").click();
  await expect(page).toHaveURL(/\/blog\/semantic-completion-not-eof$/);
  await expect(page.getByTestId("blog-note-detail")).toBeVisible();
  await expect(page.getByTestId("blog-note-detail").locator("ol > li")).toHaveCount(4);

  await page.getByTestId("blog-back").click();
  await expect(page).toHaveURL(/\/blog$/);
  await expect(page.getByTestId("blog-note-list")).toBeVisible();

  await page.goto("/blog/not-a-real-note");
  await expect(page.getByTestId("blog-note-missing")).toBeVisible();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
});

test("the notes page offers exactly one way back into the app", async ({ page }) => {
  await authViaApi(page, "field-notes-mobile@example.invalid");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/blog");
  await expect(page.getByTestId("blog-view")).toBeVisible();

  await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  await page.getByTestId("blog-exit").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("top-header")).toBeVisible();
});
