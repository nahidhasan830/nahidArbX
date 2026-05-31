import "dotenv/config";
import {
  captureSession,
  shutdownSessionBrowser,
} from "@/lib/betting/saba/session";

function redact(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function redactUrl(value: string): string {
  const parsed = URL.parse(value);
  if (!parsed) return redact(value);
  return `${parsed.origin}${parsed.pathname}${parsed.search ? "?..." : ""}`;
}

async function main() {
  try {
    const session = await captureSession();
    console.log(
      JSON.stringify(
        {
          username: session.username,
          accessToken: redact(session.accessToken),
          refreshToken: session.refreshToken
            ? redact(session.refreshToken)
            : "",
          accessTokenExp: session.accessTokenExp,
          gameUrl: redactUrl(session.gameUrl),
          capturedAt: session.capturedAt,
        },
        null,
        2,
      ),
    );
  } finally {
    await shutdownSessionBrowser();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
