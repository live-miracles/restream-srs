import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Request } from 'zeromq';
import { buildTranslationMixerArgs, volumePercentToAmplitude } from '../utils/ffmpeg.js';
import { readAppConfig } from '../utils/appConfig.js';
import type { Db, Output, TranslationConfig } from '../types.js';
import type { InputProtocol, InputState } from './inputState.js';
import type { OutputService } from './outputs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';

const RECONCILE_INTERVAL_MS = 1000;
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const MIXER_CONTROL_PORT_BASE = 31000;
const MIXER_CONTROL_PORT_RANGE = 20000;
const MODE_SWITCH_DOWN_GRACE_MS = 12000;
const MODE_SWITCH_UP_GRACE_MS = 3000;
const METER_VOICE_PATTERN = /lavfi\.astats\.Overall\.Peak_level=(-?\d+(?:\.\d+)?|-inf)/;
const appConfig = readAppConfig();

interface MixerJob {
    process: ChildProcess;
    mode: 'source-only' | 'translated';
    fingerprint: string;
    configFingerprint: string;
    translatorLive: boolean;
    translatorProtocol: 'srt' | 'rtmp' | null;
    stderrTail: string;
    controller: MixerStateController;
    controlPort: number | null;
    startedAtMs: number;
    lastOutputProgressAtMs: number;
    lastOutTimeUs: number | null;
    lastTotalSizeBytes: number | null;
}

interface MixerStateController {
    onMeterPeakDb(db: number): void;
    onTranslatorUnavailable(): void;
    close(): void;
}

export interface TranslationMixerService {
    start(): void;
    shutdown(): void;
}

function appendTail(existing: string, chunk: Buffer): string {
    const next = existing + chunk.toString('utf8');
    return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
}

function createMixerStateController(mix: TranslationConfig, socket: Request): MixerStateController {
    let currentGain = volumePercentToAmplitude(mix.restoreVolume2Percent);
    let lastVoiceAt = 0;
    let hasDetectedVoice = false;
    let state: 'normal' | 'ducked' | 'restored1' | 'restored2' = 'normal';
    let rampTimer: NodeJS.Timeout | null = null;
    let commandChain = Promise.resolve();
    let closed = false;

    function sendGain(gain: number): void {
        if (closed) return;
        const bounded = Math.max(0, Math.min(1, gain));
        commandChain = commandChain
            .then(async () => {
                await socket.send(`volume@source_gain volume ${bounded}`);
                await socket.receive();
            })
            .catch(() => {});
    }

    function rampTo(target: number, durationMs: number): void {
        if (rampTimer) clearInterval(rampTimer);
        const start = currentGain;
        const boundedTarget = Math.max(0, Math.min(1, target));
        const duration = Math.max(0, durationMs);
        if (duration === 0) {
            currentGain = boundedTarget;
            sendGain(currentGain);
            return;
        }
        const startedAt = Date.now();
        rampTimer = setInterval(() => {
            const progress = Math.min(1, (Date.now() - startedAt) / duration);
            currentGain = start + (boundedTarget - start) * progress;
            sendGain(currentGain);
            if (progress >= 1 && rampTimer) {
                clearInterval(rampTimer);
                rampTimer = null;
            }
        }, 50);
        rampTimer.unref?.();
    }

    function onMeterPeakDb(db: number): void {
        const speaking = Number.isFinite(db) && db >= mix.voiceThresholdDb;
        const now = Date.now();
        if (speaking) {
            hasDetectedVoice = true;
            lastVoiceAt = now;
            if (state !== 'ducked') {
                state = 'ducked';
                rampTo(volumePercentToAmplitude(mix.duckVolumePercent), mix.duckDurationMs);
            }
            return;
        }
        if (!hasDetectedVoice) return;
        const silenceMs = now - lastVoiceAt;
        if (silenceMs >= mix.restoreSilence2Ms && state !== 'restored2') {
            state = 'restored2';
            rampTo(volumePercentToAmplitude(mix.restoreVolume2Percent), mix.restoreDuration2Ms);
        } else if (silenceMs >= mix.restoreSilenceMs && state === 'ducked') {
            state = 'restored1';
            rampTo(volumePercentToAmplitude(mix.restoreVolumePercent), mix.restoreDurationMs);
        }
    }

    sendGain(currentGain);
    return {
        onMeterPeakDb,
        onTranslatorUnavailable: () => {
            hasDetectedVoice = false;
            lastVoiceAt = 0;
            state = 'normal';
            rampTo(volumePercentToAmplitude(mix.restoreVolume2Percent), mix.restoreDuration2Ms);
        },
        close: () => {
            closed = true;
            if (rampTimer) clearInterval(rampTimer);
        },
    };
}

export interface ModeTracker {
    candidateLive: boolean;
    since: number;
    effectiveLive: boolean;
}

export function nextDebouncedMode(
    tracker: ModeTracker | undefined,
    rawLive: boolean,
    now: number,
): { tracker: ModeTracker; mode: 'source-only' | 'translated' } {
    const next = tracker ?? { candidateLive: rawLive, since: now, effectiveLive: rawLive };
    if (rawLive !== next.candidateLive) {
        next.candidateLive = rawLive;
        next.since = now;
    }
    const graceMs = next.candidateLive ? MODE_SWITCH_UP_GRACE_MS : MODE_SWITCH_DOWN_GRACE_MS;
    if (next.candidateLive !== next.effectiveLive && now - next.since >= graceMs) {
        next.effectiveLive = next.candidateLive;
    }
    return { tracker: next, mode: next.effectiveLive ? 'translated' : 'source-only' };
}

export function selectControlPort(outputId: string, usedPorts: ReadonlySet<number>): number {
    const hash = [...outputId].reduce(
        (value, char) => (value * 31 + char.charCodeAt(0)) % MIXER_CONTROL_PORT_RANGE,
        0,
    );
    for (let offset = 0; offset < MIXER_CONTROL_PORT_RANGE; offset++) {
        const port = MIXER_CONTROL_PORT_BASE + ((hash + offset) % MIXER_CONTROL_PORT_RANGE);
        if (!usedPorts.has(port)) return port;
    }
    return MIXER_CONTROL_PORT_BASE + hash;
}

function terminateProcess(process: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve();
        };
        const killTimer = setTimeout(() => {
            try {
                if (!process.kill('SIGKILL')) finish();
            } catch {
                finish();
            }
        }, SIGKILL_DELAY_MS);
        killTimer.unref?.();
        process.once('exit', finish);
        try {
            if (!process.kill('SIGTERM')) finish();
        } catch {
            finish();
        }
    });
}

export function createTranslationMixerService(
    db: Db,
    inputState: InputState,
    outputService: OutputService,
    diagnostics?: DiagnosticsLogger,
): TranslationMixerService {
    const jobs = new Map<string, MixerJob>();
    const modeTrackers = new Map<string, ModeTracker>();
    const stopRequested = new Set<string>();
    const usedControlPorts = new Set<number>();
    let reconciling = false;
    let shuttingDown = false;

    const timer = setInterval(() => {
        void reconcile();
    }, RECONCILE_INTERVAL_MS);
    timer.unref?.();

    function allocateControlPort(outputId: string): number {
        const port = selectControlPort(outputId, usedControlPorts);
        usedControlPorts.add(port);
        return port;
    }

    async function stopJob(outputId: string, requestedStop = true): Promise<void> {
        const job = jobs.get(outputId);
        if (!job) return;
        jobs.delete(outputId);
        if (requestedStop) stopRequested.add(outputId);
        job.controller.close();
        await terminateProcess(job.process);
    }

    function configFingerprint(output: Output, mix: TranslationConfig): string {
        return JSON.stringify({
            translatorPipelineId: mix.translatorPipelineId,
            sourceProtocol: inputState.getProtocol(output.pipelineId),
            delay: mix.translationDelayMs,
            thresholdDb: mix.voiceThresholdDb,
            duckVolume: mix.duckVolumePercent,
            duckDuration: mix.duckDurationMs,
            restoreSilence: mix.restoreSilenceMs,
            restoreVolume: mix.restoreVolumePercent,
            restoreDuration: mix.restoreDurationMs,
            restoreSilence2: mix.restoreSilence2Ms,
            restoreVolume2: mix.restoreVolume2Percent,
            restoreDuration2: mix.restoreDuration2Ms,
            outputUrl: output.url,
            videoEncoding: output.videoEncoding,
        });
    }

    function jobFingerprint(
        output: Output,
        mix: TranslationConfig,
        mode: 'source-only' | 'translated',
        translatorProtocol: InputProtocol | null,
    ): string {
        return JSON.stringify({
            config: configFingerprint(output, mix),
            mode,
            translatorProtocol: mode === 'translated' ? translatorProtocol : null,
        });
    }

    async function startJob(
        mix: TranslationConfig,
        output: Output,
        mode: 'source-only' | 'translated',
        fingerprint: string,
        configFp: string,
    ): Promise<void> {
        const source = db.getPipeline(output.pipelineId);
        const translator = db.getPipeline(mix.translatorPipelineId);
        if (!source) return;
        const sourceUrl = inputState.pullUrl(source.id, source.streamKey);
        const translatorProtocol = translator ? inputState.getProtocol(translator.id) : null;
        const translatorUrl =
            mode === 'translated' && translator
                ? inputState.pullUrl(translator.id, translator.streamKey)
                : null;
        const controlPort = mode === 'translated' ? allocateControlPort(output.id) : null;
        const args = buildTranslationMixerArgs(sourceUrl, translatorUrl, output.url, {
            ...mix,
            videoEncoding: output.videoEncoding,
            controlPort: controlPort ?? MIXER_CONTROL_PORT_BASE,
        });
        let child: ChildProcess;
        const control = controlPort === null ? null : new Request();
        try {
            child = spawn(appConfig.ffmpegPath, args, {
                stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
                env: process.env,
            });
            control?.connect(`tcp://127.0.0.1:${controlPort}`);
        } catch (error) {
            try {
                control?.close();
            } catch {
                /* already closed */
            }
            if (controlPort !== null) usedControlPorts.delete(controlPort);
            throw error;
        }
        const controller =
            control === null
                ? {
                      onMeterPeakDb: () => {},
                      onTranslatorUnavailable: () => {},
                      close: () => {},
                  }
                : createMixerStateController(mix, control);
        const job: MixerJob = {
            process: child,
            mode,
            fingerprint,
            configFingerprint: configFp,
            translatorLive: inputState.isLive(mix.translatorPipelineId),
            translatorProtocol,
            stderrTail: '',
            controller,
            controlPort,
            startedAtMs: Date.now(),
            lastOutputProgressAtMs: Date.now(),
            lastOutTimeUs: null,
            lastTotalSizeBytes: null,
        };
        jobs.set(output.id, job);
        stopRequested.delete(output.id);
        outputService.reportExternalStatus(output.id, 'running', child.pid ?? null);
        diagnostics?.event('translation-mixer-started', {
            outputId: output.id,
            pid: child.pid ?? null,
            mode,
            sourcePipelineId: output.pipelineId,
            translatorPipelineId: mix.translatorPipelineId,
            outputUrl: output.url,
        });

        let progressBuffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            progressBuffer += chunk.toString();
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.startsWith('total_size=')) {
                    const value = Number(line.slice('total_size='.length));
                    if (
                        Number.isFinite(value) &&
                        (job.lastTotalSizeBytes === null || value > job.lastTotalSizeBytes)
                    ) {
                        job.lastTotalSizeBytes = value;
                        job.lastOutputProgressAtMs = Date.now();
                    }
                } else if (line.startsWith('out_time_ms=')) {
                    const value = Number(line.slice('out_time_ms='.length));
                    if (
                        Number.isFinite(value) &&
                        (job.lastOutTimeUs === null || value > job.lastOutTimeUs)
                    ) {
                        job.lastOutTimeUs = value;
                        job.lastOutputProgressAtMs = Date.now();
                    }
                }
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            const current = jobs.get(output.id);
            if (current) current.stderrTail = appendTail(current.stderrTail, chunk);
        });
        child.stdio?.[3]?.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                const match = line.match(METER_VOICE_PATTERN);
                if (match)
                    controller.onMeterPeakDb(match[1] === '-inf' ? -Infinity : Number(match[1]));
            }
        });
        child.once('error', (error) => {
            diagnostics?.event('translation-mixer-error', {
                outputId: output.id,
                message: error.message,
            });
        });
        child.once('exit', (code, signal) => {
            controller.close();
            void control?.close();
            if (controlPort !== null) usedControlPorts.delete(controlPort);
            const wasStop = stopRequested.delete(output.id);
            const current = jobs.get(output.id);
            if (current?.process === child) {
                jobs.delete(output.id);
                const message =
                    current.stderrTail.trim() || `FFmpeg exited code=${code} signal=${signal}`;
                diagnostics?.event('translation-mixer-exited', {
                    outputId: output.id,
                    pid: child.pid ?? null,
                    code,
                    signal,
                    message,
                    requestedStop: wasStop,
                });
                if (!shuttingDown) {
                    try {
                        db.setOutputLastError(
                            output.id,
                            wasStop ? current.stderrTail.trim() : message,
                            wasStop ? 'stopped' : 'crash',
                        );
                    } catch {
                        /* non-critical */
                    }
                }
            }
            if (!jobs.has(output.id) || jobs.get(output.id)?.process === child) {
                outputService.reportExternalStatus(output.id, wasStop ? 'stopped' : 'failed', null);
            }
        });
    }

    async function checkMixerWatchdogs(): Promise<void> {
        const now = Date.now();
        const { warmupMs, stallMs } = appConfig.outputWatchdog;
        for (const [outputId, job] of jobs) {
            const output = db.getOutput(outputId);
            if (
                !output ||
                output.desiredState !== 'running' ||
                !inputState.isLive(output.pipelineId)
            )
                continue;
            if (now - job.startedAtMs < warmupMs || now - job.lastOutputProgressAtMs <= stallMs)
                continue;
            const message = [
                'watchdog: translation mixer output stalled; restarting process',
                `pid=${job.process.pid ?? 'unknown'}`,
                `no_output_progress_for=${Math.round((now - job.lastOutputProgressAtMs) / 1000)}s`,
                job.stderrTail.trim()
                    ? `ffmpeg stderr tail:\n${job.stderrTail.trim()}`
                    : 'ffmpeg stderr tail: <empty>',
            ].join('\n');
            try {
                db.setOutputLastError(outputId, message, 'crash');
            } catch {
                /* still restart the stuck process */
            }
            diagnostics?.event('translation-mixer-restart', {
                outputId,
                reason: 'output progress stalled',
            });
            await stopJob(outputId, false);
        }
    }

    async function reconcile(): Promise<void> {
        if (reconciling || shuttingDown) return;
        reconciling = true;
        try {
            await checkMixerWatchdogs();
            const configured = db
                .listOutputs()
                .filter(
                    (output) =>
                        output.desiredState === 'running' &&
                        output.audioEncoding === 'translation' &&
                        output.translation !== null,
                );
            const configuredIds = new Set(configured.map((output) => output.id));
            for (const outputId of jobs.keys()) {
                if (!configuredIds.has(outputId)) await stopJob(outputId);
            }
            for (const output of configured) {
                try {
                    if (!inputState.isLive(output.pipelineId)) {
                        if (jobs.has(output.id)) await stopJob(output.id);
                        continue;
                    }
                    const mix = output.translation!;
                    const translatorLive = inputState.isLive(mix.translatorPipelineId);
                    const translatorProtocol = inputState.getProtocol(mix.translatorPipelineId);
                    const modeState = nextDebouncedMode(
                        modeTrackers.get(output.id),
                        translatorLive,
                        Date.now(),
                    );
                    modeTrackers.set(output.id, modeState.tracker);
                    const configFp = configFingerprint(output, mix);
                    const current = jobs.get(output.id);

                    if (current?.mode === 'translated' && !translatorLive) {
                        if (current.translatorLive) current.controller.onTranslatorUnavailable();
                        current.translatorLive = false;
                        // Keep the existing translated graph alive. amix keeps
                        // the source leg flowing while the translator leg is
                        // silent/ended, so a translator outage does not drop
                        // the destination output.
                        if (current.configFingerprint === configFp) continue;
                    }

                    if (
                        current?.mode === 'translated' &&
                        translatorLive &&
                        !current.translatorLive
                    ) {
                        // The network input has reached EOF, so it cannot see
                        // the new translator session. Reopen only this mixer
                        // after a short stable-live grace period; this is the
                        // one deliberate small destination interruption.
                        if (modeState.mode !== 'translated') continue;
                        await stopJob(output.id);
                        await startJob(
                            mix,
                            output,
                            'translated',
                            jobFingerprint(output, mix, 'translated', translatorProtocol),
                            configFp,
                        );
                        continue;
                    }

                    const fingerprint = jobFingerprint(
                        output,
                        mix,
                        modeState.mode,
                        translatorProtocol,
                    );
                    if (current?.mode === modeState.mode && current.fingerprint === fingerprint) {
                        current.translatorLive = translatorLive;
                        continue;
                    }
                    if (current) await stopJob(output.id);
                    await startJob(mix, output, modeState.mode, fingerprint, configFp);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    diagnostics?.event('translation-mixer-reconcile-error', {
                        outputId: output.id,
                        message,
                    });
                    outputService.reportExternalStatus(output.id, 'failed', null);
                    console.error(`[translation-mixer] ${output.id} reconcile failed: ${message}`);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diagnostics?.event('translation-mixer-reconcile-failed', { message });
            console.error(`[translation-mixer] reconcile failed: ${message}`);
        } finally {
            reconciling = false;
        }
    }

    function start(): void {
        void reconcile();
    }

    function shutdown(): void {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(timer);
        for (const outputId of jobs.keys()) void stopJob(outputId);
    }

    return { start, shutdown };
}
