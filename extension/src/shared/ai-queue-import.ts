import { z } from "zod";

export const AiQueuedRequestOriginSchema = z.enum(["user", "code"]);

export const AiQueuedRequestSchema = z.object({
  origin: AiQueuedRequestOriginSchema.default("user"),
  text: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "Текст элемента очереди не может быть пустым."))
});

const AiQueuedRequestInputSchema = z.union([
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "Текст элемента очереди не может быть пустым."))
    .transform((text) => ({
      origin: "user" as const,
      text
    })),
  AiQueuedRequestSchema
]);

const AiQueueImportPayloadSchema = z.union([
  z.array(AiQueuedRequestInputSchema).min(1, "JSON-файл очереди должен содержать хотя бы один запрос."),
  z.object({
    requests: z
      .array(AiQueuedRequestInputSchema)
      .min(1, "JSON-файл очереди должен содержать хотя бы один запрос.")
  })
]);

export type AiQueuedRequest = z.infer<typeof AiQueuedRequestSchema>;

export function parseAiQueueImportJson(text: string): AiQueuedRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Файл очереди содержит невалидный JSON: ${error.message}` : "Файл очереди содержит невалидный JSON."
    );
  }

  const result = AiQueueImportPayloadSchema.parse(parsed);
  return Array.isArray(result) ? result : result.requests;
}
