/*
The MIT License (MIT)

Copyright (c) 2015 Kevin Phillips (kmp1)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
var tzx_js = (function () {

    "use strict";

    ////////// General Byte Manipulation Functions

    function getWord(input, i) {
        return (input.getByte(i + 1) << 8) | input.getByte(i);
    }

    ////////// Audio Wave Generation Functions

    var phase = 0, db = 115;

    function convertTStatesToSamples(tStates, output, machineSettings) {
        var samples = 0.5 + ((output.frequency / machineSettings.clockSpeed)) * tStates;
        return samples;
    }

    function addSampleToOutput(data, output) {
        var sample = data + 0x80;
        output.addSample(sample);
    }

    function addAnalogWaveToOutput(pulse1, pulse2, output) {
        var amp, x, t = 0, t1;

        amp = (db * 20) / (8 * pulse1 * pulse1 * pulse1);

        for (x = phase; x < pulse1; x += 1) {
            addSampleToOutput(Math.floor(0.5 - amp * (x * (x - pulse1) * (x - 2 * pulse1))), output);
            t += 1;
        }

        phase = t + phase - pulse1;
        t1 = t;

        amp = (db * 20) / (8 * pulse2 * pulse2 * pulse2);

        for (x = phase; x < pulse2; x += 1) {
            addSampleToOutput(Math.floor(0.5 - amp * (x * (x + pulse2) * (x - pulse2))), output);
            t += 1;
        }

        phase = t - t1 + phase - pulse2;
    }

    function addSingleAnalogPulseToOutput(pulse, output) {
        var t = 0, amp, x;
        amp = (db * 20) / (8 * pulse * pulse * pulse);

        for (x = phase; x < pulse; x += 1) {
            addSampleToOutput(Math.floor(0.5 - amp * (x * (x - pulse) * (x - 2 * pulse))), output);
            t += 1;
        }

        phase = t + phase - pulse;

        db = -db;
    }

    function addPilotToneToOutput(pilotPulse, length, output) {
        var i, t = 0;
        if (length & 1) {
            addSingleAnalogPulseToOutput(pilotPulse, output);
            t = 1;
        }

        for (i = t; i < length; i += 2) {
            addAnalogWaveToOutput(pilotPulse, pilotPulse, output);
        }
    }

    function addDataBlockToOutput(zeroPulse, onePulse, input, offset, length, lastByteBitCount, output) {

        var i, j, b, dataByte;

        for (i = offset; i < offset + length - 1; i += 1) {
            dataByte = input.getByte(i);
            b = 0x80;
            while (b) {
                if (b & dataByte) {
                    addAnalogWaveToOutput(onePulse, onePulse, output);
                } else {
                    addAnalogWaveToOutput(zeroPulse, zeroPulse, output);
                }
                b >>= 1;
            }
        }

        b = 0x80;
        dataByte = input.getByte(i);
        for (j = 0; j < lastByteBitCount; j += 1) {
            if (b & dataByte) {
                addAnalogWaveToOutput(onePulse, onePulse, output);
            } else {
                addAnalogWaveToOutput(zeroPulse, zeroPulse, output);
            }
            b >>= 1;
        }
    }

    function addPauseToOutput(pausePulse, duration, output) {
        var i, m;
        if (duration !== 0) {
            if (db < 0) {
                addSingleAnalogPulseToOutput(pausePulse, output);
            }

            addAnalogWaveToOutput(pausePulse, pausePulse, output);
            m = db;
            pausePulse = 250;
            for (i = 1; i < output.frequency * duration / (pausePulse * 2000.0); i += 1) {

                db = 200 * db / (200.0 + i);

                if (db < 1) {
                    db = 1;
                }
                addAnalogWaveToOutput(pausePulse, pausePulse, output);
            }
            db = m;
        }
    }

    function addEndOfFileToneToOutput(output) {
        var t;
        for (t = 0; t < 1000; t += 1) {
            addAnalogWaveToOutput(12, 12, output);
        }
    }

    ////////// TZX Data Reading Functions

    function calculateChecksum(input, offset, length) {
        var x, dataCheckSum = 0;
        for (x = offset; x < offset + length; x += 1) {
            dataCheckSum ^= input.getByte(x);
        }
        return dataCheckSum;
    }

    function readHeader(input, version) {
        var j, sig = "", eof;

        for (j = 0; j < 7; j += 1) {

            if (j >= input.length) {
                throw "Input is not a valid TZX file";
            }

            sig += String.fromCharCode(input.getByte(j));
        }

        if (sig !== "ZXTape!") {
            throw "Input is not a valid TZX file as the signature is wrong, got: '" + sig + "'";
        }

        eof = input.getByte(j);
        j += 1;

        if (eof !== 26) {
            throw "Input is not a valid TZX file as the EOF byte is wrong, got 0x" + eof.toString(16);
        }

        version.major = input.getByte(j);
        j += 1;
        version.minor = input.getByte(j);
        return j;
    }

    function readTextDescription(fileReader, i, blockDetails) {
        var length, x, description = "";
        length = fileReader.getByte(i + 1);
        for (x = 0; x < length; x += 1) {
            description += String.fromCharCode(fileReader.getByte(i + 2 + x));
        }

        blockDetails.tapeDescription = description;
        return i + length + 1;
    }

    function readStandardSpeedDataBlock(input, i, output, machineSettings, blockDetails) {

        var pilotLength, dataStart = i + 4;

        blockDetails.pause = getWord(input, i + 1);
        blockDetails.blockLength = getWord(input, i + 3);
        blockDetails.flag = input.getByte(i + 5);
        blockDetails.programType = input.getByte(i + 6);
        blockDetails.checkSum = input.getByte(dataStart + blockDetails.blockLength);

        blockDetails.validCheckSum = calculateChecksum(input, dataStart + 1,
            blockDetails.blockLength - 1) === blockDetails.checkSum;

        blockDetails.headerText = machineSettings.readDataBlockHeaderInformation(input, blockDetails.flag,
            blockDetails.programType, blockDetails.blockLength, dataStart + 2);

        if (blockDetails.flag === 0) {
            pilotLength = machineSettings.headerPilotLength;
        } else if (blockDetails.flag === 0xff) {
            pilotLength = machineSettings.dataPilotLength;
        } else {
            throw "Invalid TZX flag byte value: " + blockDetails.flag;
        }

        addPilotToneToOutput(convertTStatesToSamples(machineSettings.pilotPulse, output, machineSettings), pilotLength, output);

        addAnalogWaveToOutput(convertTStatesToSamples(machineSettings.sync1Pulse, output, machineSettings),
            convertTStatesToSamples(machineSettings.sync2Pulse, output, machineSettings), output);

        addDataBlockToOutput(convertTStatesToSamples(machineSettings.bit0Pulse, output, machineSettings),
            convertTStatesToSamples(machineSettings.bit1Pulse, output, machineSettings),
            input, dataStart + 1, blockDetails.blockLength, 8, output);

        addPauseToOutput(convertTStatesToSamples(machineSettings.bit1Pulse, output, machineSettings), blockDetails.pause, output);

        return dataStart + blockDetails.blockLength;
    }

    function convertTzxToWave(machineSettings, input, output) {

        var i = 0, version = { major: -1, minor: -1}, blockDetails, retBlockDetails = [];

        while (i < input.length) {
            if (i === 0) {
                i = readHeader(input, version);
            } else {

                blockDetails = {
                    blockType: input.getByte(i),
                    offset: i
                };

                switch (blockDetails.blockType) {
                case 0x10:
                    i = readStandardSpeedDataBlock(input, i, output, machineSettings, blockDetails);
                    break;
                case 0x30:
                    i = readTextDescription(input, i, blockDetails);
                    break;
                // TODO: Implement more block support here
                default:
                    throw "Unsupported block: 0x" + blockDetails.blockType.toString(16);
                }

                retBlockDetails.push(blockDetails);
            }
            i += 1;
        }

        addPauseToOutput(convertTStatesToSamples(machineSettings.bit1Pulse, output, machineSettings),
            1000, output);

        addEndOfFileToneToOutput(output);

        return {
            version: version,
            blocks: retBlockDetails
        };
    }

    function readTapData(input, i, machineSettings, output, blockDetails) {
        var pilotLength, dataStart = i + 2;

        blockDetails.blockLength = getWord(input, i);
        blockDetails.flag = input.getByte(i + 2);
        blockDetails.pause = 1000;

        if (blockDetails.flag === 0) {
            pilotLength = machineSettings.headerPilotLength;
        } else if (blockDetails.flag === 0xff) {
            pilotLength = machineSettings.dataPilotLength;
        } else {
            throw "Invalid TAP flag byte value: " + blockDetails.flag;
        }

        addPilotToneToOutput(convertTStatesToSamples(machineSettings.pilotPulse, output, machineSettings), pilotLength, output);

        addAnalogWaveToOutput(convertTStatesToSamples(machineSettings.sync1Pulse, output, machineSettings),
            convertTStatesToSamples(machineSettings.sync2Pulse, output, machineSettings), output);

        addDataBlockToOutput(convertTStatesToSamples(machineSettings.bit0Pulse, output, machineSettings),
            convertTStatesToSamples(machineSettings.bit1Pulse, output, machineSettings),
            input, dataStart, blockDetails.blockLength, 8, output);

        addPauseToOutput(convertTStatesToSamples(machineSettings.bit1Pulse, output, machineSettings), blockDetails.pause, output);

        return dataStart + blockDetails.blockLength;
    }

    function convertTapToWave(machineSettings, input, output) {
        var i = 0, blockDetails, retBlockDetails = [];

        while (i < input.length) {
            blockDetails = {
                offset: i
            };

            i = readTapData(input, i, machineSettings, output, blockDetails);

            retBlockDetails.push(blockDetails);
        }

        addEndOfFileToneToOutput(output);

        return {
            blocks: retBlockDetails
        };
    }

    return {

        /**
         * Converts a TZX to a wave file and returns some details about
         * what it has read.
         *
         * @param {Number} machineSettings The machine specific settings to use
         * @param {Object} input The input file to read from (this must be an object
         * that provides a length property and a getByte(x) function.)
         * @param {Object} output The output to write to (this must be a wav.js
         * created wave file or at least something that implements the same interface
         * - it would be fantastic to implement the interface but generate an MP3 for
         * example).
         * @return {Object} details about the TZX file that was converted
         */
        convertTzxToWave: convertTzxToWave,

        /**
         * Converts a TZX to a wave file and returns some details about
         * what it has read.
         *
         * @param {Number} machineSettings The machine specific settings to use
         * @param {Object} input The input file to read from (this must be an object
         * that provides a length property and a getByte(x) function.)
         * @param {Object} output The output to write to (this must be a wav.js
         * created wave file or at least something that implements the same interface
         * - it would be fantastic to implement the interface but generate an MP3 for
         * example).
         * @return {Object} details about the TAP file that was converted
         */
        convertTapToWave: convertTapToWave,

        MachineSettings: {
            ZXSpectrum48: {
                lowAmplitude: 0x10,
                highAmplitude: 0xF0,
                clockSpeed: 3500000,
                pilotPulse: 2168,
                sync1Pulse: 667,
                sync2Pulse: 735,
                bit0Pulse: 855,
                bit1Pulse: 1710,
                headerPilotLength: 8064,
                dataPilotLength: 3220,
                readDataBlockHeaderInformation: function (fileReader, flag, programType, length, startOffset) {
                    var headerText = "", x;

                    if (flag === 0 && (length === 19 || length === 20) && programType < 4) {
                        for (x = startOffset; x < startOffset + 10; x += 1) {
                            headerText += String.fromCharCode(fileReader.getByte(x));
                        }

                        headerText = headerText.trim();
                    } else {
                        headerText = "No header";
                    }

                    return headerText;
                }
            }
            // TODO: Add some more machines here - e.g. SAM, CPC etc (there are a few supported by TZX files)
        }
    };
}());

if (typeof exports !== "undefined") {
    exports.convertTzxToWave = tzx_js.convertTzxToWave;
    exports.convertTapToWave = tzx_js.convertTapToWave;
    exports.MachineSettings = tzx_js.MachineSettings;
}