import { test, expect, type Page } from "@playwright/test";

import { signup, createSession as createSessionShared } from "./helpers.ts";

async function createSession(page: Page, title: string) {
  await createSessionShared(page, { title, approval: "never" });
}

async function sendMessage(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Mock Coder");
  await expect(page.getByTestId("send")).toBeVisible();
}

async function fillComposer(page: Page, text: string) {
  const composer = page.getByTestId("composer");
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
}

test("edit-resend: happy path — edit message A, resend as A', B and reply disappear, fresh reply arrives", async ({ page }) => {
  await signup(page);
  await createSession(page, "Edit-resend happy path");

  const textA = "hello from message A";
  await sendMessage(page, textA);
  await expect(page.getByTestId("msg-user").first()).toContainText(textA);

  const textB = "hello from message B";
  await sendMessage(page, textB);

  await expect(page.getByTestId("msg-user")).toHaveCount(2);
  await expect(page.getByTestId("msg-assistant")).toHaveCount(2);

  await page.getByTestId("edit-message").first().click();

  await expect(page.getByTestId("editing-banner")).toBeVisible();
  await expect(page.getByTestId("cancel-edit")).toBeVisible();
  await expect(page.getByTestId("resend")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveValue(textA);

  const textAPrime = "hello from message A PRIME";
  await fillComposer(page, textAPrime);
  await expect(page.getByTestId("editing-banner")).toBeVisible();
  const resendBtn = page.getByTestId("resend");
  await expect(resendBtn).toBeVisible();
  await expect(resendBtn).not.toBeDisabled();
  await resendBtn.click();

  await expect(page.getByTestId("editing-banner")).toHaveCount(0);

  await expect(page.getByTestId("send")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("msg-user")).toHaveCount(1);
  await expect(page.getByTestId("msg-user").first()).toContainText(textAPrime);
  await expect(page.getByTestId("msg-assistant")).toHaveCount(1);
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Mock Coder");

  await expect(page.getByText(textB, { exact: false })).toHaveCount(0);

  await expect(page.getByTestId("editing-banner")).toHaveCount(0);
});

test("edit-resend: cancel restores composer and does not modify the timeline", async ({ page }) => {
  await signup(page);
  await createSession(page, "Edit-resend cancel");

  const textA = "cancel-test message A";
  const textB = "cancel-test message B";
  await sendMessage(page, textA);
  await sendMessage(page, textB);

  const draft = "in-progress draft text";
  await fillComposer(page, draft);

  await page.getByTestId("edit-message").first().click();

  await expect(page.getByTestId("editing-banner")).toBeVisible();
  await expect(page.getByTestId("resend")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveValue(textA);

  await page.getByTestId("cancel-edit").click();

  await expect(page.getByTestId("editing-banner")).toHaveCount(0);
  await expect(page.getByTestId("send")).toBeVisible();

  await expect(page.getByTestId("composer")).toHaveValue(draft);

  await expect(page.getByTestId("msg-user")).toHaveCount(2);
  await expect(page.getByTestId("msg-assistant")).toHaveCount(2);
  await expect(page.getByTestId("msg-user").first()).toContainText(textA);
  await expect(page.getByTestId("msg-user").last()).toContainText(textB);
});

test("edit-resend: Escape key cancels editing mode", async ({ page }) => {
  await signup(page);
  await createSession(page, "Edit-resend escape");

  const textA = "escape-test message A";
  await sendMessage(page, textA);

  await page.getByTestId("edit-message").first().click();
  await expect(page.getByTestId("editing-banner")).toBeVisible();
  await expect(page.getByTestId("resend")).toBeVisible();

  await page.getByTestId("composer").press("Escape");

  await expect(page.getByTestId("editing-banner")).toHaveCount(0);
  await expect(page.getByTestId("send")).toBeVisible();
  await expect(page.getByTestId("msg-user").first()).toContainText(textA);
});

test("edit-resend: pencil is absent while a turn is running", async ({ page }) => {
  await signup(page);
  await createSession(page, "Edit-resend gating");

  await page.getByTestId("composer").fill("/bash sleep 5");
  await page.getByTestId("send").click();

  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await expect(page.getByTestId("edit-message")).toHaveCount(0);

  await page.getByTestId("interrupt").click();
  await expect(page.getByTestId("send")).toBeVisible();
});

test("edit-resend: Enter key in editing mode submits the rewind", async ({ page }) => {
  await signup(page);
  await createSession(page, "Edit-resend enter-key");

  const textA = "enter-key message A";
  await sendMessage(page, textA);

  await page.getByTestId("edit-message").first().click();
  await expect(page.getByTestId("editing-banner")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveValue(textA);

  const textAPrime = "enter-key A PRIME via Enter";
  await fillComposer(page, textAPrime);
  await page.getByTestId("composer").press("Enter");

  await expect(page.getByTestId("send")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("msg-user")).toHaveCount(1);
  await expect(page.getByTestId("msg-user").first()).toContainText(textAPrime);
  await expect(page.getByTestId("msg-assistant")).toHaveCount(1);
  await expect(page.getByTestId("editing-banner")).toHaveCount(0);
});
