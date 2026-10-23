import { addDays, differenceInMinutes, format, startOfWeek } from "date-fns";

export const HOUR_HEIGHT = 58;
export const DAY_MINUTES = 24 * 60;

export function startOfWeekMonday(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export function durationLabel(startMs: number, endMs: number): string {
  const mins = Math.max(1, Math.round((endMs - startMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtTime(ms: number): string {
  return format(new Date(ms), "HH:mm");
}

export function fmtClock(ms: number): string {
  return format(new Date(ms), "h:mm a");
}

export function fmtRange(startMs: number, endMs: number): string {
  return `${fmtTime(startMs)} – ${fmtTime(endMs)}`;
}

export function fmtWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  return sameMonth
    ? `${format(weekStart, "d")} – ${format(end, "d MMM yyyy")}`
    : `${format(weekStart, "d MMM")} – ${format(end, "d MMM yyyy")}`;
}

export function isSameDay(a: number | Date, b: number | Date): boolean {
  return format(new Date(a), "yyyy-MM-dd") === format(new Date(b), "yyyy-MM-dd");
}

/** Local ISO string without timezone shift, for `when: {type:'at'}`. */
export function toLocalIso(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}

export function minutesBetween(a: Date, b: Date): number {
  return differenceInMinutes(b, a);
}

export function weekdayShort(d: Date): string {
  return format(d, "EEE");
}

export function dayNumber(d: Date): string {
  return format(d, "d");
}

export function monthShort(d: Date): string {
  return format(d, "MMM");
}

export function isToday(d: Date): boolean {
  return format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
