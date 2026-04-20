import { test, expect } from "@playwright/test";

test.describe("Health API", () => {
  test("GET /api/health returns 200", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("status");
  });

  test("GET /api/health?simple=true returns simple response", async ({
    request,
  }) => {
    const response = await request.get("/api/health?simple=true");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("status");
  });
});
