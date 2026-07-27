import { test, expect } from "@playwright/test";
import { signup, createSession, openSettings } from "./helpers.ts";

test("quiet folds silent calls into a breakdown line; all folds everything; off none", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Tool fold", approval: "never" });

  await page.getByTestId("composer").fill("/burst");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Done", { timeout: 20000 });

  const group = page.getByTestId("tool-group");
  await expect(group).toHaveText(/Ran 2 commands, listed 1 director/);
  await expect(page.getByTestId("tool-bash")).toHaveCount(1);
  await expect(page.getByTestId("tool-write_file")).toHaveCount(1);
  await expect(page.getByTestId("tool-list_files")).toHaveCount(0);

  await group.click();
  await expect(page.getByTestId("tool-bash")).toHaveCount(3);
  await expect(page.getByTestId("tool-list_files")).toHaveCount(1);
  await page.getByTestId("tool-group-collapse").click();
  await expect(page.getByTestId("tool-bash")).toHaveCount(1);

  await openSettings(page);
  await page.getByTestId("tool-fold-all").click();
  await page.getByRole("button", { name: /Done|完成/ }).first().click().catch(() => {});
  await page.goBack().catch(() => {});
  await page.getByText("Tool fold").first().click();
  await expect(page.getByTestId("tool-group")).toHaveText(/Ran 3 commands, listed 1 directory, wrote 1 file/);
  await expect(page.getByTestId("tool-bash")).toHaveCount(0);

  await openSettings(page);
  await page.getByTestId("tool-fold-off").click();
  await page.getByText("Tool fold").first().click();
  await expect(page.getByTestId("tool-group")).toHaveCount(0);
  await expect(page.getByTestId("tool-bash")).toHaveCount(3);

  await page.reload();
  await expect(page.getByTestId("tool-bash")).toHaveCount(3);
});

test("reasoning\u2192action chains fold across thinking interludes; expand replays them", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Steps fold", approval: "never" });

  await page.getByTestId("composer").fill("/steps");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Done", { timeout: 20000 });

  const group = page.getByTestId("tool-group");
  await expect(group).toHaveCount(1);
  await expect(group).toHaveText(/Ran 2 commands, listed 1 director/);
  await expect(page.getByTestId("tool-bash")).toHaveCount(0);
  await expect(page.getByTestId("tool-list_files")).toHaveCount(0);
  await expect(page.getByTestId("thinking-toggle")).toHaveCount(1);

  await group.click();
  await expect(page.getByTestId("tool-bash")).toHaveCount(2);
  await expect(page.getByTestId("tool-list_files")).toHaveCount(1);
  await expect(page.getByTestId("thinking-toggle")).toHaveCount(4);
  await page.getByTestId("tool-group-collapse").click();
  await expect(page.getByTestId("tool-bash")).toHaveCount(0);
});
