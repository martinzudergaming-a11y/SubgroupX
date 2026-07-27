export const FIRST_TASK_SUGGESTIONS = [
  "suggestExplore",
  "suggestTests",
  "suggestExplain",
  "suggestDependencies",
] as const;

export type FirstTaskSuggestion = (typeof FIRST_TASK_SUGGESTIONS)[number];

export function shouldSuggestFirstTask({ hasActivity, draft }: { hasActivity: boolean; draft: string }): boolean {
  return !hasActivity && draft.length === 0;
}

export function suggestionForSession(sessionId: string): FirstTaskSuggestion {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  return FIRST_TASK_SUGGESTIONS[hash % FIRST_TASK_SUGGESTIONS.length];
}
