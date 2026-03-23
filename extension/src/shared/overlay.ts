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

const HTTP_URL_PATTERN = /^https?:\/\//i;
const PDF_URL_PATTERN = /\.pdf(?:$|[?#])/i;

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
