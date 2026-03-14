import { z } from "zod";

export const WorkerStatusSchema = z.object({
  running: z.boolean(),
  bootId: z.string().min(1),
  sessionId: z.string().nullable(),
  hostConnected: z.boolean(),
  taskId: z.string().nullable(),
  startedAt: z.string().min(1).nullable(),
  lastHeartbeatAt: z.string().min(1).nullable(),
  reconnectAttempt: z.number().int().min(0),
  nativeHostPid: z.number().int().positive().nullable()
});

export const NativeHostStatusSchema = WorkerStatusSchema.omit({
  bootId: true
});

export const DesiredRuntimeStateSchema = z.object({
  desiredRunning: z.boolean(),
  desiredTaskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  reconnectAttempt: z.number().int().min(0),
  lastDisconnectAt: z.string().min(1).nullable()
});

export const PersistedRuntimeStateSchema = z.object({
  workerStatus: WorkerStatusSchema,
  desired: DesiredRuntimeStateSchema
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export type NativeHostStatus = z.infer<typeof NativeHostStatusSchema>;
export type DesiredRuntimeState = z.infer<typeof DesiredRuntimeStateSchema>;
export type PersistedRuntimeState = z.infer<typeof PersistedRuntimeStateSchema>;

export function createInitialWorkerStatus(bootId: string): WorkerStatus {
  return {
    running: false,
    bootId,
    sessionId: null,
    hostConnected: false,
    taskId: null,
    startedAt: null,
    lastHeartbeatAt: null,
    reconnectAttempt: 0,
    nativeHostPid: null
  };
}

export function createInitialDesiredRuntime(): DesiredRuntimeState {
  return {
    desiredRunning: false,
    desiredTaskId: null,
    sessionId: null,
    reconnectAttempt: 0,
    lastDisconnectAt: null
  };
}
