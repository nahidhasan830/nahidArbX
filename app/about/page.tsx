import { BrandLogo } from "@/components/ui/BrandLogo";

export const metadata = {
  title: "About - NahidArbX",
  description: "NahidArbX is a private sports value-betting monitoring tool.",
};

export default function AboutPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="w-full max-w-2xl px-4">
        <div className="bg-slate-900 rounded-xl shadow-xl p-8 border border-slate-800">
          <div className="text-center mb-8">
            <BrandLogo size="lg" />
          </div>

          <div className="space-y-6 text-gray-300">
            <section>
              <h2 className="text-xl font-semibold text-white mb-2">
                What is NahidArbX?
              </h2>
              <p>
                NahidArbX is a <strong>private, invite-only</strong> sports
                value-betting monitoring tool. It compares soft-bookmaker odds
                against sharp benchmarks (Pinnacle) to surface positive-EV bets.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-2">
                Is this a public service?
              </h2>
              <p>
                <strong>No.</strong> This is a private tool for personal use.
                Access is restricted to invited users only. There is no public
                registration.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-2">
                Security Notice
              </h2>
              <p>
                This website is <strong>NOT</strong> affiliated with Microsoft,
                Google, or any other company. The login page authenticates users
                to our own backend system.
              </p>
              <p className="mt-2">
                If you received a phishing warning about this site, it is a{" "}
                <strong>false positive</strong>. Please contact the site owner.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-2">Contact</h2>
              <p>
                For questions or concerns, contact:{" "}
                <a
                  href="mailto:nahidhasan830@gmail.com"
                  className="text-cyan-400 hover:text-cyan-300"
                >
                  nahidhasan830@gmail.com
                </a>
              </p>
            </section>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800 text-center text-gray-500 text-sm">
            &copy; {new Date().getFullYear()} NahidArbX. Private application.
          </div>
        </div>
      </div>
    </div>
  );
}
