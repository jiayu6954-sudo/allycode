/** Normalize release origins without loading Electron or the updater runtime. */
export function normalizeSources(sources: string[]): string[] {
  return [...new Set(sources.map((source) => source.trim().replace(/\/$/, "")).filter((source) => {
    try {
      return new URL(source).protocol === "https:";
    } catch {
      return false;
    }
  }))];
}
