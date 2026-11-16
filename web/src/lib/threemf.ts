/**
 * Reads a Bambu Studio "plate sliced" export (.gcode.3mf) in the browser.
 *
 * VERIFY against a real A1 export. Expected layout (zip):
 *   Metadata/plate_1.gcode           the toolpath (required: the hub prints this)
 *   Metadata/plate_1.png             plate thumbnail
 *   Metadata/slice_info.config       XML: prediction (s), weight (g), <filament .../> entries
 *   Metadata/project_settings.config JSON: filament_type[], filament_colour[], ...
 * Everything except plate_1.gcode is optional; missing fields degrade to null.
 */
import type { PrintFileInfo } from './types';

export class ThreeMfError extends Error {}

export const PLATE_GCODE = 'Metadata/plate_1.gcode';

const NOT_SLICED =
  'This file has no sliced plate in it. In Bambu Studio, slice the plate, then use ' +
  'File → Export → “Export plate sliced file” and upload the .gcode.3mf it makes.';

// VERIFY: Bambu's internal model id for the A1 (A1 mini is "N1").
const A1_MODEL_IDS = ['N2S'];

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface SliceInfo {
  prediction: number | null;
  weight: number | null;
  printerModel: string | null;
  filaments: { id: number; type: string; color: string | null; usedG: number | null }[];
}

export function parseSliceInfo(xml: string): SliceInfo {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    return { prediction: null, weight: null, printerModel: null, filaments: [] };
  }
  const plates = Array.from(doc.getElementsByTagName('plate'));
  const plate =
    plates.find((p) =>
      Array.from(p.getElementsByTagName('metadata')).some(
        (m) => m.getAttribute('key') === 'index' && m.getAttribute('value') === '1',
      ),
    ) ?? plates[0];
  if (!plate) return { prediction: null, weight: null, printerModel: null, filaments: [] };
  const meta = (key: string) =>
    Array.from(plate.getElementsByTagName('metadata'))
      .find((m) => m.getAttribute('key') === key)
      ?.getAttribute('value') ?? null;
  const filaments = Array.from(plate.getElementsByTagName('filament'))
    .map((f) => ({
      id: num(f.getAttribute('id')) ?? 0,
      type: f.getAttribute('type') || 'Unknown',
      color: f.getAttribute('color'),
      usedG: num(f.getAttribute('used_g')),
    }))
    .filter((f) => f.id > 0)
    .sort((a, b) => a.id - b.id);
  return {
    prediction: num(meta('prediction')),
    weight: num(meta('weight')),
    printerModel: meta('printer_model_id'),
    filaments,
  };
}

export async function parseThreeMf(file: Blob & { name?: string }): Promise<PrintFileInfo> {
  const name = file.name ?? '';
  if (name && !/\.3mf$/i.test(name)) {
    throw new ThreeMfError('That isn’t a .3mf file. ' + NOT_SLICED);
  }
  const { default: JSZip } = await import('jszip');
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new ThreeMfError('This file couldn’t be opened as a 3MF. It may be damaged or not a 3MF.');
  }

  if (!zip.file(PLATE_GCODE)) {
    const otherPlate = Object.keys(zip.files).find((p) => /^Metadata\/plate_\d+\.gcode$/.test(p));
    throw new ThreeMfError(
      otherPlate
        ? `This file contains ${otherPlate.replace('Metadata/', '')} but not plate 1. Export the plate you want on its own (it becomes plate 1).`
        : NOT_SLICED,
    );
  }

  const warnings: string[] = [];
  const thumbFile = zip.file('Metadata/plate_1.png');
  const thumbnail = thumbFile ? new Blob([await thumbFile.async('arraybuffer')], { type: 'image/png' }) : null;

  let info: SliceInfo = { prediction: null, weight: null, printerModel: null, filaments: [] };
  const sliceFile = zip.file('Metadata/slice_info.config');
  if (sliceFile) info = parseSliceInfo(await sliceFile.async('string'));
  else warnings.push('No slice info found, so print time and filament use are unknown.');

  // Fill gaps from project settings (filament types/colours by slot).
  const projectFile = zip.file('Metadata/project_settings.config');
  if (projectFile && info.filaments.length === 0) {
    try {
      const ps = JSON.parse(await projectFile.async('string')) as Record<string, unknown>;
      const types = Array.isArray(ps.filament_type) ? (ps.filament_type as string[]) : [];
      const colours = Array.isArray(ps.filament_colour) ? (ps.filament_colour as string[]) : [];
      if (types.length === 1) {
        info.filaments = [{ id: 1, type: types[0], color: colours[0] ?? null, usedG: info.weight }];
      }
    } catch {
      /* ignore malformed settings */
    }
  }

  if (info.prediction == null) warnings.push('Estimated print time isn’t in this file.');
  if (info.printerModel && !A1_MODEL_IDS.includes(info.printerModel)) {
    warnings.push(`This was sliced for a different printer (${info.printerModel}). Make sure it’s meant for the A1.`);
  }

  const types = [...new Set(info.filaments.map((f) => f.type))];
  const weight = info.weight ?? (info.filaments.some((f) => f.usedG != null)
    ? info.filaments.reduce((s, f) => s + (f.usedG ?? 0), 0)
    : null);

  return {
    plateGcodePath: PLATE_GCODE,
    thumbnail,
    estSeconds: info.prediction,
    filamentG: weight != null ? Math.round(weight * 100) / 100 : null,
    filamentTypes: types,
    filaments: info.filaments,
    usesAms: info.filaments.length > 1,
    printerModel: info.printerModel,
    warnings,
  };
}

/**
 * Default AMS mapping: slicer filament N -> AMS slot N-1 (0-based), -1 for unused.
 * VERIFY: the A1 project_file `ams_mapping` is indexed by slicer filament id - 1.
 */
export function defaultAmsMapping(filamentIds: number[]): number[] {
  if (!filamentIds.length) return [];
  const max = Math.max(...filamentIds);
  return Array.from({ length: max }, (_, i) => (filamentIds.includes(i + 1) ? Math.min(i, 3) : -1));
}
