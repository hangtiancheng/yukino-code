export function buildReloadReminder(
  instructions: string,
  skills: readonly string[],
): string {
  return `Resources reloaded. For future turns, the following instructions and skill list supersede earlier resource announcements. Historical tool results remain historical data.\nCurrent skills: ${JSON.stringify(skills)}\n\n${instructions}`;
}
