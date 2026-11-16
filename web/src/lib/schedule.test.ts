import { describe, expect, it } from 'vitest';
import { estimatedFinish, fromLocalInput, jobWindow, overlappingJobs, quickChips, toLocalInput } from './schedule';
import type { Job } from './types';

function job(over: Partial<Job>): Job {
  return {
    id: crypto.randomUUID(), owner_id: 'o', name: 'x', storage_path: 'p', thumb_path: null, file_size: 1,
    run_at: new Date().toISOString(), use_ams: false, ams_mapping: [], stage: 'pending', note: null,
    est_seconds: 3600, filament_g: null, filament_type: null, remote_name: null, created_at: '', started_at: null,
    finished_at: null, file_purged_at: null, updated_at: '', ...over,
  };
}

describe('quickChips', () => {
  it('tonight is 23:00 today when before 23:00', () => {
    const now = new Date(2026, 10, 15, 14, 12);
    const c = quickChips(now);
    expect(c.map((x) => x.id)).toEqual(['now', '1h', 'tonight', 'morning']);
    expect(c[2].at).toEqual(new Date(2026, 10, 15, 23, 0));
    expect(c[2].label).toBe('Tonight 11 pm');
    expect(c[3].at).toEqual(new Date(2026, 10, 16, 7, 0));
    expect(c[1].at).toEqual(new Date(2026, 10, 15, 15, 12));
  });

  it('rolls tonight to tomorrow after 23:00', () => {
    const c = quickChips(new Date(2026, 10, 15, 23, 30));
    expect(c[2].at).toEqual(new Date(2026, 10, 16, 23, 0));
    expect(c[2].label).toBe('Tomorrow 11 pm');
  });
});

describe('local input round trip', () => {
  it('keeps local wall-clock time', () => {
    const d = new Date(2026, 0, 2, 7, 5);
    expect(toLocalInput(d)).toBe('2026-01-02T07:05');
    expect(fromLocalInput('2026-01-02T07:05')).toEqual(d);
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('overlap detection', () => {
  const now = Date.UTC(2026, 10, 15, 12);
  it('flags jobs whose estimated windows intersect', () => {
    const a = job({ run_at: new Date(now + 3600_000).toISOString(), est_seconds: 7200 }); // 13:00-15:00
    const b = job({ run_at: new Date(now + 6 * 3600_000).toISOString() }); // 18:00-19:00
    const done = job({ stage: 'done', run_at: new Date(now + 3600_000).toISOString() });
    const hits = overlappingJobs([a, b, done], new Date(now + 2 * 3600_000), 1800, undefined, now);
    expect(hits.map((j) => j.id)).toEqual([a.id]);
    expect(overlappingJobs([a, b], new Date(now + 3 * 3600_000), 3600, undefined, now)).toEqual([]);
    expect(overlappingJobs([a], new Date(now + 2 * 3600_000), 60, a.id, now)).toEqual([]);
  });

  it('a running print occupies the printer until its estimate, or now if overrunning', () => {
    const running = job({ stage: 'printing', started_at: new Date(now - 3 * 3600_000).toISOString(), est_seconds: 3600 });
    expect(jobWindow(running, now).end).toBe(now);
  });

  it('estimated finish starts from now for past/now start times', () => {
    expect(estimatedFinish(new Date(now - 1000), 600, now).getTime()).toBe(now + 600_000);
  });
});
