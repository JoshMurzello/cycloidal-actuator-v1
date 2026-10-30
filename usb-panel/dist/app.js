const PROTOCOL = 3;
const MAX_TRAVEL_PULSES = 20000;
const MAX_JOG_RATE = 2000;
const MAX_LOAD_RATE = 50;
const FIRMWARE = 'usb-panel-3';
const MODES = new Set(['RELEASED', 'HOLD', 'JOG', 'LOAD']);
const MAX_ID = 2147483647;
const LEASE_INTERVAL = 150;
const TELEMETRY_TIMEOUT = 1000;

export function degreesPerPulse(microsteps) {
  const value = Number(microsteps);
  return [1, 2, 4, 8, 16, 32].includes(value) ? 360 / (200 * value * 15) : null;
}

export function contactMoment(grams, baseline, armMm) {
  return (grams - baseline) * 0.00980665 * armMm / 1000;
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function validStatus(value) {
  return value?.type === 'status' && value.protocol === PROTOCOL && MODES.has(value.mode) &&
    ['position', 'origin', 'limit', 'rate', 'remaining', 'motion', 'last'].every(key => Number.isSafeInteger(value[key])) &&
    Math.abs(value.position) <= MAX_TRAVEL_PULSES && Math.abs(value.origin) <= MAX_TRAVEL_PULSES && value.limit >= 1 && value.limit <= MAX_TRAVEL_PULSES &&
    value.rate >= 0 && value.rate <= MAX_JOG_RATE && value.remaining >= 0 && value.remaining <= MAX_TRAVEL_PULSES &&
    value.motion >= 0 && value.motion <= MAX_ID && value.last >= 0 && value.last <= MAX_ID &&
    typeof value.reason === 'string' && value.reason.length <= 160;
}

/** The board owns timing. This transport only commands motion and renews its lease. */
export class SerialController {
  constructor({ serial = globalThis.navigator?.serial, onState = () => {}, onEvent = () => {}, now = () => Date.now() } = {}) {
    this.serial = serial;
    this.onState = onState;
    this.onEvent = onEvent;
    this.now = now;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connection = 'disconnected';
    this.ready = false;
    this.hello = false;
    this.status = null;
    this.lastTelemetry = 0;
    this.active = null;
    this.terminal = null;
    this.nextCommand = 1;
    this.queue = [];
    this.writing = false;
    this.session = 0;
    this.actionEpoch = 0;
    this.error = '';
    this.diagnostics = { bytes: 0, lines: 0, hello: 0, status: 0, lastLine: '', port: '' };
    this.serial?.addEventListener?.('disconnect', event => {
      if (event.target === this.port || event.port === this.port) this.fault('USB disconnected. Motion will stop when the board lease expires. Reconnect to continue.');
    });
  }

  publish() {
    this.onState({ connection: this.connection, ready: this.ready, hello: this.hello, status: this.status,
      active: this.active ? { ...this.active } : null, lastTelemetry: this.lastTelemetry, error: this.error, diagnostics: { ...this.diagnostics } });
  }

  id() {
    if (this.nextCommand > MAX_ID) throw new Error('Command IDs are exhausted. Reset the board and reconnect.');
    return this.nextCommand++;
  }

  async connect(existingPort) {
    if (!this.serial && !existingPort) throw new Error('Open this panel in desktop Chrome to use USB serial.');
    if (this.port || this.connection === 'connecting') return;
    this.error = '';
    this.connection = 'connecting';
    this.publish();
    const session = ++this.session;
    try {
      const port = existingPort || await this.serial.requestPort({ filters: [{ usbVendorId: 0x0483 }] });
      await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      if (session !== this.session) { await port.close(); return; }
      this.port = port;
      const info = port.getInfo?.() || {};
      this.diagnostics = { bytes: 0, lines: 0, hello: 0, status: 0, lastLine: '',
        port: info.usbVendorId === undefined ? 'Selected serial port' : `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}` };
      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.ready = false;
      this.hello = false;
      this.status = null;
      this.lastTelemetry = 0;
      this.nextCommand = 1;
      this.readTask = this.readLoop(this.reader, session);
      if (port.setSignals) {
        try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); }
        catch { this.onEvent('Serial control signals unavailable; continuing with handshake retries.'); }
      }
      if (session !== this.session) return;
      this.healthTimer = setInterval(() => this.healthCheck(), 200);
      this.handshakeRetryTimer = setInterval(() => this.handshakeAttempt(), 350);
      this.handshakeTimer = setTimeout(() => {
        if (!this.ready) this.fault(this.handshakeFailure());
      }, 5000);
      await this.handshakeAttempt();
      this.publish();
    } catch (error) {
      if (session !== this.session) return;
      await this.fault(error.name === 'NotFoundError' ? 'No USB port selected.' : `Could not connect: ${error.message}`);
    }
  }

  async readLoop(reader, session) {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      while (session === this.session) {
        const { value, done } = await reader.read();
        if (done) break;
        if (session !== this.session) break;
        this.diagnostics.bytes += value.byteLength;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop();
        if (buffered.length > 4096) throw new Error('Malformed serial data: line buffer exceeded.');
        for (const line of lines) this.receive(line.trim());
      }
      if (session === this.session) this.fault('Serial stream ended. Reconnect to continue.');
    } catch (error) {
      if (session === this.session) this.fault(`Serial read failed: ${error.message}`);
    }
  }

  handshakeAttempt() {
    if (!this.writer || this.ready || this.connection === 'closing') return Promise.resolve(false);
    // A leading newline clears a partial/discarded board line. Identification is
    // idempotent and retried because USB line setup can lose the first request.
    return this.enqueue('\nHELLO', 'hello');
  }

  handshakeFailure() {
    const { bytes, hello, status, port } = this.diagnostics;
    if (!bytes) return `${port || 'Serial port'} opened, but no board data arrived. Select the ST-LINK port, close other panel tabs/serial monitors, and check that the board is running.`;
    if (!hello && status) return `Board status is arriving (${status} frames), but firmware identification did not arrive. Reconnect; the panel will retry the handshake.`;
    if (hello && !status) return 'Firmware identification arrived, but valid live status did not. Reconnect and check the USB diagnostics.';
    return `Received ${bytes} serial bytes, but no matching USB-panel identification/status. Check the selected port and USB diagnostics before reflashing.`;
  }

  receive(line) {
    if (this.connection === 'closing' || (this.connection === 'disconnected' && !this.writer)) return;
    if (!line || line.length > 1024) return;
    this.diagnostics.lines++;
    this.diagnostics.lastLine = line.slice(0, 240);
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.type === 'hello') {
      if (value.protocol !== PROTOCOL || value.firmware !== FIRMWARE) {
        this.fault('This board firmware does not match the panel. Flash usb-panel-3 and reconnect.');
        return;
      }
      this.diagnostics.hello++;
      // A retried HELLO may have two responses already in transit. Neither
      // starts motion. Actual resets are detected by decreasing board IDs.
      if (this.hello && this.ready) { this.publish(); return; }
      this.hello = true;
      this.enqueue('STATUS', 'status');
    } else if (validStatus(value)) {
      this.diagnostics.status++;
      if (this.ready && this.status && value.last < this.status.last) {
        this.fault('The board restarted. Motion is stopped; reconnect and establish a new reference.');
        return;
      }
      // Status alone cannot unlock controls; old firmware must never receive motion.
      this.status = value;
      this.lastTelemetry = this.now();
      this.nextCommand = Math.max(this.nextCommand, value.last + 1);
      if (this.hello && !this.ready) {
        this.ready = true;
        this.connection = 'connected';
        clearTimeout(this.handshakeTimer);
        clearInterval(this.handshakeRetryTimer);
        this.onEvent('Connected. Motion controls are ready.');
      }
      if (this.active && value.last >= this.active.id) {
        if (value.motion !== this.active.id || !['JOG', 'LOAD'].includes(value.mode)) {
          this.cancelAction();
          this.onEvent(`Board stopped: ${humanReason(value.reason)}.`);
        } else this.active.accepted = true;
      }
      // An existing motion from another session is never adopted or resumed.
      const terminalPending = this.terminal && value.last < this.terminal.id;
      if (this.terminal && value.last >= this.terminal.id) this.terminal = null;
      if (!this.active && value.motion > 0 && !terminalPending) this.stop();
    } else if (value.type === 'error') {
      this.onEvent(`Board rejected command: ${String(value.reason || 'invalid command').slice(0, 160)}.`, true);
      if (this.active) this.stop();
      this.enqueue('STATUS', 'status');
    }
    this.publish();
  }

  healthCheck() {
    if (!this.writer) return;
    if (this.ready && this.now() - this.lastTelemetry > TELEMETRY_TIMEOUT) {
      this.fault('Live status is stale. Motion is stopped and controls are locked. Reconnect to continue.');
      return;
    }
    this.enqueue('STATUS', 'status');
  }

  enqueue(line, kind, priority = false) {
    if (!this.writer) return Promise.resolve(false);
    if (['keep', 'status', 'hello'].includes(kind) && this.queue.some(item => item.kind === kind)) return Promise.resolve(false);
    if (this.queue.length >= 24 && !priority) return Promise.resolve(false);
    return new Promise(resolve => {
      const item = { line, kind, resolve, session: this.session };
      if (priority) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    });
  }

  async pump() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && this.writer) {
        const item = this.queue.shift();
        if (item.session !== this.session) { item.resolve(false); continue; }
        const writer = this.writer;
        try {
          await writer.write(new TextEncoder().encode(`${item.line}\n`));
          item.resolve(true);
        } catch (error) {
          item.resolve(false);
          if (item.session === this.session) {
            this.fault(`Serial write failed: ${error.message}`);
            break;
          }
        }
      }
    } finally { this.writing = false; }
  }

  discardMotionWrites() {
    const retained = [];
    for (const item of this.queue) {
      if (['motion', 'keep'].includes(item.kind)) item.resolve(false); else retained.push(item);
    }
    this.queue = retained;
  }

  discardTerminalWrites() {
    const retained = [];
    for (const item of this.queue) {
      if (['stop', 'release'].includes(item.kind)) item.resolve(false); else retained.push(item);
    }
    this.queue = retained;
  }

  cancelAction() {
    this.actionEpoch++;
    clearInterval(this.keepTimer);
    this.keepTimer = null;
    this.active = null;
    this.discardMotionWrites();
  }

  assertReady() {
    if (!this.ready || !this.hello || this.now() - this.lastTelemetry > TELEMETRY_TIMEOUT) {
      throw new Error('Connect the matching firmware and wait for live status before moving.');
    }
  }

  async start(kind, direction, rate, pulses, milliseconds) {
    this.assertReady();
    if (this.active || ['JOG', 'LOAD'].includes(this.status?.mode)) throw new Error('Stop the current motion before starting another.');
    if (!['RUN', 'LOAD'].includes(kind)) throw new Error('Unknown motion type.');
    if (![1, -1].includes(direction)) throw new Error('Select a valid direction.');
    integer(rate, 1, kind === 'LOAD' ? MAX_LOAD_RATE : MAX_JOG_RATE, 'Rate');
    integer(pulses, 1, MAX_TRAVEL_PULSES, 'Run travel');
    integer(milliseconds, 100, 30000, 'Timeout in milliseconds');
    const id = this.id();
    const epoch = ++this.actionEpoch;
    this.terminal = null;
    this.active = { id, kind, direction, accepted: false };
    this.publish();
    const sent = await this.enqueue(`${kind} ${id} ${direction} ${rate} ${pulses} ${milliseconds}`, 'motion');
    // Release/STOP may happen while a serial write is pending. It must win.
    if (!sent || epoch !== this.actionEpoch || this.active?.id !== id || !this.ready) return false;
    this.keepTimer = setInterval(() => {
      if (epoch !== this.actionEpoch || this.active?.id !== id || !this.ready) return;
      if (this.now() - this.lastTelemetry > TELEMETRY_TIMEOUT) { this.fault('Live status is stale. Reconnect to continue.'); return; }
      this.enqueue(`KEEP ${id}`, 'keep');
    }, LEASE_INTERVAL);
    return true;
  }

  stop() {
    this.cancelAction();
    this.publish();
    if (!this.writer) return Promise.resolve(false);
    // STOP is unconditional on the board even if its ID is stale.
    const id = this.nextCommand <= MAX_ID ? this.id() : MAX_ID;
    this.discardTerminalWrites();
    this.terminal = { id, kind: 'stop' };
    return this.enqueue(`STOP ${id}`, 'stop', true);
  }

  release() {
    this.cancelAction();
    this.publish();
    if (!this.writer) return Promise.resolve(false);
    const id = this.nextCommand <= MAX_ID ? this.id() : MAX_ID;
    this.discardTerminalWrites();
    this.terminal = { id, kind: 'release' };
    return this.enqueue(`RELEASE ${id}`, 'release', true);
  }

  idleCommand(command, value) {
    this.assertReady();
    if (this.active || ['JOG', 'LOAD'].includes(this.status?.mode)) throw new Error('Stop and hold before changing the reference or travel limit.');
    if (command === 'LIMIT') {
      integer(value, 1, MAX_TRAVEL_PULSES, 'Travel limit');
      if (value < Math.abs(this.status.position)) throw new Error('The limit must include the current position measured from boot.');
    } else if (command !== 'ZERO') throw new Error('Unknown setup command.');
    const id = this.id();
    return { id, sent: this.enqueue(`${command} ${id}${value === undefined ? '' : ` ${value}`}`, 'setup') };
  }

  async fault(message) {
    if (this.connection === 'closing') return;
    this.error = message;
    this.onEvent(message, true);
    await this.disconnect(true);
  }

  async disconnect(preserveError = false) {
    if (this.connection === 'closing') return;
    this.connection = 'closing';
    this.ready = false;
    clearTimeout(this.handshakeTimer);
    clearInterval(this.handshakeRetryTimer);
    clearInterval(this.healthTimer);
    const stopped = this.stop();
    this.publish();
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 250))]);
    ++this.session;
    this.cancelAction();
    for (const item of this.queue) item.resolve(false);
    this.queue = [];
    const reader = this.reader, writer = this.writer, port = this.port;
    this.reader = null;
    this.writer = null;
    this.port = null;
    this.terminal = null;
    try { await reader?.cancel(); } catch { /* Already unplugged. */ }
    try { reader?.releaseLock(); } catch { /* Read is ending. */ }
    try { await writer?.abort(); } catch { /* Already unplugged. */ }
    try { writer?.releaseLock(); } catch { /* Write is ending. */ }
    try { await port?.close(); } catch { /* Already unplugged. */ }
    this.connection = 'disconnected';
    this.hello = false;
    if (!preserveError) this.error = '';
    this.publish();
  }
}

function humanReason(reason) {
  const names = { boot: 'ready after boot', command: 'Stop & Hold', release: 'motor released', lease: 'command lease expired',
    timeout: 'run time reached', budget: 'run travel reached', limit: 'boot travel limit reached', button: 'blue button pressed',
    stale: 'command rejected as stale', zero: 'reference set', lease_expired: 'command lease expired', time_limit: 'run time reached',
    pulse_limit: 'run travel reached', travel_limit: 'boot travel limit reached', button_stop: 'blue button pressed' };
  return names[reason.toLowerCase()] || reason.toLowerCase().replaceAll('_', ' ') || 'motion complete';
}

if (typeof document !== 'undefined') initPanel();

function initPanel() {
  const $ = id => document.getElementById(id);
  const settings = ['jog-rate', 'jog-pulses', 'jog-seconds', 'load-rate', 'load-pulses', 'load-seconds', 'limit', 'reference-label'];
  let state = { connection: 'disconnected', ready: false, status: null, active: null, lastTelemetry: 0, error: '' };
  let referenceDegrees = 0;
  let pendingReference = null;
  let hold = null;
  let lastNotice = '';
  const readings = [];
  function notice(message, error = false) {
    lastNotice = message;
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
  }
  const controller = new SerialController({ onState: next => {
    state = next;
    if (pendingReference && state.status?.last >= pendingReference.id) {
      if (state.status.origin === state.status.position && !['JOG', 'LOAD'].includes(state.status.mode)) {
        referenceDegrees = pendingReference.degrees;
        notice(`Reference set to ${referenceDegrees}°. Boot travel is preserved.`);
      } else notice('Reference was not set. Stop and hold, then try again.', true);
      pendingReference = null;
    }
    if (!state.active) hold = null;
    render();
  }, onEvent: notice });

  function guarded(action) {
    try { const result = action(); result?.catch?.(error => notice(error.message, true)); }
    catch (error) { notice(error.message, true); }
  }
  function field(id, min, max, whole = true) {
    const input = $(id);
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
      input.focus();
      throw new Error(`${input.closest('label')?.childNodes[0]?.textContent?.trim() || 'Value'} must be ${whole ? 'a whole number ' : ''}from ${min} to ${max}.`);
    }
    return value;
  }
  function motionSettings(prefix) {
    return [field(`${prefix}-rate`, 1, prefix === 'load' ? MAX_LOAD_RATE : MAX_JOG_RATE), field(`${prefix}-pulses`, 1, MAX_TRAVEL_PULSES), Math.round(field(`${prefix}-seconds`, .1, 30, false) * 1000)];
  }
  function startJog(direction, source, sourceId) {
    if (hold || state.active) return;
    guarded(() => {
      const values = motionSettings('jog');
      // Retain identity before start publishes the pending action.
      hold = { source, sourceId, direction };
      const started = controller.start('RUN', direction, ...values);
      started.catch(() => { hold = null; render(); });
      notice(`Jogging ${direction > 0 ? 'forward' : 'reverse'}. Let go to stop and hold.`);
      return started;
    });
  }
  function stop(message = 'Stop & Hold requested.') {
    hold = null;
    guarded(() => controller.stop());
    notice(message);
  }
  function render() {
    const { ready, connection, status, active } = state;
    const busy = Boolean(active) || (ready && ['JOG', 'LOAD'].includes(status?.mode));
    $('connect').disabled = connection !== 'disconnected' || !navigator.serial;
    $('disconnect').disabled = connection === 'disconnected' || connection === 'closing';
    $('stop').disabled = !controller.writer;
    $('release').disabled = !controller.writer;
    $('jog-forward').disabled = !ready || (busy && !(active?.kind === 'RUN' && active.direction === 1));
    $('jog-back').disabled = !ready || (busy && !(active?.kind === 'RUN' && active.direction === -1));
    $('load').disabled = !ready || busy;
    $('zero').disabled = !ready || busy;
    $('apply-limit').disabled = !ready || busy;
    settings.forEach(id => $(id).disabled = busy);
    document.querySelectorAll('[name="load-direction"]').forEach(input => input.disabled = busy);
    $('jog-forward').classList.toggle('active', active?.kind === 'RUN' && active.direction === 1);
    $('jog-back').classList.toggle('active', active?.kind === 'RUN' && active.direction === -1);
    $('load').textContent = active?.kind === 'LOAD' ? 'Loading… use Stop & Hold' : 'Start slow loading ↗';
    $('connection-dot').className = `dot ${ready ? 'connected' : state.error ? 'error' : ''}`;
    $('connection-title').textContent = ready ? 'STM32 connected' : connection === 'connecting' ? 'Verifying firmware…' : connection === 'closing' ? 'Stopping & disconnecting…' : 'Connect your STM32';
    $('connection-detail').textContent = ready ? '115200 baud · protocol 3 verified · live USB status' : connection === 'connecting' ? `${state.diagnostics?.port || 'Serial port'} · received ${state.diagnostics?.bytes || 0} bytes · verifying…` : 'USB cable → desktop Chrome → select the ST-LINK serial port';
    if ($('usb-diagnostics')) $('usb-diagnostics').textContent = state.diagnostics ? `${state.diagnostics.port || 'No port opened'}\nReceived: ${state.diagnostics.bytes} bytes / ${state.diagnostics.lines} lines\nIdentification: ${state.diagnostics.hello} · valid status: ${state.diagnostics.status}\nLatest line: ${state.diagnostics.lastLine || '(none)'}` : 'No serial data yet.';
    $('mode').textContent = ready ? status.mode : 'OFFLINE';
    const perPulse = degreesPerPulse($('microsteps').value);
    const relative = status ? status.position - status.origin : null;
    $('position').textContent = relative === null ? '—' : perPulse ? (referenceDegrees + relative * perPulse).toFixed(2) : String(relative);
    $('position-unit').textContent = perPulse ? '°' : 'pulses';
    $('position-detail').textContent = perPulse ? `Estimated output angle · reference ${referenceDegrees}°` : 'Pulse count relative to the reference you set';
    $('boot-position').textContent = status ? `${status.position} pulses` : '— pulses';
    $('live-rate').textContent = status ? `${status.rate} pulses/s` : '— pulses/s';
    $('live-limit').textContent = status ? `±${status.limit} pulses` : '— pulses';
    $('live-remaining').textContent = status ? `${status.remaining} pulses` : '— pulses';
    $('dial-arm').style.transform = `rotate(${relative !== null && perPulse ? referenceDegrees + relative * perPulse : 0}deg)`;
    $('dial-arm').style.opacity = relative !== null && perPulse ? '1' : '.3';
    estimates();
    $('export').disabled = !readings.length;
  }
  function estimates() {
    const perPulse = degreesPerPulse($('microsteps').value);
    const jogRate = Number($('jog-rate').value), jogPulses = Number($('jog-pulses').value), limit = Number($('limit').value);
    $('jog-estimate').textContent = perPulse ? `Estimated output: ${(jogRate * perPulse).toFixed(3)}°/s · up to ${(jogPulses * perPulse).toFixed(2)}° per run, subject to time and travel limits.` : 'Select the driver’s microstep setting to show estimated angles.';
    $('limit-estimate').textContent = perPulse ? `±${(limit * perPulse).toFixed(2)}° estimated from boot. Setting a new display reference does not reset this limit.` : 'The board enforces this limit in both directions from its boot position.';
  }
  $('connect').addEventListener('click', () => { referenceDegrees = 0; pendingReference = null; guarded(() => controller.connect()); });
  $('disconnect').addEventListener('click', () => guarded(() => controller.disconnect()));
  $('stop').addEventListener('click', () => stop());
  $('release').addEventListener('click', () => { hold = null; guarded(() => controller.release()); notice('Release requested. The motor is disabled; support the arm if needed.'); });
  for (const [id, direction] of [['jog-back', -1], ['jog-forward', 1]]) {
    const button = $(id);
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || button.disabled || state.active) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      startJog(direction, 'pointer', event.pointerId);
    });
    const end = event => { if (hold?.source === 'pointer' && hold.sourceId === event.pointerId) stop('Jog stopped; holding position.'); };
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('lostpointercapture', end);
    button.addEventListener('click', event => event.preventDefault());
  }
  $('load').addEventListener('click', () => guarded(() => {
    const direction = Number(document.querySelector('[name="load-direction"]:checked').value);
    const result = controller.start('LOAD', direction, ...motionSettings('load'));
    notice('Slow loading started. Watch the scale; use Stop & Hold at your target reading.');
    return result;
  }));
  $('zero').addEventListener('click', () => guarded(() => {
    const result = controller.idleCommand('ZERO');
    pendingReference = { id: result.id, degrees: Number($('reference-label').value) };
    notice('Setting reference…');
    return result.sent;
  }));
  $('apply-limit').addEventListener('click', () => guarded(() => {
    const limit = field('limit', 1, MAX_TRAVEL_PULSES);
    const result = controller.idleCommand('LIMIT', limit);
    notice(`Travel limit requested: ±${limit} pulses from boot. Check live travel limit above.`);
    return result.sent;
  }));
  $('microsteps').addEventListener('change', render);
  ['jog-rate', 'jog-pulses', 'limit'].forEach(id => $(id).addEventListener('input', estimates));
  const editable = event => event.target?.closest?.('input, select, textarea, [contenteditable="true"]');
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' || (event.code === 'Space' && !editable(event))) {
      event.preventDefault();
      if (controller.writer && !event.repeat) stop();
      return;
    }
    if (editable(event) || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (state.ready && !event.repeat) startJog(event.key === 'ArrowRight' ? 1 : -1, 'keyboard', event.key);
  });
  window.addEventListener('keyup', event => { if (hold?.source === 'keyboard' && hold.sourceId === event.key) { event.preventDefault(); stop('Jog stopped; holding position.'); } });
  window.addEventListener('blur', () => { if (state.active) stop('Window lost focus. Motion stopped; holding position.'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) stop('Panel hidden. Motion stopped; holding position.'); });
  window.addEventListener('pagehide', () => { controller.stop(); });
  window.addEventListener('beforeunload', () => { controller.stop(); });
  setInterval(() => {
    const age = state.lastTelemetry ? Date.now() - state.lastTelemetry : null;
    $('telemetry-age').textContent = state.ready && age !== null ? `STATUS ${age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`} AGO` : 'No live telemetry';
  }, 200);
  $('theme').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    $('theme').setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
  });

  function readingValues(validate = false) {
    const grams = Number($('grams').value), baseline = Number($('baseline').value || 0), arm = Number($('arm').value);
    const valid = $('grams').value.trim() !== '' && $('arm').value.trim() !== '' && Number.isFinite(grams) && grams >= 0 && Number.isFinite(baseline) && baseline >= 0 && Number.isFinite(arm) && arm > 0;
    if (!valid && validate) throw new Error('Enter a nonnegative scale reading and baseline, and a measured moment arm greater than zero.');
    return valid ? { grams, baseline, arm, net: grams - baseline, torque: contactMoment(grams, baseline, arm) } : null;
  }
  function previewTorque() {
    const values = readingValues();
    $('torque').replaceChildren();
    $('torque').append(document.createTextNode(values ? `${values.torque.toFixed(3)} ` : '— '));
    const unit = document.createElement('small'); unit.textContent = 'N·m'; $('torque').append(unit);
    $('torque-detail').textContent = values ? `${values.net.toFixed(1)} g after baseline · ${values.arm} mm moment arm` : 'Enter the reading and measured moment arm.';
  }
  ['grams', 'baseline', 'arm'].forEach(id => $(id).addEventListener('input', previewTorque));
  $('record').addEventListener('click', () => guarded(() => {
    if (state.active || (state.ready && ['JOG', 'LOAD'].includes(state.status?.mode))) throw new Error('Stop and hold before recording a settled reading.');
    const values = readingValues(true);
    const perPulse = degreesPerPulse($('microsteps').value);
    const relative = state.status ? state.status.position - state.status.origin : null;
    readings.push({ trial: readings.length + 1, timestamp: new Date().toISOString(), ...values,
      position: relative, bootPosition: state.status?.position ?? null, origin: state.status?.origin ?? null,
      degrees: relative !== null && perPulse ? referenceDegrees + relative * perPulse : null,
      microsteps: Number($('microsteps').value) || null, reference: referenceDegrees, mode: state.ready ? state.status?.mode : 'OFFLINE',
      note: $('note').value.trim() });
    renderReadings(); render();
    notice(`Trial ${readings.length} recorded: ${values.torque.toFixed(3)} N·m contact moment.`);
  }));
  function renderReadings() {
    $('readings').replaceChildren();
    for (const reading of readings) {
      const row = document.createElement('tr');
      const columns = [String(reading.trial).padStart(2, '0'), new Date(reading.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), `${reading.grams.toFixed(1)} g`, `${reading.net.toFixed(1)} g`, `${reading.arm} mm`, `${reading.torque.toFixed(3)} N·m`, reading.degrees !== null ? `${reading.degrees.toFixed(2)}°` : reading.position !== null ? `${reading.position} pulses` : 'unavailable', reading.note || '—'];
      for (const value of columns) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      $('readings').append(row);
    }
  }
  $('export').addEventListener('click', () => {
    const headers = ['trial', 'timestamp_utc', 'scale_grams', 'baseline_grams', 'net_grams', 'moment_arm_mm', 'contact_moment_nm', 'commanded_relative_pulses', 'commanded_boot_pulses', 'origin_pulses', 'estimated_output_degrees', 'microsteps', 'reference_degrees', 'motor_mode', 'note'];
    const safeCSV = value => {
      let text = String(value ?? '');
      if (/^[=+@\t\r]/.test(text) || (text.startsWith('-') && !Number.isFinite(Number(text)))) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = readings.map(r => [r.trial, r.timestamp, r.grams, r.baseline, r.net, r.arm, r.torque.toFixed(6), r.position, r.bootPosition, r.origin, r.degrees, r.microsteps, r.reference, r.mode, r.note]);
    const csv = [headers, ...rows].map(row => row.map(safeCSV).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `cycloidal-torque-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice(`${readings.length} trial${readings.length === 1 ? '' : 's'} exported to CSV.`);
  });
  if (!navigator.serial) notice('USB serial is unavailable in this browser. Open http://localhost:8765 in desktop Google Chrome.', true);
  render();
}
