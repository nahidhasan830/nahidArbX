/**
 * /.well-known/security.txt
 *
 * Standard file for security researchers to understand the site.
 * Helps prevent false positive phishing reports.
 *
 * @see https://securitytxt.org/
 */

export async function GET() {
  const content = `# NahidArbX - Sports Value-Betting Monitoring Tool
# This is a PRIVATE, INVITE-ONLY application.
# This is NOT a phishing site.

Contact: mailto:nahidhasan830@gmail.com
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en

# This application:
# - Compares soft-bookmaker odds against sharp benchmarks (Pinnacle)
# - Surfaces positive-EV (value) betting opportunities
# - Requires invitation to access
# - Has NO affiliation with Microsoft or any other company
# - Login page authenticates to our own backend, not third parties

# False positive? Contact the email above.
`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain",
    },
  });
}
