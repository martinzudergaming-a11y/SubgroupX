import { test, expect } from "@playwright/test";
import { signup, createSession } from "./helpers.ts";

test("a long unbroken base64 token wraps inside the sent user bubble", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Base64 wrap", approval: "never" });

  const token = "QmFzZTY0VG9rZW5XcmFwUHJvYmUx".repeat(43);
  expect(token).not.toMatch(/\s/);
  expect(Buffer.byteLength(token, "utf8")).toBeLessThan(2 * 1024);

  await page.getByTestId("composer").fill(token);
  await page.getByTestId("send").click();

  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble).toContainText(token.slice(0, 28));

  const geometry = await bubble.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    right: el.getBoundingClientRect().right,
    viewport: el.ownerDocument.documentElement.clientWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
});
