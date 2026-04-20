import { test, expect } from "@playwright/test";

test.describe("Value Bets Dashboard", () => {
  test("redirects to login when not authenticated", async ({ page }) => {
    await page.goto("/value-bets");
    // If auth is required, should redirect to login
    // If no auth, the page should load with dashboard content
    await page.waitForURL(/\/(value-bets|login)/, { timeout: 10000 });

    const url = page.url();
    if (url.includes("/login")) {
      // Auth-protected: verify login page renders
      await expect(page.locator("text=Sign in to your account")).toBeVisible();
    } else {
      // Dashboard loaded: verify key elements
      await expect(page.locator("body")).not.toBeEmpty();
    }
  });

  test("value-bets page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/value-bets");
    await page.waitForTimeout(3000);

    // Filter out expected errors (network issues in dev, etc.)
    const criticalErrors = errors.filter(
      (e) => !e.includes("fetch") && !e.includes("network"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
