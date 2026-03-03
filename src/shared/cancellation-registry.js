export class CancellationRegistry {
  constructor() {
    this.bySession = new Map();
  }

  createSession(pageSessionId) {
    const controller = new AbortController();
    this.bySession.set(pageSessionId, {
      controller,
      requestIds: new Set()
    });
    return controller.signal;
  }

  getSignal(pageSessionId) {
    return this.bySession.get(pageSessionId)?.controller.signal || null;
  }

  registerRequest(pageSessionId, requestId) {
    const session = this.bySession.get(pageSessionId);
    if (!session) {
      return;
    }
    session.requestIds.add(requestId);
  }

  unregisterRequest(pageSessionId, requestId) {
    const session = this.bySession.get(pageSessionId);
    if (!session) {
      return;
    }
    session.requestIds.delete(requestId);
  }

  cancelSession(pageSessionId) {
    const session = this.bySession.get(pageSessionId);
    if (!session) {
      return { requestIds: [] };
    }
    session.controller.abort();
    const requestIds = [...session.requestIds];
    this.bySession.delete(pageSessionId);
    return { requestIds };
  }

  clearSession(pageSessionId) {
    this.bySession.delete(pageSessionId);
  }
}