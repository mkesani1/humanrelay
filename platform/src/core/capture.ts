import type { DB } from "../db.js";

/**
 * Capture — clip registry and dataset manifest builder.
 * Storage/transcode/PII pipelines live outside this service; this owns the
 * catalog, QC status, and customer-facing dataset manifests with provenance.
 */

export interface ClipInput {
  center: string;
  collectorCode: string;
  taskLabel: string;
  taxonomy?: string[];
  durationS: number;
  resolution?: string;
  fps?: number;
  streams?: string[];
  consentId: string;
  piiScrubbed?: boolean;
  storageUrl: string;
  recordedAt: string;
}

export interface DatasetFilter {
  taxonomy?: string[];      // clips must contain all of these tags
  task_label?: string;
  min_duration_s?: number;
  statuses?: string[];      // default: qc_passed + published
}

export class CaptureService {
  constructor(private db: DB) {}

  async registerClip(input: ClipInput): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into capture_clips
        (center, collector_code, task_label, taxonomy, duration_s, resolution, fps, streams,
         consent_id, pii_scrubbed, storage_url, recorded_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        input.center, input.collectorCode, input.taskLabel, input.taxonomy ?? [],
        input.durationS, input.resolution ?? "4K", input.fps ?? 30,
        input.streams ?? ["video", "audio", "imu"], input.consentId,
        input.piiScrubbed ?? false, input.storageUrl, input.recordedAt,
      ],
    );
    return rows[0]!.id;
  }

  async setClipStatus(id: string, status: string): Promise<void> {
    await this.db.query(`update capture_clips set status = $2 where id = $1`, [id, status]);
  }

  /**
   * Build a dataset for a customer: only QC-passed, PII-scrubbed clips are
   * eligible, and every manifest row carries provenance (consent id, center,
   * capture chain) — "data you can put in the model card", literally.
   */
  async buildDataset(orgId: string, name: string, filter: DatasetFilter = {}) {
    const statuses = filter.statuses ?? ["qc_passed", "published"];
    const { rows: clips } = await this.db.query<{
      id: string; task_label: string; taxonomy: string[]; duration_s: number;
      resolution: string; fps: number; streams: string[]; consent_id: string;
      center: string; storage_url: string; recorded_at: Date;
    }>(
      `select * from capture_clips
        where status in (select unnest($1::text[]))
          and pii_scrubbed
          and taxonomy @> $2::text[]
          and ($3::text is null or task_label = $3)
          and duration_s >= $4`,
      [statuses, filter.taxonomy ?? [], filter.task_label ?? null, filter.min_duration_s ?? 0],
    );

    const totalHours = clips.reduce((s, c) => s + c.duration_s, 0) / 3600;
    const manifest = {
      generated_at: new Date().toISOString(),
      clip_count: clips.length,
      total_hours: Number(totalHours.toFixed(3)),
      clips: clips.map((c) => ({
        id: c.id,
        url: c.storage_url,
        task_label: c.task_label,
        taxonomy: c.taxonomy,
        duration_s: c.duration_s,
        resolution: c.resolution,
        fps: c.fps,
        streams: c.streams,
        provenance: {
          center: c.center,
          consent_id: c.consent_id,
          recorded_at: c.recorded_at,
          pii_scrubbed: true,
        },
      })),
    };

    const { rows } = await this.db.query<{ id: string }>(
      `insert into datasets (org_id, name, filter, clip_count, total_hours, manifest, status)
       values ($1,$2,$3,$4,$5,$6,'ready') returning id`,
      [orgId, name, JSON.stringify(filter), clips.length, totalHours, JSON.stringify(manifest)],
    );
    return this.getDataset(rows[0]!.id, orgId);
  }

  async getDataset(id: string, orgId: string) {
    const { rows } = await this.db.query<{
      id: string; name: string; status: string; clip_count: number;
      total_hours: number; manifest: unknown; created_at: Date;
    }>(`select * from datasets where id = $1 and org_id = $2`, [id, orgId]);
    return rows[0] ?? null;
  }
}
