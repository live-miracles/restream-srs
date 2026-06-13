import { getUrlParam, setUrlParam, copyText } from '../core/utils.js';
import { refreshDashboard } from './dashboard.js';
import {
    openEditServerName,
    submitServerNameForm,
    openSettings,
    submitSettingsForm,
    logoutUser,
    createPipeline,
    openEditPipeline,
    submitPipelineForm,
    confirmDeletePipeline,
    openAddOutput,
    submitOutputForm,
    onOutServerChange,
} from './editor.js';

declare global {
    interface Window {
        editServerNameBtn: () => void;
        serverNameFormBtn: () => Promise<void>;
        openSettingsBtn: () => void;
        settingsFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        logoutBtn: () => Promise<void>;
        selectPipeline: (id: string | null) => void;
        addPipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        pipeFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        editPipeBtn: () => void;
        deletePipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        addOutBtn: () => void;
        outFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        outServerChange: () => void;
        copyText: (text: string) => Promise<void>;
        previewPlayBtn: () => Promise<void>;
        previewStopBtn: () => void;
    }
}

window.editServerNameBtn = () => openEditServerName();
window.serverNameFormBtn = () => submitServerNameForm();
window.openSettingsBtn = () => openSettings();
window.settingsFormBtn = (btn) => submitSettingsForm(btn);
window.logoutBtn = () => logoutUser();

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

window.addOutBtn = () => {
    const id = getUrlParam('p');
    if (id) openAddOutput(id);
};

window.outFormBtn = (btn) => submitOutputForm(btn);
window.outServerChange = () => onOutServerChange();

window.copyText = copyText;

window.previewPlayBtn = async () => {
    const id = getUrlParam('p');
    if (!id) return;
    const [{ startPreview }, { attachHls }] = await Promise.all([
        import('../core/api.js'),
        import('./render.js'),
    ]);
    const result = await startPreview(id);
    if (result?.hlsUrl) attachHls(id, result.hlsUrl);
};

window.previewStopBtn = () => {
    void import('./render.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
};
