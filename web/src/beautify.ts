export interface ImageBeautySettingsValue {
  enabled: boolean;
  provider: "api" | "codex";
  base_url: string;
  model: string;
  has_key: boolean;
  ready: boolean;
  reason: string;
}

export interface ImageBeautyJob {
  status:
    | "idle"
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";
  job_id?: string;
  provider?: "api" | "codex";
  model?: string;
  error?: string;
  source_url: string;
  preview_url: string | null;
  applied: boolean;
}

export const beautyPending = (job: ImageBeautyJob | null) =>
  job?.status === "queued" || job?.status === "processing";
