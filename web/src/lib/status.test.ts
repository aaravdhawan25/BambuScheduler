import { describe, expect, it } from 'vitest';
import { countdown, displayName, formatDuration, relative } from './format';
import { isHubOnline, printerBadge } from './status';
import type { HubStatus } from './types';

const hub = (over: Partial<HubStatus>): HubStatus => ({
  id: 1, last_seen: new Date().toISOString(), hub_version: null, last_error: null, plate_clear: true,
  waiting_reason: null, active_job_id: null, connected: true, state: 'IDLE', progress: null,
  remaining_min: null, nozzle: null, bed: null, file: null, updated_at: '', ...over,
});

describe('hub online', () => {
  it('is offline after 45 s without a heartbeat', () => {
    const now = Date.now();
    expect(isHubOnline(hub({ last_seen: new Date(now - 30_000).toISOString() }), now)).toBe(true);
    expect(isHubOnline(hub({ last_seen: new Date(now - 46_000).toISOString() }), now)).toBe(false);
    expect(isHubOnline(hub({ last_seen: null }), now)).toBe(false);
    expect(isHubOnline(null, now)).toBe(false);
  });
});

describe('printerBadge', () => {
  it('maps every gcode_state to a label (never colour alone)', () => {
    const cases: [string, string][] = [
      ['IDLE', 'Idle'], ['PREPARE', 'Preparing'], ['RUNNING', 'Printing'], ['PAUSE', 'Paused'],
      ['FINISH', 'Finished'], ['FAILED', 'Error'],
    ];
    for (const [state, label] of cases) expect(printerBadge(hub({ state }), true).label).toBe(label);
    expect(printerBadge(hub({}), false).label).toBe('Hub offline');
    expect(printerBadge(hub({ connected: false }), true).label).toBe('Printer offline');
  });
});

describe('format', () => {
  it('durations', () => {
    expect(formatDuration(5025)).toBe('1 h 24 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(20)).toBe('under 1 min');
    expect(formatDuration(null)).toBe('—');
  });
  it('relative times', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    expect(relative(new Date(now + 2 * 3600_000), now)).toBe('in 2 h');
    expect(relative(new Date(now - 5 * 60_000), now)).toBe('5 min ago');
    expect(relative(new Date(now + 10_000), now)).toBe('now');
  });
  it('countdown and names', () => {
    expect(countdown(3_723_000)).toBe('01:02:03');
    expect(countdown(-5)).toBe('00:00:00');
    expect(countdown(26 * 3600_000)).toBe('1d 02:00');
    expect(displayName('Benchy.gcode.3mf')).toBe('Benchy');
    expect(displayName('sched_d45c3481_Benchy.gcode.3mf')).toBe('Benchy');
  });
});
