/**
 * Shadow Mode is now integrated into the ML Optimizer dashboard
 * as the "Shadow A/B" tab. Redirect to /lab/ml.
 */
import { redirect } from "next/navigation";

export default function ShadowModePage() {
  redirect("/lab/ml");
}
