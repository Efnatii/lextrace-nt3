import { DEFAULT_SETTINGS, DEFAULT_PROFILE_TEMPLATE, STORAGE_KEYS } from "./constants.js";
import { deepClone } from "./utils.js";

export class SettingsStore {
  async init() {
    const raw = await chrome.storage.local.get([
      STORAGE_KEYS.SETTINGS,
      STORAGE_KEYS.PROFILES
    ]);

    if (!raw?.[STORAGE_KEYS.SETTINGS]) {
      const defaults = this.withDefaultProfile(deepClone(DEFAULT_SETTINGS));
      await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: defaults });
    }

    if (!raw?.[STORAGE_KEYS.PROFILES]) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.PROFILES]: {
          default: deepClone(DEFAULT_PROFILE_TEMPLATE)
        }
      });
    }
  }

  withDefaultProfile(settings) {
    return {
      ...settings,
      profileDraft: deepClone(DEFAULT_PROFILE_TEMPLATE)
    };
  }

  async getSettings() {
    await this.init();
    const raw = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
    const settings = raw?.[STORAGE_KEYS.SETTINGS] || deepClone(DEFAULT_SETTINGS);
    if (!settings.profileDraft) {
      settings.profileDraft = deepClone(DEFAULT_PROFILE_TEMPLATE);
    }
    return settings;
  }

  async saveSettings(nextSettings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: nextSettings });
    return nextSettings;
  }

  async listProfiles() {
    await this.init();
    const raw = await chrome.storage.local.get([STORAGE_KEYS.PROFILES]);
    return raw?.[STORAGE_KEYS.PROFILES] || { default: deepClone(DEFAULT_PROFILE_TEMPLATE) };
  }

  async saveProfile(name, profile) {
    const profiles = await this.listProfiles();
    profiles[name] = profile;
    await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
    return profiles;
  }

  async deleteProfile(name) {
    if (name === "default") {
      return this.listProfiles();
    }
    const profiles = await this.listProfiles();
    delete profiles[name];
    await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
    return profiles;
  }
}
