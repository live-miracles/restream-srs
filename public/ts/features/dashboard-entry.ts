import { getUrlParam, setUrlParam, copyText } from '../core/utils.js';
import { refreshDashboard } from './dashboard.js';
import {
    openEditServerName,
    submitServerNameForm,
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
    onPullMethodChange,
} from './editor.js';

declare global {
    interface Window {
        openSrsLogsBtn: () => Promise<void>;
        editServerNameBtn: () => void;
        serverNameFormBtn: () => Promise<void>;
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
        outFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        outAddSink: () => void;
        outRemoveSink: (btn: HTMLElement) => void;
        outSinkServerChange: (select: HTMLSelectElement) => void;
        outPullMethodChange: () => void;
        copyText: (text: string) => Promise<void>;
        previewPlayBtn: () => Promise<void>;
        previewStopBtn: () => void;
        previewTrackChange: () => void;
    }
}

window.openSrsLogsBtn = () => showSrsLogs();
window.editServerNameBtn = () => openEditServerName();
window.serverNameFormBtn = () => submitServerNameForm();
window.openSettingsBtn = () => openSettings();
window.settingsFormBtn = (btn) => submitSettingsForm(btn);
window.logoutBtn = () => logoutUser();
window.regenerateStreamKeysBtn = (btn) => regenerateStreamKeysBtn(btn);

window.selectPipeline = (id) => {
    void import('./render.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
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

window.outFormBtn = (btn) => submitOutputForm(btn);
window.outAddSink = () => addSinkRow();
window.outRemoveSink = (btn) => removeSinkRow(btn);
window.outSinkServerChange = (select) => onSinkServerChange(select);
window.outPullMethodChange = () => onPullMethodChange();

window.copyText = copyText;

window.previewPlayBtn = async () => {
    const id = getUrlParam('p');
    if (!id) return;
    const [{ startPreview }, { attachHls, selectedPreviewTrack }] = await Promise.all([
        import('../core/api.js'),
        import('./render.js'),
    ]);
    const result = await startPreview(id, selectedPreviewTrack());
    if (result?.hlsUrl) attachHls(id, result.hlsUrl);
};

window.previewStopBtn = () => {
    void import('./render.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
};

window.previewTrackChange = () => {
    void import('./render.js').then(({ previewTrackChange }) => previewTrackChange());
};
