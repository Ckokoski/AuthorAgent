/**
 * AuthorAgent Rapid-Release Calendar
 *
 * Per-title schedule of key release milestones with iCal/ICS export.
 * Works alongside the Launch Orchestrator: the Orchestrator generates the
 * full launch plan, the Calendar renders it as dated reminders and
 * produces an .ics file the author can import into Google Calendar /
 * Apple Calendar / Outlook for anti-miss safeguards.
 *
 * Also tracks per-title price-pulse plans (99¢ launch → $4.99 day 7 →
 * $3.99 day 30 etc.) and series-price-drop coordination when book N+1
 * goes live.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface CalendarEvent {
  id: string;
  projectId: string;
  bookTitle: string;
  date: string;                     // ISO, all-day
  title: string;
  description: string;
  category: 'pre_order' | 'launch' | 'price_pulse' | 'ad_optimization' | 'email' | 'ARC' | 'series_coord' | 'submission' | 'other';
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'upcoming' | 'done' | 'skipped' | 'missed';
  linkedLaunchId?: string;
  linkedConfirmationId?: string;
}

export class ReleaseCalendarService {
  private events: Map<string, CalendarEvent> = new Map();
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'release-calendar.json');
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const arr: CalendarEvent[] = Array.isArray(parsed.events) ? parsed.events : [];
      for (const e of arr) this.events.set(e.id, e);
    } catch {
      this.events = new Map();
    }
  }

  // ── CRUD ──

  async createEvent(input: Omit<CalendarEvent, 'id' | 'status'> & { status?: CalendarEvent['status'] }): Promise<CalendarEvent> {
    const event: CalendarEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: input.status ?? 'upcoming',
      ...input,
    };
    this.events.set(event.id, event);
    await this.persist();
    return event;
  }

  async updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent | null> {
    const event = this.events.get(id);
    if (!event) return null;
    Object.assign(event, patch);
    await this.persist();
    return event;
  }

  async removeEvent(id: string): Promise<boolean> {
    const existed = this.events.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  getEvent(id: string): CalendarEvent | undefined {
    return this.events.get(id);
  }

  list(filter?: { projectId?: string; category?: CalendarEvent['category']; from?: string; to?: string }): CalendarEvent[] {
    let list = Array.from(this.events.values());
    if (filter?.projectId) list = list.filter(e => e.projectId === filter.projectId);
    if (filter?.category) list = list.filter(e => e.category === filter.category);
    if (filter?.from) list = list.filter(e => e.date >= filter.from!);
    if (filter?.to) list = list.filter(e => e.date <= filter.to!);
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Generate a standard price-pulse plan for a title.
   * Default: $0.99 launch → $2.99 day 7 → $3.99 day 30 → $4.99 day 60.
   */
  buildPricePulsePlan(input: {
    projectId: string;
    bookTitle: string;
    releaseDate: string;              // ISO
    launchPrice?: number;
    tailPrice?: number;
  }): CalendarEvent[] {
    const launch = input.launchPrice ?? 0.99;
    const tail = input.tailPrice ?? 4.99;
    const releaseMs = new Date(input.releaseDate).getTime();
    const mid1 = Math.round((launch + tail) * 0.45 * 100) / 100;
    const mid2 = Math.round((launch + tail) * 0.6 * 100) / 100;

    const schedule: Array<{ dayOffset: number; price: number; note: string }> = [
      { dayOffset: 0, price: launch, note: 'Launch day — minimum price to maximize rank drive' },
      { dayOffset: 7, price: mid1, note: 'Day 7 — first bump, still discoverable' },
      { dayOffset: 30, price: mid2, note: 'Day 30 — second bump' },
      { dayOffset: 60, price: tail, note: 'Day 60 — tail price' },
    ];

    return schedule.map(s => ({
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      date: new Date(releaseMs + s.dayOffset * 86400000).toISOString(),
      title: `Price pulse: "${input.bookTitle}" → $${s.price}`,
      description: s.note,
      category: 'price_pulse',
      priority: s.dayOffset === 0 ? 'critical' : 'high',
      status: 'upcoming',
    } as CalendarEvent));
  }

  /**
   * Export all events (or a filtered subset) as a valid iCalendar .ics string.
   * Import this into Google Calendar / Apple Calendar / Outlook to get
   * anti-miss reminders outside of AuthorAgent itself.
   */
  exportICS(filter?: { projectId?: string; from?: string; to?: string }): string {
    const events = this.list(filter);
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AuthorAgent//ReleaseCalendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];

    for (const e of events) {
      const dt = new Date(e.date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      // All-day events use DATE format.
      const dateOnly = dt.substring(0, 8);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${e.id}@authoragent.local`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dateOnly}`,
        `DTEND;VALUE=DATE:${dateOnly}`,
        `SUMMARY:${this.escapeICS(e.title)}`,
        `DESCRIPTION:${this.escapeICS(e.description + (e.bookTitle ? `\\nBook: ${e.bookTitle}` : '') + `\\nPriority: ${e.priority}\\nCategory: ${e.category}`)}`,
        `CATEGORIES:${e.category.toUpperCase()}`,
        `STATUS:${e.status === 'done' ? 'CONFIRMED' : 'TENTATIVE'}`,
        // VALARM block for email+popup alerts 7 days, 1 day, and 4 hours before.
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-P7D', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-P1D', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT4H', 'END:VALARM',
        'END:VEVENT',
      );
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /** Events at risk: upcoming with <7 days and critical/high priority. */
  atRisk(): CalendarEvent[] {
    const now = Date.now();
    const sevenDays = now + 7 * 86400000;
    return this.list().filter(e =>
      e.status === 'upcoming' &&
      new Date(e.date).getTime() <= sevenDays &&
      (e.priority === 'critical' || e.priority === 'high')
    );
  }

  private escapeICS(s: string): string {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  private async persist(): Promise<void> {
    try {
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify({ events: Array.from(this.events.values()) }, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist calendar:', err);
    }
  }
}
