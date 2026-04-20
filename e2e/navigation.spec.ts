import { test, expect } from "@playwright/test";

test.describe("Navigation & Routing", () => {
  test("root redirects to /dashboard", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/(dashboard|login)/);

    // Should redirect to dashboard or login (if auth required)
    const url = page.url();
    expect(url).toMatch(/\/(dashboard|login)/);
  });

  test("404 page renders for unknown routes", async ({ page }) => {
    const response = await page.goto("/this-does-not-exist");
    expect(response?.status()).toBe(404);
  });

  test("about page is accessible without auth", async ({ page }) => {
    const response = await page.goto("/about");
    expect(response?.status()).toBe(200);
  });
});
