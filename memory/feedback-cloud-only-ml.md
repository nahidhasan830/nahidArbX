---
name: cloud-only-ml
description: User wants all ML runtime to be Google Cloud only, with no local ML inference and no Hugging Face dependencies anywhere.
metadata:
  type: feedback
---

Use Google Cloud managed services only for ML runtime in this repo; do not keep local inference paths or any Hugging Face runtime, fallback, token, or configuration.

**Why:** The user wants zero local model operations and does not want anything related to Hugging Face in the stack.

**How to apply:** When changing ML, entity matching, embeddings, or scoring paths in this project, prefer Google Cloud managed inference and remove ONNX/local/Hugging Face runtime dependencies completely.
