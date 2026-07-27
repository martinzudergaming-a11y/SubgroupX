import { test, expect } from "@playwright/test";
import { signup, createSession } from "./helpers.ts";

test("model-emitted LaTeX renders: bare env, single-line $$, currency, table pipes, \\label", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Math render", approval: "never" });

  const payload = [
    "Einstein wrote \\(E=mc^2\\), and in display form:",
    "",
    "\\begin{align}",
    "a &= b + c \\\\",
    "d &= e",
    "\\end{align}",
    "",
    "$$\\int_0^1 x^2 \\, dx = \\frac{1}{3} \\label{eq:third}$$",
    "",
    "打折后$100,原价$200,很划算。",
    "",
    "| cond | value |",
    "| --- | --- |",
    "| $P(A|B)$ | 0.5 |",
  ].join("\n");

  await page.getByTestId("composer").fill(`/say ${payload}`);
  await page.getByTestId("send").click();

  const reply = page.getByTestId("msg-assistant").last();
  await expect(reply).toContainText("Einstein wrote");

  await expect(reply.locator(".katex").first()).toBeVisible();
  await expect(reply.locator(".katex-display")).toHaveCount(2);
  await expect(reply.locator(".katex-error")).toHaveCount(0);
  await expect(reply.locator("p", { hasText: "\\begin{align}" })).toHaveCount(0);
  await expect(reply.locator(".katex-display", { hasText: "label" })).toHaveCount(0);
  await expect(reply).toContainText("打折后$100,原价$200");
  await expect(reply.locator("td .katex").first()).toBeVisible();
  await expect(reply).not.toContainText("$P(A");
});
