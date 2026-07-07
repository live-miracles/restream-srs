import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';

export type InputProtocol = 'srt' | 'rtmp';

export interface InputState {
    setSrsReachable(reachable: boolean): void;
    setPipelineState(pipelineId: number, live: boolean, protocol: InputProtocol | null): void;
    clearPipeline(pipelineId: number): void;
    isLive(pipelineId: number): boolean;
    isReady(pipelineId: number): boolean;
    getProtocol(pipelineId: number): InputProtocol | null;
    pullUrl(pipelineId: number, streamKey: string): string;
}

export function inputPullUrl(streamKey: string, protocol: InputProtocol | null): string {
    return protocol === 'srt' ? srtPullUrl(streamKey) : rtmpPullUrl(streamKey);
}

export function createInputState(): InputState {
    let srsReachable = false;
    const liveInputs = new Map<number, boolean>();
    const inputProtocols = new Map<number, InputProtocol>();

    return {
        setSrsReachable(reachable: boolean): void {
            srsReachable = reachable;
        },

        setPipelineState(pipelineId: number, live: boolean, protocol: InputProtocol | null): void {
            liveInputs.set(pipelineId, live);
            if (protocol) {
                inputProtocols.set(pipelineId, protocol);
            } else {
                inputProtocols.delete(pipelineId);
            }
        },

        clearPipeline(pipelineId: number): void {
            liveInputs.delete(pipelineId);
            inputProtocols.delete(pipelineId);
        },

        isLive(pipelineId: number): boolean {
            return liveInputs.get(pipelineId) ?? false;
        },

        isReady(pipelineId: number): boolean {
            return srsReachable && (liveInputs.get(pipelineId) ?? false);
        },

        getProtocol(pipelineId: number): InputProtocol | null {
            return inputProtocols.get(pipelineId) ?? null;
        },

        pullUrl(pipelineId: number, streamKey: string): string {
            return inputPullUrl(streamKey, inputProtocols.get(pipelineId) ?? null);
        },
    };
}
