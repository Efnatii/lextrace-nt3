import { describe, expect, it } from "vitest";

import {
  parseRuntimeWorkerStatus,
  type NativeHostStatus,
  type WorkerStatus
} from "../../extension/src/shared/runtime-state";

describe("runtime-state helpers", () => {
  it("normalizes native-host runtime status with a fallback bootId", () => {
    const nativeStatus: NativeHostStatus = {
      running: true,
      sessionId: "session-1",
      hostConnected: true,
      taskId: null,
      startedAt: "2026-03-22T00:00:00.000Z",
      lastHeartbeatAt: "2026-03-22T00:00:05.000Z",
      reconnectAttempt: 2,
      nativeHostPid: 4242
    };

    expect(parseRuntimeWorkerStatus({ status: nativeStatus }, "boot-123")).toEqual({
      ...nativeStatus,
      bootId: "boot-123"
    });
  });

  it("accepts snapshot payloads that already carry workerStatus", () => {
    const workerStatus: WorkerStatus = {
      running: false,
      bootId: "boot-456",
      sessionId: null,
      hostConnected: false,
      taskId: null,
      startedAt: null,
      lastHeartbeatAt: null,
      reconnectAttempt: 0,
      nativeHostPid: null
    };

    expect(parseRuntimeWorkerStatus({ workerStatus })).toEqual(workerStatus);
  });
});
