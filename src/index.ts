/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Terminal} from 'xterm';
import {FitAddon} from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import {
  serial as polyfill, SerialPort as SerialPortPolyfill,
} from 'web-serial-polyfill';

import { Buffer } from 'buffer';
import { AesCmac } from 'aes-cmac';

async function calcCmac(msg: Buffer) {
  const key = Buffer.from('7b0e19c6d9b74acc996d3561a9745a7f', 'hex');

  const aesCmac = new AesCmac(key);
  const result = Buffer.from(await aesCmac.calculate(msg));
  return result;
}

/**
 * Elements of the port selection dropdown extend HTMLOptionElement so that
 * they can reference the SerialPort they represent.
 */
declare class PortOption extends HTMLOptionElement {
  port: SerialPort | SerialPortPolyfill;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register(
          'service-worker.js', {scope: '.'});
      console.log('SW registered: ', registration);
    } catch (registrationError) {
      console.log('SW registration failed: ', registrationError);
    }
  });
}

let portSelector: HTMLSelectElement;
let connectButton: HTMLButtonElement;
let baudRateSelector: HTMLSelectElement;
let customBaudRateInput: HTMLInputElement;
let dataBitsSelector: HTMLSelectElement;
let paritySelector: HTMLSelectElement;
let stopBitsSelector: HTMLSelectElement;
let flowControlCheckbox: HTMLInputElement;
let echoCheckbox: HTMLInputElement;
let flushOnEnterCheckbox: HTMLInputElement;

let portCounter = 1;
let port: SerialPort | SerialPortPolyfill | undefined;
let reader: ReadableStreamDefaultReader | undefined;

let capture = true;
let captureData = "";

const urlParams = new URLSearchParams(window.location.search);
const usePolyfill = urlParams.has('polyfill');
const authStart = "AUTHSTART:";
const authStartLen = authStart.length;

const term = new Terminal({
  scrollback: 10_000,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
const encoder = new TextEncoder();
let toFlush = '';

function write(data: string) {
  if (echoCheckbox.checked) {
    term.write(data);
  }

  if (port?.writable == null) {
    console.warn(`unable to find writable port`);
    return;
  }

  const writer = port.writable.getWriter();

  if (flushOnEnterCheckbox.checked) {
    toFlush += data;
    if (data === '\r') {
      writer.write(encoder.encode(toFlush));
      writer.releaseLock();
      toFlush = '';
    }
  } else {
    writer.write(encoder.encode(data));
  }

  writer.releaseLock();
}

term.onData(write);

/**
 * Returns the option corresponding to the given SerialPort if one is present
 * in the selection dropdown.
 *
 * @param {SerialPort} port the port to find
 * @return {PortOption}
 */
function findPortOption(port: SerialPort | SerialPortPolyfill):
    PortOption | null {
  for (let i = 0; i < portSelector.options.length; ++i) {
    const option = portSelector.options[i];
    if (option.value === 'prompt') {
      continue;
    }
    const portOption = option as PortOption;
    if (portOption.port === port) {
      return portOption;
    }
  }

  return null;
}

/**
 * Adds the given port to the selection dropdown.
 *
 * @param {SerialPort} port the port to add
 * @return {PortOption}
 */
function addNewPort(port: SerialPort | SerialPortPolyfill): PortOption {
  const portOption = document.createElement('option') as PortOption;
  portOption.textContent = `Port ${portCounter++}`;
  portOption.port = port;
  portSelector.appendChild(portOption);
  return portOption;
}

/**
 * Adds the given port to the selection dropdown, or returns the existing
 * option if one already exists.
 *
 * @param {SerialPort} port the port to add
 * @return {PortOption}
 */
function maybeAddNewPort(port: SerialPort | SerialPortPolyfill): PortOption {
  const portOption = findPortOption(port);
  if (portOption) {
    return portOption;
  }

  return addNewPort(port);
}

/**
 * Download the terminal's contents to a file.
 */
function downloadTerminalContents(): void {
  if (!term) {
    throw new Error('no terminal instance found');
  }

  if (term.rows === 0) {
    console.log('No output yet');
    return;
  }

  term.selectAll();
  const contents = term.getSelection();
  term.clearSelection();
  const linkContent = URL.createObjectURL(
      new Blob([new TextEncoder().encode(contents).buffer],
          {type: 'text/plain'}));
  const fauxLink = document.createElement('a');
  fauxLink.download = `terminal_content_${new Date().getTime()}.txt`;
  fauxLink.href = linkContent;
  fauxLink.click();
}

/**
 * testPlay.
 */
function testPlay(): void {
  write("AT+AUDIOPLAYTESTTONE\r");
}

/**
 * testMic1.
 */
function testMic1(): void {
  write("AT+LOOPBACKSTART=2,48,48000\r");
}

/**
 * testMic2.
 */
function testMic2(): void {
  write("AT+LOOPBACKSTART=3,48,48000\r");
}

/**
 * testMicStop.
 */
function testMicStop(): void {
  write("AT+LOOPBACKSTOP\r");
}

/**
 * testStop.
 */
function testStop(): void {
  write("AT+DTSENDTESTING=0\r");
}

/**
 * Sets |port| to the currently selected port. If none is selected then the
 * user is prompted for one.
 */
async function getSelectedPort(): Promise<void> {
  if (portSelector.value == 'prompt') {
    try {
      const serial = usePolyfill ? polyfill : navigator.serial;
      port = await serial.requestPort({});
    } catch (e) {
      return;
    }
    const portOption = maybeAddNewPort(port);
    portOption.selected = true;
  } else {
    const selectedOption = portSelector.selectedOptions[0] as PortOption;
    port = selectedOption.port;
  }
}

/**
 * @return {number} the currently selected baud rate
 */
function getSelectedBaudRate(): number {
  if (baudRateSelector.value == 'custom') {
    return Number.parseInt(customBaudRateInput.value);
  }
  return Number.parseInt(baudRateSelector.value);
}

/**
 * Resets the UI back to the disconnected state.
 */
function markDisconnected(): void {
  term.writeln('<DISCONNECTED>');
  portSelector.disabled = false;
  connectButton.textContent = 'Connect';
  connectButton.disabled = false;
  baudRateSelector.disabled = false;
  customBaudRateInput.disabled = false;
  dataBitsSelector.disabled = false;
  paritySelector.disabled = false;
  stopBitsSelector.disabled = false;
  flowControlCheckbox.disabled = false;
  port = undefined;
  capture = true;
  captureData = "";
}

/**
 * Initiates a connection to the selected port.
 */
async function connectToPort(): Promise<void> {
  await getSelectedPort();
  if (!port) {
    return;
  }

  const options = {
    baudRate: getSelectedBaudRate(),
    dataBits: Number.parseInt(dataBitsSelector.value),
    parity: paritySelector.value as ParityType,
    stopBits: Number.parseInt(stopBitsSelector.value),
    flowControl:
        flowControlCheckbox.checked ? <const> 'hardware' : <const> 'none',

    // Prior to Chrome 86 these names were used.
    baudrate: getSelectedBaudRate(),
    databits: Number.parseInt(dataBitsSelector.value),
    stopbits: Number.parseInt(stopBitsSelector.value),
    rtscts: flowControlCheckbox.checked,
  };
  console.log(options);

  portSelector.disabled = true;
  connectButton.textContent = 'Connecting...';
  connectButton.disabled = true;
  baudRateSelector.disabled = true;
  customBaudRateInput.disabled = true;
  dataBitsSelector.disabled = true;
  paritySelector.disabled = true;
  stopBitsSelector.disabled = true;
  flowControlCheckbox.disabled = true;

  try {
    await port.open(options);
    term.writeln('<CONNECTED>');
    connectButton.textContent = 'Disconnect';
    connectButton.disabled = false;
  } catch (e) {
    console.error(e);
    term.writeln(`<ERROR: ${e.message}>`);
    markDisconnected();
    return;
  }

  write("AT+AUTHSTART\r");
  while (port && port.readable) {
    try {
      reader = port.readable.getReader();
      for (;;) {
        const {value, done} = await reader.read();
        if (value) {
          await new Promise<void>((resolve) => {
            term.write(value, resolve);
          });
          if (capture) {
            captureData += new TextDecoder().decode(value);;
            const pos = captureData.indexOf("OK");
            if (pos !== -1) {
               console.log(captureData);
               const pos2 = captureData.indexOf(authStart);
               if (pos2 !== -1) {
                 const pos3 = captureData.indexOf("\r\n", pos2);
                 if (pos3 !== -1) {
                   const challenge = captureData.slice(pos2 + authStartLen, pos3);
                   console.log(challenge);
                   const msg = Buffer.from(challenge, 'hex');
                   const response = await calcCmac(msg);
                   console.log(response.toString('hex'));
                   write("AT+AUTHRESP=" + response.toString('hex') + "\r");
                 }
               }
               capture = false;
            }
          }
        }
        if (done) {
          break;
        }
      }
      reader.releaseLock();
      reader = undefined;
    } catch (e) {
      console.error(e);
      term.writeln(`<ERROR: ${e.message}>`);
    }
  }

  if (port) {
    try {
      await port.close();
    } catch (e) {
      console.error(e);
      term.writeln(`<ERROR: ${e.message}>`);
    }

    markDisconnected();
  }
}

/**
 * Closes the currently active connection.
 */
async function disconnectFromPort(): Promise<void> {
  // Move |port| into a local variable so that connectToPort() doesn't try to
  // close it on exit.
  const localPort = port;
  port = undefined;

  if (reader) {
    await reader.cancel();
  }

  if (localPort) {
    try {
      await localPort.close();
    } catch (e) {
      console.error(e);
      term.writeln(`<ERROR: ${e.message}>`);
    }
  }

  markDisconnected();
}

document.addEventListener('DOMContentLoaded', async () => {
  const terminalElement = document.getElementById('terminal');
  if (terminalElement) {
    term.open(terminalElement);
    fitAddon.fit();
  }

  const download = document.getElementById('download') as HTMLButtonElement;
  download.addEventListener('click', downloadTerminalContents);
  const play = document.getElementById('play') as HTMLButtonElement;
  play.addEventListener('click', testPlay);
  const mic1 = document.getElementById('mic1') as HTMLButtonElement;
  mic1.addEventListener('click', testMic1);
  const mic2 = document.getElementById('mic2') as HTMLButtonElement;
  mic2.addEventListener('click', testMic2);
  const micstop = document.getElementById('micstop') as HTMLButtonElement;
  micstop.addEventListener('click', testMicStop);
  const leavetesting = document.getElementById('leavetesting') as HTMLButtonElement;
  leavetesting.addEventListener('click', testStop);



  portSelector = document.getElementById('ports') as HTMLSelectElement;

  connectButton = document.getElementById('connect') as HTMLButtonElement;
  connectButton.addEventListener('click', () => {
    if (port) {
      disconnectFromPort();
    } else {
      connectToPort();
    }
  });

  baudRateSelector = document.getElementById('baudrate') as HTMLSelectElement;
  baudRateSelector.addEventListener('input', () => {
    if (baudRateSelector.value == 'custom') {
      customBaudRateInput.hidden = false;
    } else {
      customBaudRateInput.hidden = true;
    }
  });

  customBaudRateInput =
      document.getElementById('custom_baudrate') as HTMLInputElement;
  dataBitsSelector = document.getElementById('databits') as HTMLSelectElement;
  paritySelector = document.getElementById('parity') as HTMLSelectElement;
  stopBitsSelector = document.getElementById('stopbits') as HTMLSelectElement;
  flowControlCheckbox = document.getElementById('rtscts') as HTMLInputElement;
  echoCheckbox = document.getElementById('echo') as HTMLInputElement;
  flushOnEnterCheckbox =
      document.getElementById('enter_flush') as HTMLInputElement;

  const convertEolCheckbox =
      document.getElementById('convert_eol') as HTMLInputElement;
  const convertEolCheckboxHandler = () => {
    term.setOption('convertEol', convertEolCheckbox.checked);
  };
  convertEolCheckbox.addEventListener('change', convertEolCheckboxHandler);
  convertEolCheckboxHandler();

  const serial = usePolyfill ? polyfill : navigator.serial;
  const ports: (SerialPort | SerialPortPolyfill)[] = await serial.getPorts();
  ports.forEach((port) => addNewPort(port));

  // These events are not supported by the polyfill.
  // https://github.com/google/web-serial-polyfill/issues/20
  if (!usePolyfill) {
    navigator.serial.addEventListener('connect', (event) => {
      addNewPort(event.target as SerialPort);
    });
    navigator.serial.addEventListener('disconnect', (event) => {
      const portOption = findPortOption(event.target as SerialPort);
      if (portOption) {
        portOption.remove();
      }
    });
  }
});
