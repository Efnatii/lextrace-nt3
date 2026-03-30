import { z } from "zod";

export const OverlayErrorCodeSchema = z.enum([
  "unsupported_tab",
  "content_not_ready",
  "overlay_open_failed"
]);

export const OverlayProbeReasonSchema = OverlayErrorCodeSchema;

export const OverlayProbeResultSchema = z.object({
  eligible: z.boolean(),
  ready: z.boolean(),
  reason: OverlayProbeReasonSchema.nullable(),
  tabId: z.number().int().positive().nullable(),
  url: z.string().nullable()
});

export type OverlayErrorCode = z.infer<typeof OverlayErrorCodeSchema>;
export type OverlayProbeReason = z.infer<typeof OverlayProbeReasonSchema>;
export type OverlayProbeResult = z.infer<typeof OverlayProbeResultSchema>;
export type OverlayGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type OverlayViewport = {
  width: number;
  height: number;
};
export type OverlayResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HTTP_URL_PATTERN = /^https?:\/\//i;
const PDF_URL_PATTERN = /\.pdf(?:$|[?#])/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getOverlaySupportReason(url: string | null | undefined): OverlayProbeReason | null {
  if (!url || !HTTP_URL_PATTERN.test(url) || PDF_URL_PATTERN.test(url)) {
    return "unsupported_tab";
  }

  return null;
}

export function createOverlayProbeResult(
  tabId: number | null,
  url: string | null,
  ready: boolean,
  reason: OverlayProbeReason | null
): OverlayProbeResult {
  const eligible = reason !== "unsupported_tab";
  return OverlayProbeResultSchema.parse({
    eligible,
    ready: eligible && ready,
    reason,
    tabId,
    url
  });
}

export function isContentScriptUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection") ||
    message.includes("message port closed before a response was received")
  );
}

export function getOverlayUserMessage(result: Pick<OverlayProbeResult, "eligible" | "ready" | "reason">): string {
  if (result.ready) {
    return "Терминал доступен на текущей странице.";
  }

  switch (result.reason) {
    case "unsupported_tab":
      return "Терминал недоступен: переключитесь на обычную http(s)-страницу.";
    case "content_not_ready":
      return "Терминал недоступен: перезагрузите страницу и повторите попытку.";
    case "overlay_open_failed":
      return "Не удалось открыть терминал на текущей странице.";
    default:
      return "Доступность терминала пока неизвестна.";
  }
}

export function getCenteredOverlayPosition(
  viewport: OverlayViewport,
  size: Pick<OverlayGeometry, "width" | "height">
): Pick<OverlayGeometry, "left" | "top"> {
  return {
    left: Math.max(0, Math.round((viewport.width - size.width) / 2)),
    top: Math.max(0, Math.round((viewport.height - size.height) / 2))
  };
}

export function clampOverlayGeometryToViewport(
  geometry: OverlayGeometry,
  viewport: OverlayViewport
): OverlayGeometry {
  return {
    ...geometry,
    left: clamp(geometry.left, 0, Math.max(0, viewport.width - geometry.width)),
    top: clamp(geometry.top, 0, Math.max(0, viewport.height - geometry.height))
  };
}

export function resizeOverlayGeometry(
  geometry: OverlayGeometry,
  direction: OverlayResizeHandle,
  deltaX: number,
  deltaY: number,
  viewport: OverlayViewport,
  options: {
    minWidth?: number;
    minHeight?: number;
  } = {}
): OverlayGeometry {
  const minWidth = options.minWidth ?? 480;
  const minHeight = options.minHeight ?? 320;
  const right = geometry.left + geometry.width;
  const bottom = geometry.top + geometry.height;

  let nextLeft = geometry.left;
  let nextTop = geometry.top;
  let nextWidth = geometry.width;
  let nextHeight = geometry.height;

  if (direction.includes("e")) {
    nextWidth = clamp(geometry.width + deltaX, minWidth, Math.max(minWidth, viewport.width - geometry.left));
  }

  if (direction.includes("s")) {
    nextHeight = clamp(geometry.height + deltaY, minHeight, Math.max(minHeight, viewport.height - geometry.top));
  }

  if (direction.includes("w")) {
    nextLeft = clamp(geometry.left + deltaX, 0, Math.max(0, right - minWidth));
    nextWidth = right - nextLeft;
  }

  if (direction.includes("n")) {
    nextTop = clamp(geometry.top + deltaY, 0, Math.max(0, bottom - minHeight));
    nextHeight = bottom - nextTop;
  }

  return {
    left: nextLeft,
    top: nextTop,
    width: nextWidth,
    height: nextHeight
  };
}
