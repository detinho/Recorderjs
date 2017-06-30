import InlineWorker from 'inline-worker';

export class Recorder {
    config = {
        bufferLen: 4096,
        numChannels: 2,
        mimeType: 'audio/wav',
        downsampleTo: null
    };

    recording = false;
    recordingAll = false;

    callbacks = {
        getBuffer: [],
        exportWAV: []
    };

    onSilenceCallback = null;
    onOutOfSilenceCallback = null;

    constructor(source, cfg) {
        Object.assign(this.config, cfg);
        this.context = source.context;
        this.node = (this.context.createScriptProcessor ||
        this.context.createJavaScriptNode).call(this.context,
            this.config.bufferLen, this.config.numChannels, this.config.numChannels);

        this.analyser = source.context.createAnalyser();
        this.analyser.minDecibels = -90;
        this.analyser.maxDecibels = -10;
        this.analyser.smoothingTimeConstant = 0.85;
        this.analyser.connect(this.node);
        source.connect(this.analyser);

        this.start = Date.now();
        this.isInSilence = true;
        this.lastBufferOnSilence = {
            'last': [],
            'beforeLast': []
        };

        this.node.onaudioprocess = (e) => {
            if (!this.recordingAll) return;

            var bufferLength = this.analyser.fftSize;
            var dataArray = new Uint8Array(bufferLength);
            this.analyser.getByteTimeDomainData(dataArray);

            var curr_value_time = (dataArray[0] / 128) - 1.0;

            if (curr_value_time > 0.07 || curr_value_time < -0.07) {
                if (this.isInSilence && this.onOutOfSilenceCallback) {
                    this.onOutOfSilenceCallback();
                }
                this.isInSilence = false;
                this.start = Date.now();
            }

            var newtime = Date.now();
            var elapsedTime = newtime - this.start;
            if (elapsedTime > 700) {
                if (!this.isInSilence && this.onSilenceCallback) {
                    this.onSilenceCallback();
                }
                this.isInSilence = true;

                this.lastBufferOnSilence['beforeLast'] = this.lastBufferOnSilence['last'];
                this.lastBufferOnSilence['last'] = [];
                for (var channel = 0; channel < this.config.numChannels; channel++) {
                    this.lastBufferOnSilence['last'].push(e.inputBuffer.getChannelData(channel));
                }
            }

            if (!this.recording) return;

            var buffer = [];
            for (var channel = 0; channel < this.config.numChannels; channel++) {
                buffer.push(e.inputBuffer.getChannelData(channel));
            }

            if (this.lastBufferOnSilence['beforeLast'].length) {
                this.worker.postMessage({
                    command: 'record',
                    buffer: this.lastBufferOnSilence['beforeLast']
                });
            }

            if (this.lastBufferOnSilence['last'].length) {
                this.worker.postMessage({
                    command: 'record',
                    buffer: this.lastBufferOnSilence['last']
                });
            }

            this.lastBufferOnSilence = {
                'last': [],
                'beforeLast': []
            };

            this.worker.postMessage({
                command: 'record',
                buffer: buffer
            });
        };

        source.connect(this.node);
        this.node.connect(this.context.destination);    //this should not be necessary

        let self = {};
        this.worker = new InlineWorker(function () {
            let recLength = 0,
                recBuffers = [],
                sampleRate,
                numChannels,
                downsampleTo;

            this.onmessage = function (e) {
                switch (e.data.command) {
                    case 'init':
                        init(e.data.config);
                        break;
                    case 'record':
                        record(e.data.buffer);
                        break;
                    case 'exportWAV':
                        exportWAV(e.data.type);
                        break;
                    case 'getBuffer':
                        getBuffer();
                        break;
                    case 'clear':
                        clear();
                        break;
                }
            };

            function init(config) {
                sampleRate = config.sampleRate;
                numChannels = config.numChannels;
                downsampleTo = config.downsampleTo;
                initBuffers();
            }

            function record(inputBuffer) {
                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel].push(inputBuffer[channel]);
                }
                recLength += inputBuffer[0].length;
            }

            function exportWAV(type) {
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                let interleaved;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                let dataview = encodeWAV(interleaved);
                let audioBlob = new Blob([dataview], {type: type});

                this.postMessage({command: 'exportWAV', data: audioBlob});
            }

            function getBuffer() {
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                this.postMessage({command: 'getBuffer', data: buffers});
            }

            function clear() {
                recLength = 0;
                recBuffers = [];
                this.isInSilence = true;
                this.start = Date.now();
                initBuffers();
            }

            function initBuffers() {
                for (let channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel] = [];
                }
                this.lastBufferOnSilence = {
                    'last': [],
                    'beforeLast': []
                };
            }

            function mergeBuffers(recBuffers, recLength) {
                let result = new Float32Array(recLength);
                let offset = 0;
                for (let i = 0; i < recBuffers.length; i++) {
                    result.set(recBuffers[i], offset);
                    offset += recBuffers[i].length;
                }
                return result;
            }

            function interleave(inputL, inputR) {
                let length = inputL.length + inputR.length;
                let result = new Float32Array(length);

                let index = 0,
                    inputIndex = 0;

                while (index < length) {
                    result[index++] = inputL[inputIndex];
                    result[index++] = inputR[inputIndex];
                    inputIndex++;
                }
                return result;
            }

            function floatTo16BitPCM(output, offset, input) {
                for (let i = 0; i < input.length; i++, offset += 2) {
                    let s = Math.max(-1, Math.min(1, input[i]));
                    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
            }

            function writeString(view, offset, string) {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            function encodeWAV(samples) {
                const oldSampleRate = sampleRate;

                if (downsampleTo) {
                    samples = downsampleBuffer(samples, downsampleTo);
                    sampleRate = downsampleTo;
                }
                let buffer = new ArrayBuffer(44 + samples.length * 2);
                let view = new DataView(buffer);

                /* RIFF identifier */
                writeString(view, 0, 'RIFF');
                /* RIFF chunk length */
                view.setUint32(4, 36 + samples.length * 2, true);
                /* RIFF type */
                writeString(view, 8, 'WAVE');
                /* format chunk identifier */
                writeString(view, 12, 'fmt ');
                /* format chunk length */
                view.setUint32(16, 16, true);
                /* sample format (raw) */
                view.setUint16(20, 1, true);
                /* channel count */
                view.setUint16(22, numChannels, true);
                /* sample rate */
                view.setUint32(24, sampleRate, true);
                /* byte rate (sample rate * block align) */
                view.setUint32(28, sampleRate * 4, true);
                /* block align (channel count * bytes per sample) */
                view.setUint16(32, numChannels * 2, true);
                /* bits per sample */
                view.setUint16(34, 16, true);
                /* data chunk identifier */
                writeString(view, 36, 'data');
                /* data chunk length */
                view.setUint32(40, samples.length * 2, true);

                floatTo16BitPCM(view, 44, samples);

                sampleRate = oldSampleRate;

                return view;
            }

            /*Based on https://github.com/awslabs/aws-lex-browser-audio-capture */
            function downsampleBuffer(buffer, newSampleRate) {
                var sampleRateRatio = sampleRate / newSampleRate;
                var newLength = Math.round(buffer.length / sampleRateRatio);
                var result = new Float32Array(newLength);
                var offsetResult = 0;
                var offsetBuffer = 0;
                while (offsetResult < result.length) {
                    var nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
                    var accum = 0,
                    count = 0;
                    for (var i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                        accum += buffer[i];
                        count++;
                    }
                    result[offsetResult] = accum / count;
                    offsetResult++;
                    offsetBuffer = nextOffsetBuffer;
                }
                return result;
            }

        }, self);

        this.worker.postMessage({
            command: 'init',
            config: {
                sampleRate: this.context.sampleRate,
                numChannels: this.config.numChannels,
                downsampleTo: this.config.downsampleTo
            }
        });

        this.worker.onmessage = (e) => {
            let cb = this.callbacks[e.data.command].pop();
            if (typeof cb == 'function') {
                cb(e.data.data);
            }
        };
    }


    record() {
        this.recording = true;
        this.recordingAll = true;
    }

    stop() {
        this.recording = false;
    }

    pause() {
        this.recordingAll = false;
    }

    resume() {
        this.recordingAll = true;
    }

    clear() {
        this.worker.postMessage({command: 'clear'});
    }

    getBuffer(cb) {
        cb = cb || this.config.callback;
        if (!cb) throw new Error('Callback not set');

        this.callbacks.getBuffer.push(cb);

        this.worker.postMessage({command: 'getBuffer'});
    }

    exportWAV(cb, mimeType) {
        mimeType = mimeType || this.config.mimeType;
        cb = cb || this.config.callback;
        if (!cb) throw new Error('Callback not set');

        this.callbacks.exportWAV.push(cb);

        this.worker.postMessage({
            command: 'exportWAV',
            type: mimeType
        });
    }

    onSilence(cb) {
        this.onSilenceCallback = cb;
    }

    onOutOfSilence(cb) {
        this.onOutOfSilenceCallback = cb;
    }

    static
    forceDownload(blob, filename) {
        let url = (window.URL || window.webkitURL).createObjectURL(blob);
        let link = window.document.createElement('a');
        link.href = url;
        link.download = filename || 'output.wav';
        let click = document.createEvent("Event");
        click.initEvent("click", true, true);
        link.dispatchEvent(click);
    }
}

export default Recorder;
