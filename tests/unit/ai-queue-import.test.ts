import { describe, expect, it } from "vitest";

import { parseAiQueueImportJson } from "../../extension/src/shared/ai-queue-import";

describe("AI queue import parser", () => {
  it("parses a plain array of string prompts as user requests", () => {
    expect(parseAiQueueImportJson(JSON.stringify(["  first  ", "second"]))).toEqual([
      {
        origin: "user",
        text: "first"
      },
      {
        origin: "user",
        text: "second"
      }
    ]);
  });

  it("parses an object payload with explicit origins", () => {
    expect(
      parseAiQueueImportJson(
        JSON.stringify({
          requests: [
            {
              origin: "code",
              text: "  explain snippet  "
            },
            {
              text: "follow up"
            }
          ]
        })
      )
    ).toEqual([
      {
        origin: "code",
        text: "explain snippet"
      },
      {
        origin: "user",
        text: "follow up"
      }
    ]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseAiQueueImportJson("{")).toThrow(/невалидный JSON/i);
  });

  it("rejects empty queue items", () => {
    expect(() => parseAiQueueImportJson(JSON.stringify(["   "]))).toThrow();
  });
});
