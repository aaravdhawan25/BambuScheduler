import { expect, test } from '@playwright/test';
import { demo, makeGcode3mf, nav, signIn } from './helpers';

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('dashboard shows live status and next scheduled print', async ({ page }) => {
  await expect(page.getByText('Ready')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByText(/Desk organiser|Cable clips/).first()).toBeVisible();
});

test('rejects a project that was not sliced, with export instructions', async ({ page }) => {
  await nav(page, 'New print');
  await page.locator('input[type=file]').setInputFiles({
    name: 'project.3mf',
    mimeType: 'application/octet-stream',
    buffer: await makeGcode3mf({ sliced: false }),
  });
  await expect(page.getByRole('alert')).toContainText('Export plate sliced file');
});

test('upload, schedule for tomorrow morning, and see it in the queue', async ({ page }) => {
  await nav(page, 'New print');
  await page.locator('input[type=file]').setInputFiles({
    name: 'Lamp shade.gcode.3mf',
    mimeType: 'application/octet-stream',
    buffer: await makeGcode3mf({ filaments: 2 }),
  });
  await expect(page.getByLabel('Name')).toHaveValue('Lamp shade');
  await expect(page.getByText('1 h 24 min')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Use AMS' })).toBeChecked();
  await expect(page.getByText(/must be empty and the right filament loaded/)).toBeVisible();

  await page.getByRole('radio', { name: 'Tomorrow 7 am' }).click();
  await page.getByRole('button', { name: /Schedule for Tomorrow/ }).click();

  await expect(page).toHaveURL(/\/queue/);
  const row = page.getByRole('listitem').filter({ hasText: 'Lamp shade' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Scheduled')).toBeVisible();

  await page.getByRole('tab', { name: 'timeline' }).click();
  await expect(page.getByRole('figure').getByText('Lamp shade')).toBeVisible();
});

test('print now -> finish -> plate clear -> history', async ({ page }) => {
  await nav(page, 'New print');
  await page.locator('input[type=file]').setInputFiles({
    name: 'Clip.gcode.3mf',
    mimeType: 'application/octet-stream',
    buffer: await makeGcode3mf(),
  });
  await page.getByRole('button', { name: 'Print now' }).click();
  // Print now needs a second, deliberate confirmation.
  await page.getByRole('alertdialog').getByRole('button', { name: 'Print now' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('progressbar', { name: 'Print progress' })).toBeVisible();
  await expect(page.getByText('Clip').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 15_000 });

  await demo(page, 'finishNow()');
  await expect(page.getByRole('heading', { name: 'Plate needs clearing' })).toBeVisible();
  await page.getByRole('button', { name: 'Plate is clear' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, plate is clear' }).click();
  await expect(page.getByRole('heading', { name: 'Plate needs clearing' })).toBeHidden({ timeout: 10_000 });

  await nav(page, 'History');
  await expect(page.getByRole('listitem').filter({ hasText: 'Clip' }).getByText('Done')).toBeVisible();
});

test('stop needs a press-and-hold, then the job needs attention', async ({ page }) => {
  await page.evaluate(async () => {
    const api = (window as never as { __demo: { api: { listJobs(): Promise<{ stage: string; file_purged_at: string | null }[]>; reprintJob(j: unknown, d: Date): Promise<unknown> } } }).__demo.api;
    const done = (await api.listJobs()).find((j) => j.stage === 'done' && !j.file_purged_at);
    await api.reprintJob(done, new Date());
  });
  const stop = page.getByRole('button', { name: /Stop \(hold to confirm\)/ });
  await expect(stop).toBeVisible({ timeout: 15_000 });

  await stop.click(); // a quick tap does nothing
  await page.waitForTimeout(1500);
  await expect(page.getByRole('heading', { name: 'A print needs your attention' })).toBeHidden();

  const box = (await stop.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1800);
  await page.mouse.up();
  await expect(page.getByRole('heading', { name: 'A print needs your attention' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Stopped from the app/).first()).toBeVisible();
});

test('cancel and reschedule are confirmed', async ({ page }) => {
  await nav(page, 'Queue');
  const row = page.getByRole('listitem').filter({ hasText: 'Desk organiser' });
  await row.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep it' }).click();
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Reschedule' }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'In 1 hour' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Move to/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await row.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel print' }).click();
  await expect(row).toBeHidden();
});

test('hub offline banner', async ({ page }) => {
  await demo(page, 'setHubOnline(false)');
  await expect(page.getByText("Your home hub is offline. Prints won't start.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Last seen 1 min ago/)).toBeVisible();
});

test('settings: auto-continue needs confirmation; theme toggles', async ({ page }) => {
  await nav(page, 'Settings');
  await page.getByRole('switch', { name: 'Auto-continue' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('on top of whatever is on the plate');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep off' }).click();
  await expect(page.getByRole('switch', { name: 'Auto-continue' })).not.toBeChecked();

  await page.getByLabel('ntfy.sh topic').fill('bad topic!');
  await expect(page.getByText('Use only letters, numbers')).toBeVisible();

  await page.getByRole('radio', { name: 'light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('keyboard: skip link and focusable nav', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
