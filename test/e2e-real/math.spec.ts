import { test, expect, type Page } from "@playwright/test";

async function signup(page: Page) {
  await page.goto("/");
  await page.getByTestId("toggle-mode").click();
  await page.getByTestId("email").fill(`e2e_real_${Date.now()}@test.dev`);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

test("real model: \\(…\\) and \\[…\\] delimiters render as KaTeX, not raw text", async ({ page }) => {
  await signup(page);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();

  const operatorOption = page.locator('[data-testid="ns-model"] option[value^="0AI-jail::"]').first();
  const hasOperator = (await operatorOption.count()) > 0;
  test.skip(!hasOperator, "operator default model is not configured in data/secrets.json");

  const value = await operatorOption.getAttribute("value");
  await page.getByTestId("ns-title").fill("math-real");
  await page.getByTestId("ns-model").selectOption(value!);
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();

  const prompt = [
    "Output ONLY these three lines verbatim, no extra words, no code fences:",
    "Inline: \\(a^2+b^2=c^2\\)",
    "Display: \\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]",
    "Matrix: $$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$",
  ].join("\n");
  await page.getByTestId("composer").fill(prompt);
  await page.getByTestId("send").click();

  const assistant = page.getByTestId("msg-assistant").last();
  const katex = assistant.locator(".katex");
  await expect(katex.nth(2)).toBeVisible({ timeout: 90_000 });
  expect(await katex.count()).toBeGreaterThanOrEqual(3);

  const text = (await assistant.innerText()).trim();
  expect(text).not.toContain("\\(");
  expect(text).not.toContain("\\[");
  expect(text).not.toContain("\\sum");
});
