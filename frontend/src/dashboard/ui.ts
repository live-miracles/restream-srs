import { writable } from 'svelte/store';
import type { SrtRelayStatus } from './types.js';

export interface DashboardUiState {
    serverUnreachable: boolean;
    saving: boolean;
    errorMessage: string | null;
    srsReachable: boolean | null;
    srtRelay: SrtRelayStatus | null;
}

export const dashboardUi = writable<DashboardUiState>({
    serverUnreachable: false,
    saving: false,
    errorMessage: null,
    srsReachable: null,
    srtRelay: null,
});

let errorTimer: ReturnType<typeof setTimeout> | null = null;

export function showUiError(message: unknown): void {
    if (errorTimer) clearTimeout(errorTimer);
    dashboardUi.update((current) => ({ ...current, errorMessage: String(message) }));
    errorTimer = setTimeout(() => {
        dashboardUi.update((current) => ({ ...current, errorMessage: null }));
        errorTimer = null;
    }, 5000);
}
