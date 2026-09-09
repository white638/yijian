export const CAPTURE_PREFIX: string;
export const MAX_IMAGE_BYTES: number;
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface CapturedPage {
  title: string;
  source_url: string;
  viewport: Size;
  candidates: { id: string; rect: Rect }[];
}
export function collectVisibleImages(): CapturedPage;
export function cropBounds(rect: Rect, viewport: Size, bitmap: Size): Rect;
export function dataBytes(value: string): number;
export function cropCandidate(
  screenshot: string,
  rect: Rect,
  viewport: Size,
): Promise<string>;
export function capturePayload(
  page: Pick<CapturedPage, "title" | "source_url">,
  image: string,
): string;
