/**
 * AuthorAgent Manuscript Hub
 *
 * Aggregates live stats across all projects for a single dashboard view:
 * word counts, progress, recent activity, word-goal tracking, in-flight
 * steps, and upcoming work. Replaces the prose-only stub at
 * skills/author/manuscript-hub/SKILL.md with a real data endpoint.
 */

export interface HubProjectSummary {
  id: string;
  title: string;
  type: string;
  status: string;           // pending | active | paused | completed
  progress: number;         // 0-100
  totalSteps: number;
  completedSteps: number;
  activeStepLabel: string | null;
  totalWords: number;
  chaptersWritten: number;
  chapterTarget: number;
  preferredProvider?: string;
  lastActivityAt?: string;
}

export interface HubDaily {
  date: string;
  wordCount: number;
  stepsCompleted: number;
}

export interface ManuscriptHubReport {
  generatedAt: string;
  totals: {
    projects: number;
    active: number;
    completed: number;
    totalWords: number;
    totalChaptersWritten: number;
  };
  goal: {
    daily: number;
    todayWords: number;
    pctOfDaily: number;     // 0-100
    streakDays: number;     // Consecutive days hitting the goal
  };
  projects: HubProjectSummary[];
  recent: HubDaily[];       // Last 14 days of velocity
  upcoming: Array<{ projectId: string; projectTitle: string; stepLabel: string }>;
}

interface ProjectLike {
  id: string;
  title: string;
  type: string;
  status: string;
  progress: number;
  preferredProvider?: string;
  updatedAt?: string;
  steps: Array<{
    id: string;
    label: string;
    status: string;
    phase?: string;
    chapterNumber?: number;
    result?: string;
    wordCountTarget?: number;
  }>;
}

interface ActivityLike {
  log(entry: any): void;
  getRecent(count?: number): any[] | Promise<any[]>;
}

export class ManuscriptHubService {
  /**
   * Build the hub report from the live project engine + activity log state.
   * No disk reads — all data comes from in-memory services.
   */
  async build(
    projects: ProjectLike[],
    activityLog: ActivityLike,
    dailyWordGoal: number,
  ): Promise<ManuscriptHubReport> {
    const projectSummaries: HubProjectSummary[] = projects.map(p => this.summarizeProject(p));

    const totalWords = projectSummaries.reduce((sum, p) => sum + p.totalWords, 0);
    const totalChapters = projectSummaries.reduce((sum, p) => sum + p.chaptersWritten, 0);
    const active = projectSummaries.filter(p => p.status === 'active').length;
    const completed = projectSummaries.filter(p => p.status === 'completed').length;

    // Recent activity — pull file_saved + step_completed entries from the last 14 days.
    const recent = await this.computeRecentVelocity(activityLog, 14);
    const today = new Date().toISOString().split('T')[0];
    const todayEntry = recent.find(d => d.date === today);
    const todayWords = todayEntry?.wordCount ?? 0;

    const streakDays = this.computeStreak(recent, dailyWordGoal);

    // Upcoming work — next pending step per active project.
    const upcoming = projects
      .filter(p => p.status === 'active' || p.status === 'paused')
      .map(p => {
        const nextStep = p.steps.find(s => s.status === 'pending' || s.status === 'active');
        if (!nextStep) return null;
        return { projectId: p.id, projectTitle: p.title, stepLabel: nextStep.label };
      })
      .filter((e): e is { projectId: string; projectTitle: string; stepLabel: string } => e !== null);

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        projects: projects.length,
        active,
        completed,
        totalWords,
        totalChaptersWritten: totalChapters,
      },
      goal: {
        daily: dailyWordGoal,
        todayWords,
        pctOfDaily: dailyWordGoal > 0 ? Math.min(100, Math.round((todayWords / dailyWordGoal) * 100)) : 0,
        streakDays,
      },
      projects: projectSummaries,
      recent,
      upcoming,
    };
  }

  private summarizeProject(p: ProjectLike): HubProjectSummary {
    const totalSteps = p.steps.length;
    const completedSteps = p.steps.filter(s => s.status === 'completed').length;
    const activeStep = p.steps.find(s => s.status === 'active');

    // Count words from completed writing-phase steps.
    const writingSteps = p.steps.filter(s =>
      (s.phase === 'writing' || /chapter/i.test(s.label)) && s.status === 'completed'
    );
    const totalWords = writingSteps.reduce((sum, s) => {
      if (!s.result) return sum;
      return sum + s.result.split(/\s+/).filter(Boolean).length;
    }, 0);

    const chaptersWritten = writingSteps.filter(s => /write chapter/i.test(s.label)).length
      || writingSteps.length;
    const chapterTarget = p.steps.filter(s => /write chapter/i.test(s.label)).length;

    return {
      id: p.id,
      title: p.title,
      type: p.type,
      status: p.status,
      progress: p.progress,
      totalSteps,
      completedSteps,
      activeStepLabel: activeStep?.label ?? null,
      totalWords,
      chaptersWritten,
      chapterTarget,
      preferredProvider: p.preferredProvider,
      lastActivityAt: p.updatedAt,
    };
  }

  /**
   * Bucket the last N days of activity by day, summing wordCount from
   * file_saved metadata and counting step_completed events.
   */
  private async computeRecentVelocity(activityLog: ActivityLike, days: number): Promise<HubDaily[]> {
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const byDate = new Map<string, HubDaily>();

    // Seed empty days so the result is contiguous (helps the dashboard chart).
    for (let i = 0; i < days; i++) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      byDate.set(d, { date: d, wordCount: 0, stepsCompleted: 0 });
    }

    // activityLog.getRecent returns entries newest-first. Pull a generous slice.
    const entries = (await activityLog.getRecent?.(500)) ?? [];
    for (const entry of entries) {
      const ts = entry.timestamp || entry.time || entry.at;
      if (!ts) continue;
      const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
      if (isNaN(t) || t < cutoff) continue;
      const date = new Date(t).toISOString().split('T')[0];
      const bucket = byDate.get(date);
      if (!bucket) continue;

      if (entry.type === 'file_saved' || entry.type === 'step_completed') {
        bucket.stepsCompleted++;
        const wc = entry.metadata?.wordCount;
        if (typeof wc === 'number' && wc > 0) bucket.wordCount += wc;
      }
    }

    // Sort ascending by date for charts.
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Count consecutive days meeting the word goal, ending today.
   * If today is below goal but yesterday is hit, return 0 (broken streak).
   */
  private computeStreak(recent: HubDaily[], goal: number): number {
    if (goal <= 0) return 0;
    const sorted = [...recent].sort((a, b) => b.date.localeCompare(a.date)); // newest first
    let streak = 0;
    for (const day of sorted) {
      if (day.wordCount >= goal) streak++;
      else break;
    }
    return streak;
  }
}
