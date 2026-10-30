import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialController, degreesPerPulse, contactMoment } from '../dist/app.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = (overrides = {}) => ({ type: 'status', protocol: 3, mode: 'HOLD', position: 0, origin: 0,
  limit: 200, rate: 0, remaining: 0, motion: 0, last: 8, reason: 'command', ...overrides });

function connected({ now = () => Date.now(), blocked = false } = {}) {
  const controller = new SerialController({ serial: {}, now });
  const commands = [];
  let unblock;
  let first = true;
  controller.writer = {
    async write(bytes) {
      commands.push(new TextDecoder().decode(bytes).trim());
      if (first && blocked) { first = false; await new Promise(resolve => { unblock = resolve; }); }
    },
    async abort() { unblock?.(); }, releaseLock() {},
  };
  controller.connection = 'connecting';
  controller.receive(JSON.stringify({ type: 'hello', protocol: 3, firmware: 'usb-panel-3' }));
  controller.receive(JSON.stringify(status()));
  return { controller, commands, unblock: () => unblock?.() };
}

test('pulse angle and contact moment conversion use real configured geometry', () => {
  assert.equal(degreesPerPulse(''), null);
  assert.equal(degreesPerPulse(4), .03);
  assert.equal(degreesPerPulse(3), null);
  assert.ok(Math.abs(contactMoment(300, 0, 160) - .4707192) < 1e-9);
  assert.ok(Math.abs(contactMoment(300, 20, 160) - .43933792) < 1e-9);
});

test('status without a verified hello never unlocks motion', async () => {
  const controller = new SerialController({ serial: {} });
  controller.receive(JSON.stringify(status()));
  assert.equal(controller.ready, false);
  await assert.rejects(controller.start('RUN', 1, 50, 200, 15000), /matching firmware/);
});

test('verified handshake adopts highest accepted ID and does not auto resume', async () => {
  const { controller, commands } = connected();
  assert.equal(controller.ready, true);
  await controller.start('RUN', 1, 50, 200, 15000);
  assert.ok(commands.includes('RUN 9 1 50 200 15000'));
  await controller.stop();
  assert.equal(controller.active, null);
  assert.ok(commands.includes('STOP 10'));
  await pause(180);
  assert.equal(commands.filter(line => line.startsWith('KEEP')).length, 0);
  await controller.disconnect();
});

test('STOP discards queued RUN and KEEP behind a blocked write', async () => {
  const { controller, commands, unblock } = connected({ blocked: true });
  const start = controller.start('RUN', 1, 50, 200, 15000);
  controller.enqueue('KEEP 9', 'keep');
  const stop = controller.stop();
  unblock();
  assert.equal(await start, false);
  await stop;
  assert.ok(!commands.some(line => line.startsWith('RUN') || line.startsWith('KEEP')));
  assert.ok(commands.includes('STOP 10'));
  await controller.disconnect();
});

test('STOP during an in-flight RUN never starts the heartbeat afterwards', async () => {
  const { controller, commands } = connected();
  await pause(0);
  let unblock;
  const originalWrite = controller.writer.write;
  controller.writer.write = async bytes => {
    await originalWrite(bytes);
    if (new TextDecoder().decode(bytes).startsWith('RUN')) await new Promise(resolve => { unblock = resolve; });
  };
  const start = controller.start('RUN', -1, 50, 200, 15000);
  await pause(0);
  const stopped = controller.stop();
  unblock();
  assert.equal(await start, false);
  await stopped;
  await pause(180);
  assert.ok(!commands.some(line => line.startsWith('KEEP')));
  assert.ok(commands.includes('STOP 10'));
  await controller.disconnect();
});

test('board motion completion cancels heartbeat and ignores older status', async () => {
  const { controller, commands } = connected();
  await controller.start('LOAD', -1, 5, 100, 15000);
  controller.receive(JSON.stringify(status({ last: 8 })));
  assert.equal(controller.active.id, 9);
  controller.receive(JSON.stringify(status({ mode: 'LOAD', last: 9, motion: 9, remaining: 99, rate: 5 })));
  assert.equal(controller.active.accepted, true);
  controller.receive(JSON.stringify(status({ last: 9, reason: 'budget' })));
  assert.equal(controller.active, null);
  await pause(180);
  assert.ok(!commands.some(line => line.startsWith('KEEP')));
  await controller.disconnect();
});

test('loading bounds, boot-origin travel check, and reference protocol', async () => {
  const { controller, commands } = connected();
  await assert.rejects(controller.start('LOAD', 1, 51, 100, 15000), /Rate/);
  await assert.rejects(controller.start('RUN', 1, 50, 20001, 15000), /Run travel/);
  controller.receive(JSON.stringify(status({ position: 100, origin: 100 })));
  assert.throws(() => controller.idleCommand('LIMIT', 99), /current position/);
  await controller.idleCommand('ZERO').sent;
  assert.ok(commands.includes('ZERO 9'));
  await controller.disconnect();
});

test('stale telemetry stops, locks, and disconnects without resuming', async () => {
  let clock = 10000;
  const { controller, commands } = connected({ now: () => clock });
  await controller.start('RUN', 1, 50, 200, 15000);
  clock += 1001;
  controller.healthCheck();
  await pause(20);
  assert.equal(controller.ready, false);
  assert.equal(controller.connection, 'disconnected');
  assert.ok(commands.includes('STOP 10'));
  assert.equal(controller.active, null);
});

test('late duplicate identification from a retry is harmless after connecting', async () => {
  const { controller, commands } = connected();
  await controller.start('RUN', 1, 50, 200, 15000);
  controller.receive(JSON.stringify({ type: 'hello', protocol: 3, firmware: 'usb-panel-3' }));
  await pause(20);
  assert.equal(controller.ready, true);
  assert.equal(controller.active.id, 9);
  assert.ok(!commands.some(line => line.startsWith('STOP')));
  await controller.disconnect();
});

test('latest STOP / RELEASE intent replaces queued terminal commands', async () => {
  const { controller, commands, unblock } = connected({ blocked: true });
  const stop = controller.stop();
  const release = controller.release();
  unblock();
  assert.equal(await stop, false);
  assert.equal(await release, true);
  assert.ok(!commands.includes('STOP 9'));
  assert.ok(commands.includes('RELEASE 10'));
  await controller.disconnect();
});

test('late moving status while RELEASE is pending does not reenable hold', async () => {
  const { controller, commands } = connected();
  await controller.start('RUN', 1, 50, 200, 15000);
  await controller.release();
  controller.receive(JSON.stringify(status({ mode: 'JOG', motion: 9, last: 9, rate: 50, remaining: 100 })));
  await pause(0);
  assert.ok(commands.includes('RELEASE 10'));
  assert.ok(!commands.some(line => line.startsWith('STOP')));
  controller.receive(JSON.stringify(status({ mode: 'RELEASED', last: 10 })));
  assert.equal(controller.terminal, null);
  await controller.disconnect();
});

test('decreasing accepted IDs signal board reset and require reconnect', async () => {
  const { controller, commands } = connected();
  controller.receive(JSON.stringify(status({ last: 0, mode: 'RELEASED' })));
  await pause(20);
  assert.equal(controller.ready, false);
  assert.match(controller.error, /restarted/);
  assert.ok(commands.some(line => line.startsWith('STOP')));
});


test('a lost initial HELLO is retried and real streamed status unlocks the panel', async () => {
  let input;
  let identifications = 0;
  const commands = [];
  const signals = [];
  const respond = value => input.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  const port = {
    readable: new ReadableStream({ start(value) { input = value; } }),
    writable: new WritableStream({ write(bytes) {
      const line = new TextDecoder().decode(bytes).trim(); commands.push(line);
      if (line === 'HELLO') {
        identifications++;
        // Reproduce board line setup/discard losing the initial identification.
        if (identifications > 1) respond({ type:'hello', protocol:3, firmware:'usb-panel-3' });
        respond(status());
      } else if (line === 'STATUS') respond(status());
    } }),
    async open(options) { assert.equal(options.baudRate, 115200); },
    async setSignals(value) { signals.push(value); },
    getInfo() { return { usbVendorId: 0x0483, usbProductId: 0x374b }; },
    async close() {},
  };
  const controller = new SerialController({ serial: {} });
  await controller.connect(port); await pause(0);
  assert.equal(controller.ready, false);
  assert.equal(controller.diagnostics.status, 1);
  assert.match(controller.handshakeFailure(), /status is arriving/);
  await controller.handshakeAttempt(); await pause(0);
  assert.equal(controller.ready, true);
  assert.ok(identifications >= 2);
  assert.ok(controller.diagnostics.bytes > 0);
  assert.equal(controller.diagnostics.port, 'USB 0483:374b');
  assert.deepEqual(signals, [{ dataTerminalReady:true, requestToSend:true }]);
  assert.ok(!commands.some(line => line.startsWith('RUN') || line.startsWith('LOAD')));
  await controller.disconnect();
});

test('USB picker only offers ST USB devices and timeout diagnostics describe received data', async () => {
  let pickerOptions;
  const controller = new SerialController({ serial: {
    async requestPort(options) { pickerOptions=options; const error=new Error('cancel'); error.name='NotFoundError'; throw error; },
  } });
  await controller.connect();
  assert.deepEqual(pickerOptions, { filters:[{ usbVendorId:0x0483 }] });
  assert.equal(controller.connection, 'disconnected');
  assert.match(controller.handshakeFailure(), /no board data/);
  controller.diagnostics.bytes=100;
  controller.diagnostics.hello=1;
  assert.match(controller.handshakeFailure(), /valid live status/);
});

test('closing a connection cannot be undone by a late status acknowledgement', async () => {
  const { controller }=connected();
  controller.connection='closing'; controller.ready=false;
  controller.receive(JSON.stringify(status()));
  assert.equal(controller.ready,false);
  assert.equal(controller.connection,'closing');
  controller.connection='connected'; await controller.disconnect();
});


test('expanded travel and faster jog work while loading remains capped', async () => {
  const { controller, commands } = connected();
  controller.receive(JSON.stringify(status({ position: 12000, origin: 10000, limit: 20000, rate: 2000, remaining: 20000 })));
  assert.equal(controller.ready, true);
  assert.equal(controller.status.position, 12000);
  await controller.idleCommand('LIMIT', 20000).sent;
  assert.ok(commands.includes('LIMIT 9 20000'));
  await controller.start('RUN', 1, 2000, 20000, 15000);
  assert.ok(commands.includes('RUN 10 1 2000 20000 15000'));
  await controller.stop();
  await assert.rejects(controller.start('RUN', 1, 2001, 20000, 15000), /Rate/);
  await assert.rejects(controller.start('LOAD', 1, 51, 20000, 15000), /Rate/);
  await controller.disconnect();
});

test('the faster panel rejects firmware with the previous range limits', async () => {
  const controller = new SerialController({ serial: {} });
  controller.connection = 'connecting';
  controller.receive(JSON.stringify({ type: 'hello', protocol: 2, firmware: 'usb-panel-2' }));
  await pause(20);
  assert.equal(controller.ready, false);
  assert.match(controller.error, /does not match/);
});
