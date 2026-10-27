const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const MILLISECONDS_PER_DAY = 86_400_000;

export function isoDateOf(dateTime: string): string {
  return dateTime.slice(0, ISO_DATE_LENGTH);
}

export function daysBefore(isoDate: string, days: number): string {
  const instant = Date.parse(`${isoDate}T00:00:00Z`) - days * MILLISECONDS_PER_DAY;
  return isoDateOf(new Date(instant).toISOString());
}
