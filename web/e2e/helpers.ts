import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';

// 8x8 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGNgGAWjYBSMglEwCgYbAAAH8AABnqRAAwAAAABJRU5ErkJggg==',
  'base64',
);

export async function makeGcode3mf(opts: { sliced?: boolean; estSeconds?: number; filaments?: number } = {}): Promise<Buffer> {
  const { sliced = true, estSeconds = 5025, filaments = 1 } = opts;
  const zip = new JSZip();
  if (sliced) zip.file('Metadata/plate_1.gcode', 'G28\nG1 X10\n');
  else zip.file('3D/3dmodel.model', '<model/>');
  zip.file('Metadata/plate_1.png', PNG);
  const fil = Array.from(
    { length: filaments },
    (_, i) => `<filament id="${i + 1}" type="${i ? 'PETG' : 'PLA'}" color="#${i ? 'E04040' : 'FFFFFF'}" used_g="${10 + i}"/>`,
  ).join('');
  zip.file(
    'Metadata/slice_info.config',
    `<config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="N2S"/><metadata key="prediction" value="${estSeconds}"/><metadata key="weight" value="23.5"/>${fil}</plate></config>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function signIn(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill('me@example.com');
  await page.getByLabel('Password').fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Printer' })).toBeVisible();
}

/** Navigate using the app's own nav (keeps the in-memory demo state). */
export async function nav(page: Page, name: 'Home' | 'Queue' | 'New print' | 'History' | 'Settings') {
  await page.getByRole('navigation', { name: 'Main' }).filter({ visible: true }).getByRole('link', { name }).click();
}

export async function demo(page: Page, fn: string) {
  await page.evaluate(`window.__demo.${fn}`);
}
