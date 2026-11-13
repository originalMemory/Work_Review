export function formatBubbleMessage(message: unknown): string {
  return typeof message === 'string' ? message.trim() : '';
}
