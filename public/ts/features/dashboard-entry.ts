import { getUrlParam, setUrlParam, copyText } from '../core/utils.js';
import { state } from '../core/state.js';
import { refreshDashboard, refreshAfterMutation } from './dashboard.js';
import {
    openSettings,
    submitSettingsForm,
    logoutUser,
    regenerateStreamKeysBtn,
    createPipeline,
    openEditPipeline,
    submitPipelineForm,
    confirmDeletePipeline,
    showPipelineLogs,
    showSrsLogs,
    openAddOutput,
    submitOutputForm,
    addSinkRow,
    removeSinkRow,
    onSinkServerChange,
    copyOutputs,
    pasteOutputs,
} from './editor.js';

declare global {
    interface Window {
        openSrsLogsBtn: () => Promise<void>;
        openSettingsBtn: () => void;
        settingsFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        logoutBtn: () => Promise<void>;
        regenerateStreamKeysBtn: (btn?: HTMLButtonElement) => Promise<void>;
        selectPipeline: (id: string | null) => void;
        addPipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        pipeFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        editPipeBtn: () => void;
        deletePipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        pipeHistoryBtn: () => Promise<void>;
        addOutBtn: () => void;
        outputsCopyBtn: () => Promise<void>;
        outputsPasteBtn: () => Promise<void>;
        outFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        outAddSink: () => void;
        outRemoveSink: (btn: HTMLElement) => void;
        outSinkServerChange: (select: HTMLSelectElement) => void;
        copyText: (text: string) => Promise<void>;
        previewToggleBtn: () => Promise<void>;
        previewTrackChange: () => void;
        previewMuteBtn: () => void;
        previewReloadBtn: () => void;
        previewMaximizeBtn: () => void;
        reloadConfigBtn: () => Promise<void>;
    }
}

// Refetch config (and re-render) after the config was changed by another client.
// refreshAfterMutation invalidates the cached config so it is reloaded, which
// resyncs the loaded configRev and clears the "config changed" banner.
window.reloadConfigBtn = () => refreshAfterMutation();

window.openSrsLogsBtn = () => showSrsLogs();
window.openSettingsBtn = () => openSettings();
window.settingsFormBtn = (btn) => submitSettingsForm(btn);
window.logoutBtn = () => logoutUser();
window.regenerateStreamKeysBtn = (btn) => regenerateStreamKeysBtn(btn);

window.selectPipeline = (id) => {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', id);
    void refreshDashboard();
};

window.addPipeBtn = (btn) => createPipeline(btn);
window.pipeFormBtn = (btn) => submitPipelineForm(btn);

window.editPipeBtn = () => {
    if (document.getElementById('pipe-edit-btn')?.classList.contains('btn-disabled')) return;
    const id = getUrlParam('p');
    if (id) openEditPipeline(id);
};

window.deletePipeBtn = async (btn) => {
    if (document.getElementById('pipe-delete-btn')?.classList.contains('btn-disabled')) return;
    const id = getUrlParam('p');
    if (id) await confirmDeletePipeline(id, btn);
};

window.pipeHistoryBtn = async () => {
    const id = getUrlParam('p');
    if (id) await showPipelineLogs(id);
};

window.addOutBtn = () => {
    const id = getUrlParam('p');
    if (id) openAddOutput(id);
};

window.outputsCopyBtn = async () => {
    const id = getUrlParam('p');
    if (id) await copyOutputs(id);
};

window.outputsPasteBtn = async () => {
    const id = getUrlParam('p');
    const btn = document.getElementById('outputs-paste-btn') as HTMLButtonElement | null;
    if (id && btn) await pasteOutputs(id, btn);
};

window.outFormBtn = (btn) => submitOutputForm(btn);
window.outAddSink = () => addSinkRow();
window.outRemoveSink = (btn) => removeSinkRow(btn);
window.outSinkServerChange = (select) => onSinkServerChange(select);

window.copyText = copyText;

window.previewToggleBtn = async () => {
    const {
        getPreviewPipelineId,
        stopCurrentPreview,
        attachHls,
        setPreviewStarting,
        syncPreviewControls,
    } = await import('./preview.js');
    if (getPreviewPipelineId()) {
        stopCurrentPreview();
        return;
    }
    const id = getUrlParam('p');
    if (!id) return;
    setPreviewStarting();
    const { startPreview } = await import('../core/api.js');
    const pipeline = state.pipelines.find((p) => p.id === id);
    const audioTrackCount = Math.max(1, pipeline?.input.audioTracks.length ?? 1);
    const result = await startPreview(id, audioTrackCount);
    if (result?.hlsUrl) {
        attachHls(id, result.hlsUrl);
    } else {
        syncPreviewControls(false);
    }
};

window.previewTrackChange = () => {
    void import('./preview.js').then(({ previewTrackChange }) => previewTrackChange());
};

window.previewMuteBtn = () => {
    void import('./preview.js').then(({ togglePreviewMute }) => togglePreviewMute());
};

window.previewReloadBtn = () => {
    void import('./preview.js').then(({ reloadPreview }) => reloadPreview());
};

window.previewMaximizeBtn = () => {
    void import('./preview.js').then(({ togglePreviewMaximize }) => togglePreviewMaximize());
};
