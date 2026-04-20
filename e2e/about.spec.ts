import { test, expect } from "@playwright/test";

test.describe("About Page", () => {
  test("renders about page content", async ({ page }) => {
    await page.goto("/about");

    await expect(page.locator("text=What is NahidArbX?")).toBeVisible();
    await expect(page.locator("text=private, invite-only")).toBeVisible();
    await expect(page.locator("text=Security Notice")).toBeVisible();
  });

  test("has correct page title", async ({ page }) => {
    await page.goto("/about");
    await expect(page).toHaveTitle(/About.*NahidArbX/);
  });
});
