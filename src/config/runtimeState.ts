import { getRuntimeStatePath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface BridgeRuntimeState {
  lastProject?: string;
}

export function loadRuntimeState(): BridgeRuntimeState {
  return loadSecureJson<BridgeRuntimeState>(getRuntimeStatePath(), {});
}

export function saveRuntimeState(state: BridgeRuntimeState): void {
  saveSecureJson(getRuntimeStatePath(), state);
}
