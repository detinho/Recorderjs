'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.Recorder = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _inlineWorker = require('inline-worker');

var _inlineWorker2 = _interopRequireDefault(_inlineWorker);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Recorder = exports.Recorder = function () {
    function Recorder(source, cfg) {
        var _this = this;

        _classCallCheck(this, Recorder);

        this.config = {
            bufferLen: 4096,
            numChannels: 2,
            mimeType: 'audio/wav',
            downsampleTo: null,
            silenceTime: 1500
        };
        this.recording = false;
        this.recordingAll = false;
        this.callbacks = {
            getBuffer: [],
            exportWAV: []
        };
        this.onSilenceCallback = null;
        this.onOutOfSilenceCallback = null;

        Object.assign(this.config, cfg);
        this.context = source.context;
        this.node = (this.context.createScriptProcessor || this.context.createJavaScriptNode).call(this.context, this.config.bufferLen, this.config.numChannels, this.config.numChannels);

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

        this.node.onaudioprocess = function (e) {
            if (!_this.recordingAll) return;

            var bufferLength = _this.analyser.fftSize;
            var dataArray = new Uint8Array(bufferLength);
            _this.analyser.getByteTimeDomainData(dataArray);

            var curr_value_time = dataArray[0] / 128 - 1.0;

            if (curr_value_time > 0.07 || curr_value_time < -0.07) {
                if (_this.isInSilence && _this.onOutOfSilenceCallback) {
                    _this.onOutOfSilenceCallback();
                }
                _this.isInSilence = false;
                _this.start = Date.now();
            }

            var newtime = Date.now();
            var elapsedTime = newtime - _this.start;
            if (elapsedTime > _this.config.silenceTime) {
                if (!_this.isInSilence && _this.onSilenceCallback) {
                    _this.onSilenceCallback();
                }
                _this.isInSilence = true;

                _this.lastBufferOnSilence['beforeLast'] = _this.lastBufferOnSilence['last'];
                _this.lastBufferOnSilence['last'] = [];
                for (var channel = 0; channel < _this.config.numChannels; channel++) {
                    _this.lastBufferOnSilence['last'].push(e.inputBuffer.getChannelData(channel));
                }
            }

            if (!_this.recording) return;

            var buffer = [];
            for (var channel = 0; channel < _this.config.numChannels; channel++) {
                buffer.push(e.inputBuffer.getChannelData(channel));
            }

            if (_this.lastBufferOnSilence['beforeLast'].length) {
                _this.worker.postMessage({
                    command: 'record',
                    buffer: _this.lastBufferOnSilence['beforeLast']
                });
            }

            if (_this.lastBufferOnSilence['last'].length) {
                _this.worker.postMessage({
                    command: 'record',
                    buffer: _this.lastBufferOnSilence['last']
                });
            }

            _this.lastBufferOnSilence = {
                'last': [],
                'beforeLast': []
            };

            _this.worker.postMessage({
                command: 'record',
                buffer: buffer
            });
        };

        source.connect(this.node);
        this.node.connect(this.context.destination); //this should not be necessary

        var self = {};
        this.worker = new _inlineWorker2.default(function () {
            var recLength = 0,
                recBuffers = [],
                sampleRate = void 0,
                numChannels = void 0,
                downsampleTo = void 0,
                silenceTime = void 0;

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
                silenceTime = config.silenceTime;
                initBuffers();
            }

            function record(inputBuffer) {
                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel].push(inputBuffer[channel]);
                }
                recLength += inputBuffer[0].length;
            }

            function exportWAV(type) {
                var buffers = [];
                for (var channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                var interleaved = void 0;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                var dataview = encodeWAV(interleaved);
                var audioBlob = new Blob([dataview], { type: type });

                this.postMessage({ command: 'exportWAV', data: audioBlob });
            }

            function getBuffer() {
                var buffers = [];
                for (var channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                this.postMessage({ command: 'getBuffer', data: buffers });
            }

            function clear() {
                recLength = 0;
                recBuffers = [];
                this.isInSilence = true;
                this.start = Date.now();
                initBuffers();
            }

            function initBuffers() {
                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel] = [];
                }
                this.lastBufferOnSilence = {
                    'last': [],
                    'beforeLast': []
                };
            }

            function mergeBuffers(recBuffers, recLength) {
                var result = new Float32Array(recLength);
                var offset = 0;
                for (var i = 0; i < recBuffers.length; i++) {
                    result.set(recBuffers[i], offset);
                    offset += recBuffers[i].length;
                }
                return result;
            }

            function interleave(inputL, inputR) {
                var length = inputL.length + inputR.length;
                var result = new Float32Array(length);

                var index = 0,
                    inputIndex = 0;

                while (index < length) {
                    result[index++] = inputL[inputIndex];
                    result[index++] = inputR[inputIndex];
                    inputIndex++;
                }
                return result;
            }

            function floatTo16BitPCM(output, offset, input) {
                for (var i = 0; i < input.length; i++, offset += 2) {
                    var s = Math.max(-1, Math.min(1, input[i]));
                    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
            }

            function writeString(view, offset, string) {
                for (var i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            function encodeWAV(samples) {
                var oldSampleRate = sampleRate;

                if (downsampleTo) {
                    samples = downsampleBuffer(samples, downsampleTo);
                    sampleRate = downsampleTo;
                }
                var buffer = new ArrayBuffer(44 + samples.length * 2);
                var view = new DataView(buffer);

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
                downsampleTo: this.config.downsampleTo,
                silenceTime: this.config.silenceTime
            }
        });

        this.worker.onmessage = function (e) {
            var cb = _this.callbacks[e.data.command].pop();
            if (typeof cb == 'function') {
                cb(e.data.data);
            }
        };
    }

    _createClass(Recorder, [{
        key: 'record',
        value: function record() {
            this.recording = true;
            this.recordingAll = true;

            if (!this.onOutOfSilenceCallback) {
                this.isInSilence = false;
                this.start = Date.now();
            }
        }
    }, {
        key: 'stop',
        value: function stop() {
            this.recording = false;
        }
    }, {
        key: 'pause',
        value: function pause() {
            this.recordingAll = false;
        }
    }, {
        key: 'resume',
        value: function resume() {
            this.recordingAll = true;
            if (!this.onOutOfSilenceCallback) {
                this.isInSilence = false;
                this.start = Date.now();
            }
        }
    }, {
        key: 'clear',
        value: function clear() {
            this.worker.postMessage({ command: 'clear' });
        }
    }, {
        key: 'getBuffer',
        value: function getBuffer(cb) {
            cb = cb || this.config.callback;
            if (!cb) throw new Error('Callback not set');

            this.callbacks.getBuffer.push(cb);

            this.worker.postMessage({ command: 'getBuffer' });
        }
    }, {
        key: 'exportWAV',
        value: function exportWAV(cb, mimeType) {
            mimeType = mimeType || this.config.mimeType;
            cb = cb || this.config.callback;
            if (!cb) throw new Error('Callback not set');

            this.callbacks.exportWAV.push(cb);

            this.worker.postMessage({
                command: 'exportWAV',
                type: mimeType
            });
        }
    }, {
        key: 'onSilence',
        value: function onSilence(cb) {
            this.onSilenceCallback = cb;
        }
    }, {
        key: 'onOutOfSilence',
        value: function onOutOfSilence(cb) {
            this.onOutOfSilenceCallback = cb;
        }
    }], [{
        key: 'forceDownload',
        value: function forceDownload(blob, filename) {
            var url = (window.URL || window.webkitURL).createObjectURL(blob);
            var link = window.document.createElement('a');
            link.href = url;
            link.download = filename || 'output.wav';
            var click = document.createEvent("Event");
            click.initEvent("click", true, true);
            link.dispatchEvent(click);
        }
    }]);

    return Recorder;
}();

exports.default = Recorder;