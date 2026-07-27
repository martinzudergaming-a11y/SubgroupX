import { test, expect, type Page } from "@playwright/test";

async function signup(page: Page) {
  await page.goto("/");
  await page.getByTestId("toggle-mode").click();
  await page.getByTestId("email").fill(`e2e_stop_${Date.now()}@test.dev`);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

test("real model: Stop halts a turn even when pressed before the model stream starts", async ({ page }) => {
  await signup(page);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();

  const operatorOption = page.locator('[data-testid="ns-model"] option[value^="0AI-jail::"]').first();
  test.skip((await operatorOption.count()) === 0, "operator default model is not configured in data/secrets.json");

  const value = await operatorOption.getAttribute("value");
  await page.getByTestId("ns-title").fill("stop-real");
  await page.getByTestId("ns-model").selectOption(value!);
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();

  await page.getByTestId("composer").fill("Write a detailed 500-word essay about the history of mathematics. Be verbose and do not stop early.");
  await page.getByTestId("send").click();

  await page.getByTestId("interrupt").click({ timeout: 15_000 });

  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("interrupt")).toHaveCount(0);

  await page.waitForTimeout(2_000);
  const assistants = page.getByTestId("msg-assistant");
  const n = await assistants.count();
  const longest = n === 0 ? 0 : Math.max(...(await assistants.allInnerTexts()).map((t) => t.length));
  expect(longest).toBeLessThan(500);
});
