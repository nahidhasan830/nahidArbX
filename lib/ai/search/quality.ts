export function isStrongVertexSearchResult(
  resultCount: number,
  contentChars: number,
  requestedResults: number,
): boolean {
  if (resultCount <= 0) return false;
  if (resultCount >= Math.min(2, requestedResults)) {
    return contentChars >= 180;
  }
  return contentChars >= 220;
}
