/**
 * The timestamp every log line in this app is stamped with.
 *
 * Log lines are read by people on the workspace machine before they are read by
 * a script, and a UTC `Z` stamp reads as local until someone does the arithmetic
 * — which is exactly how a review that ran at 21:53 gets mistaken for one that
 * never ran. Stamping the machine's own offset keeps the value unambiguous, still
 * parses as ISO 8601, and needs no conversion to be useful.
 *
 * Persisted data (session timestamps, clipboard captures, quarantine filenames)
 * keeps UTC: those are formats other code and previous versions read back, and
 * this app's logs are the only surface whose reader is a human.
 */
export function localTimestamp(date: Date = new Date()): string {
  const pad = (value: number, width = 2): string =>
    String(Math.abs(value)).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}
