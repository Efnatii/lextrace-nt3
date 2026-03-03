import { MESSAGE, OFFSCREEN_DOCUMENT_PATH } from "../shared/constants.js";

export class OffscreenClient {
  constructor() {
    this.ensurePromise = null;
  }

  async ensureDocument() {
    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    this.ensurePromise = (async () => {
      const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      });

      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: ["WORKERS"],
          justification: "Need stable long-running translation requests independent from service worker lifecycle"
        });
      }
    })();

    await this.ensurePromise;
    this.ensurePromise = null;
  }

  async execute(payload) {
    await this.ensureDocument();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.OFFSCREEN_EXECUTE,
      payload
    });
    if (!response?.ok) {
      const error = new Error(response?.error || "Offscreen execution failed");
      error.status = response?.status;
      error.retryAfterMs = response?.retryAfterMs || 0;
      throw error;
    }
    return response.result;
  }

  async cancel(requestId, pageSessionId) {
    await this.ensureDocument();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.OFFSCREEN_CANCEL,
      requestId,
      pageSessionId
    });
    return response?.ok ? response.result : null;
  }
}
