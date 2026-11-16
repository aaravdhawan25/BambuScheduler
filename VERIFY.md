# VERIFY: assumptions to confirm on real hardware / your Supabase project

Each item below is an assumption made without access to the printer or a live
project. Each is isolated in one place so it's a one-line fix if it's wrong.
Tick them off as you confirm them.

## Printer (Bambu Lab A1, LAN Only + Developer Mode)

| # | Assumption | Where | How to check |
|---|-----------|-------|--------------|
| P1 | `project_file` payload field set is accepted by A1 firmware (`param`, `url`, `subtask_name`, `use_ams`, `ams_mapping`, `bed_leveling`, `vibration_cali`, `flow_cali`, `layer_inspect`, `timelapse`, `bed_type`, ids). | `hub/bambu_hub/bambu.py` → `build_project_file_command()` | Schedule a small print with `MOCK=0` and `LOG_LEVEL=DEBUG`; it should start. Compare with your `bambu_scheduler.py`. |
| P2 | `url` is `file:///sdcard/<name>` (not `ftp://<name>`). | same function | Same as P1. If the printer reports "file not found", try `ftp://`. |
| P3 | `ams_mapping` is indexed by slicer filament id − 1, values are AMS tray 0–3, `-1` = unused; `[]` when `use_ams` is false. | same function; `web/src/lib/threemf.ts` → `defaultAmsMapping()`; `web/src/components/AmsMapper.tsx` | Print a 2-colour file with filaments in non-default slots. |
| P4 | The FTP root is the SD card root, so `STOR /<name>` lands where `file:///sdcard/<name>` points. | `BambuPrinter.upload_file()` | After an upload, check the file on the printer's SD card list. |
| P5 | FTPS data connections must reuse the control TLS session, and `unwrap()` after upload hangs (so it's skipped). | `ImplicitFTPS.ntransfercmd()`, `storbinary_no_unwrap()` | Upload a 20+ MB file; it should finish without hanging. |
| P6 | Starting is safe only in `IDLE`/`FINISH`. After a stop or failure the A1 may stay in `FAILED` until the next print, which would block the queue. If so, add `"FAILED"` to `STARTABLE_STATES`. | `hub/bambu_hub/printer.py` → `STARTABLE_STATES` | Stop a print from the app, clear the plate, check that the next job starts. |
| P7 | A user stop makes the A1 report `FAILED` (or `IDLE`). Both are handled; the job goes to `attention` either way. | `MockPrinter.stop()`, `Hub._advance_one()` | Stop a print from the app; the job should show "Stopped from the app". |
| P8 | During calibration (bed levelling, vibration compensation) the A1 reports `PREPARE` (or `RUNNING`), so the 3-minute "never started" timeout doesn't fire. | `Hub._advance_one()`, `Timing.start_timeout` | Watch `hub_status.state` during the first minutes of a print. |
| P9 | `subtask_name` in reports echoes the `subtask_name` we send (it contains `sched_<8 hex>`), so a leftover FINISH is recognised as not ours. | `Hub._advance_one()` (`job_tag`) | Watch `hub_status.file` while printing. |
| P10 | `mc_remaining_time` is in minutes and `mc_percent` is 0–100. | `snapshot_from_state()` | Compare with the printer screen. |
| P11 | The A1's internal model id is `N2S` (used only for a "sliced for a different printer" warning). | `web/src/lib/threemf.ts` → `A1_MODEL_IDS` | Check `printer_model_id` in your export's `Metadata/slice_info.config`. |
| P12 | Pushall every ≥60 s of silence is fine; A1 reports often enough while printing that 180 s of silence means it's gone. | `PUSHALL_IF_SILENT_S`, `STALE_AFTER_S` in `bambu.py` | Leave it idle for an hour; `connected` should stay true. |

## Sliced file layout (.gcode.3mf)

| # | Assumption | Where |
|---|-----------|-------|
| F1 | Bambu Studio's "Export plate sliced file" contains `Metadata/plate_1.gcode`, `Metadata/plate_1.png`, `Metadata/slice_info.config` with `<metadata key="prediction">` (seconds) and `weight` (grams) and `<filament id type color used_g>` entries. Missing fields degrade gracefully. | `web/src/lib/threemf.ts` |
| F2 | A plate exported on its own is always `plate_1` (the hub always prints `Metadata/plate_1.gcode`). | `threemf.ts`, `build_project_file_command()` |

To check F1: rename an export to `.zip` and look inside.

## Supabase (free plan)

| # | Assumption | Where | How to check |
|---|-----------|-------|--------------|
| S1 | Per-file upload limit is 50 MB. The bucket is created with `file_size_limit = 52428800` and the UI rejects bigger files with a friendly message. | migration (`storage.buckets` insert), `MAX_UPLOAD_BYTES` in `web/src/lib/api/api.ts` | Dashboard → Storage → Settings. Try uploading a >50 MB file. |
| S2 | Projects pause after ~7 days without activity, and the hub's REST writes every ≤15 s count as activity. | n/a | Check the project after a quiet week. If it pauses anyway, a weekly dashboard visit or a cheap cron ping fixes it. |
| S3 | Realtime `postgres_changes` respects RLS for `jobs`, `hub_status`, `commands`, `settings` (the migration adds them to `supabase_realtime`). | migration, `SupabaseApi.subscribe()` | Open the app on two devices; changes appear on both within a second. |
| S4 | Storage `copy` (used by "Print again") works for the owner with the policies in the migration (it needs SELECT on the source and INSERT on the destination). | `SupabaseApi.reprintJob()` | Re-print a finished job. |
| S5 | `DELETE /storage/v1/object/prints/<path>` works for the hub under the `prints_hub_cleanup` policy (job finished more than 7 days ago). | `SupabaseStore.delete_file()` | `LOG_LEVEL=DEBUG`, wait for the hourly cleanup after a job is 7 days old. |
| S6 | Magic links work with `shouldCreateUser: false` and the site URL / redirect URL set to your Vercel domain. | `SupabaseApi.sendMagicLink()` | Use "Email me a link instead" on the login page. |
