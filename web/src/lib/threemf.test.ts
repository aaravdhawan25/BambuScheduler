import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { defaultAmsMapping, parseSliceInfo, parseThreeMf, ThreeMfError } from './threemf';

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="N2S"/>
    <metadata key="prediction" value="5025"/>
    <metadata key="weight" value="41.27"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="4.1" used_g="12.50"/>
    <filament id="3" tray_info_idx="GFG00" type="PETG" color="#FF0000" used_m="9.2" used_g="28.77"/>
  </plate>
</config>`;

async function make3mf(files: Record<string, string | Uint8Array>, name = 'part.gcode.3mf'): Promise<File> {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(files)) zip.file(p, c);
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return new File([buf.slice().buffer as ArrayBuffer], name);
}

describe('parseThreeMf', () => {
  it('reads time, weight, filaments and thumbnail from a full export', async () => {
    const f = await make3mf({
      'Metadata/plate_1.gcode': '; HEADER_BLOCK_START\nG28\n',
      'Metadata/plate_1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'Metadata/slice_info.config': SLICE_INFO,
    });
    const info = await parseThreeMf(f);
    expect(info.estSeconds).toBe(5025);
    expect(info.filamentG).toBe(41.27);
    expect(info.filamentTypes).toEqual(['PLA', 'PETG']);
    expect(info.filaments.map((x) => x.id)).toEqual([1, 3]);
    expect(info.usesAms).toBe(true);
    expect(info.thumbnail?.type).toBe('image/png');
    expect(info.warnings).toEqual([]);
  });

  it('degrades gracefully when metadata is missing', async () => {
    const info = await parseThreeMf(await make3mf({ 'Metadata/plate_1.gcode': 'G28' }));
    expect(info.estSeconds).toBeNull();
    expect(info.filamentG).toBeNull();
    expect(info.thumbnail).toBeNull();
    expect(info.usesAms).toBe(false);
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to project settings for a single filament', async () => {
    const info = await parseThreeMf(
      await make3mf({
        'Metadata/plate_1.gcode': 'G28',
        'Metadata/project_settings.config': JSON.stringify({ filament_type: ['PLA'], filament_colour: ['#00FF00'] }),
      }),
    );
    expect(info.filamentTypes).toEqual(['PLA']);
  });

  it('rejects an unsliced project with export instructions', async () => {
    const f = await make3mf({ '3D/3dmodel.model': '<model/>' }, 'project.3mf');
    await expect(parseThreeMf(f)).rejects.toThrow(/Export plate sliced file/);
  });

  it('explains when only another plate was exported', async () => {
    const f = await make3mf({ 'Metadata/plate_2.gcode': 'G28' });
    await expect(parseThreeMf(f)).rejects.toThrow(/plate_2\.gcode but not plate 1/);
  });

  it('rejects non-zip files and wrong extensions', async () => {
    await expect(parseThreeMf(new File(['hello'], 'x.gcode.3mf'))).rejects.toBeInstanceOf(ThreeMfError);
    await expect(parseThreeMf(new File(['G28'], 'x.gcode'))).rejects.toThrow(/isn’t a \.3mf/);
  });

  it('warns when sliced for another printer', async () => {
    const info = await parseThreeMf(
      await make3mf({
        'Metadata/plate_1.gcode': 'G28',
        'Metadata/slice_info.config': SLICE_INFO.replace('N2S', 'C11'),
      }),
    );
    expect(info.warnings.join(' ')).toMatch(/different printer \(C11\)/);
  });
});

describe('parseSliceInfo', () => {
  it('returns empty info for malformed XML', () => {
    expect(parseSliceInfo('<config><plate>').filaments).toEqual([]);
  });
});

describe('defaultAmsMapping', () => {
  it('maps filament N to slot N-1 and marks gaps unused', () => {
    expect(defaultAmsMapping([1, 3])).toEqual([0, -1, 2]);
    expect(defaultAmsMapping([])).toEqual([]);
    expect(defaultAmsMapping([6])).toEqual([-1, -1, -1, -1, -1, 3]);
  });
});
