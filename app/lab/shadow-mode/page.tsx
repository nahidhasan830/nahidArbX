/**
 * Legacy redirect — Shadow Mode is now the "Paper Trading" tab in the
 * ML Optimizer dashboard.
 */
import { redirect } from "next/navigation";

export default function ShadowModePage() {
  redirect("/lab/ml");
}
