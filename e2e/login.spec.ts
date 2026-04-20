import { test, expect } from "@playwright/test";

test.describe("Login Page", () => {
  test("renders login form with all elements", async ({ page }) => {
    await page.goto("/login");

    // Brand logo visible
    await expect(page.locator("text=Sign in to your account")).toBeVisible();

    // Email and password fields
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // Submit button
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("shows error on empty submission", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("button", { name: /sign in/i }).click();

    // Should show validation or error
    const errorOrValidation = page.locator(
      '[class*="red"], [class*="error"], :invalid',
    );
    await expect(errorOrValidation.first()).toBeVisible({ timeout: 5000 });
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("textbox", { name: /email/i }).fill("bad@test.com");
    await page.locator('input[type="password"]').fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for error message
    const error = page.locator('[class*="red"]');
    await expect(error.first()).toBeVisible({ timeout: 10000 });
  });

  test("has link to forgot password", async ({ page }) => {
    await page.goto("/login");

    const forgotLink = page.getByRole("link", { name: /forgot/i });
    await expect(forgotLink).toBeVisible();
  });
});
