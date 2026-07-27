import { expect, type Page } from "@playwright/test";

let userSeq = 0;
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}_${Date.now()}_${userSeq++}_${Math.random().toString(36).slice(2, 8)}@test.dev`;
}

export async function signup(page: Page): Promise<void> {
  await authViaApi(page, uniqueEmail());
}

export async function authViaApi(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(async (em) => {
    const body = JSON.stringify({ email: em, password: "password123" });
    const headers = { "content-type": "application/json" };
    let r = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!r.ok) r = await fetch("/api/auth/signup", { method: "POST", headers, body });
    const j = (await r.json()) as { token: string };
    localStorage.setItem("agentweb.token", j.token);
  }, email);
  await page.reload();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("account-menu-trigger").click();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
}

export async function signupViaUi(page: Page): Promise<void> {
  await page.goto("/");
  const toggle = page.getByTestId("toggle-mode");
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  } else {
    await page.getByRole("button", { name: "Sign up", exact: true }).first().click();
    await expect(page.getByTestId("auth-submit")).toBeVisible();
  }
  await page.getByTestId("email").fill(uniqueEmail());
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

export async function createSession(
  page: Page,
  opts: { title: string; approval: "never" | "on-request" | "untrusted"; sandbox?: string },
): Promise<void> {
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await page.getByTestId("ns-title").fill(opts.title);
  await openSessionAdvanced(page);
  await page.getByTestId("ns-model").selectOption("mock::mock-coder");
  await page.getByTestId("ns-sandbox").selectOption(opts.sandbox ?? "workspace-write");
  await page.getByTestId("ns-approval").selectOption(opts.approval);
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();
}

export async function openSessionAdvanced(page: Page): Promise<void> {
  const advanced = page.getByTestId("ns-advanced");
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId("ns-advanced-toggle").click();
  }
  await expect(advanced).toHaveJSProperty("open", true);
}
