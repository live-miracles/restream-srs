import * as api from './api.js';
import { refreshAfterMutation } from '../features/dashboard.js';

export async function startOutput(pipelineId: string, outputId: string): Promise<void> {
    await api.startOutput(pipelineId, outputId);
    await refreshAfterMutation();
}

export async function stopOutput(pipelineId: string, outputId: string): Promise<void> {
    await api.stopOutput(pipelineId, outputId);
    await refreshAfterMutation();
}

export async function confirmDeleteOutput(pipelineId: string, outputId: string): Promise<void> {
    if (!confirm(`Delete output ${outputId}?`)) return;
    const ok = await api.deleteOutput(pipelineId, outputId);
    if (ok) await refreshAfterMutation();
}
