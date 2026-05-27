import { getUrlParam, setUrlParam, copyText } from '../core/utils.js';
import { refreshDashboard } from './dashboard.js';
import {
    openEditServerName,
    submitServerNameForm,
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
        selectPipeline: (id: string | null) => void;
        addPipeBtn: () => Promise<void>;
        pipeFormBtn: () => Promise<void>;
        editPipeBtn: () => void;
        deletePipeBtn: () => Promise<void>;
        addOutBtn: () => void;
        outFormBtn: () => Promise<void>;
        outServerChange: () => void;
        copyText: (text: string) => Promise<void>;
        previewPlayBtn: () => Promise<void>;
        previewStopBtn: () => void;
    }
}

window.editServerNameBtn = () => openEditServerName();
window.serverNameFormBtn = () => submitServerNameForm();

window.selectPipeline = (id) => {
    void import('./render.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', id);
    void refreshDashboard();
};

window.addPipeBtn = () => createPipeline();
window.pipeFormBtn = () => submitPipelineForm();

window.editPipeBtn = () => {
    const id = getUrlParam('p');
    if (id) openEditPipeline(id);
};

window.deletePipeBtn = async () => {
    const id = getUrlParam('p');
    if (id) await confirmDeletePipeline(id);
};

window.addOutBtn = () => {
    const id = getUrlParam('p');
    if (id) openAddOutput(id);
};

window.outFormBtn = () => submitOutputForm();
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
