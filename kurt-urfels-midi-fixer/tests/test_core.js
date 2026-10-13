// Run with: node tests/test_core.js
// Builds small MIDI files in memory, so the repo does not need to ship anyone's songs.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const M = require('../src/core.js');

const ps = new M.PresetSet(JSON.parse(fs.readFileSync(path.join(__dirname, '../src/presets.json'), 'utf8')));
const ch = (tick, st, c, d1, d2 = 0) => ({ tick, kind: 'ch', status: st | c, ch: c, d1, d2 });
const meta = (tick, type, data) => ({ tick, kind: 'meta', type, data: new Uint8Array(data) });
const tempo120 = meta(0, 0x51, [0x07, 0xa1, 0x20]);
function midi(tracks) {
  return M.writeMidi({ format: 1, division: 480, others: [], warnings: [], tracks: tracks.map(events => ({ events })) });
}
function beat(c, keys, n, vel = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = keys[i % keys.length];
    out.push(ch(i * 240, 0x90, c, k, vel), ch(i * 240 + 60, 0x80, c, k, 0));
  }
  return out;
}
function ids(an) { return an.issues.map(i => i.id); }
function fixAll(smf, an, extra = {}) {
  const opts = Object.assign({ move: [] }, extra);
  an.issues.forEach(i => {
    if (!i.fix || !i.fixDefault) return;
    if (i.fix.startsWith('move:')) opts.move.push(+i.fix.slice(5)); else opts[i.fix] = true;
  });
  const r = M.repair(smf, ps, opts);
  return { r, after: M.analyze(M.parseMidi(r.bytes), ps) };
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }

test('write and read back without changes', () => {
  const bytes = midi([[tempo120], [ch(0, 0xc0, 0, 5), ...beat(0, [60, 64, 67], 16)]]);
  const a = M.parseMidi(bytes), b = M.parseMidi(M.writeMidi(a));
  const sig = s => s.tracks.map(t => t.events.map(e => [e.tick, e.kind, e.status, e.d1, e.d2, e.type].join()).join('|')).join('#');
  assert.strictEqual(sig(a), sig(b));
});

test('CC0 = 0 + program 0 on channel 10 plays as a piano, the fix brings the drums back', () => {
  const smf = M.parseMidi(midi([[tempo120], [ch(0, 0xb0, 9, 0, 0), ch(0, 0xb0, 9, 32, 0), ch(0, 0xc0, 9, 0), ...beat(9, [36, 42, 38, 42], 32)]]));
  const an = M.analyze(smf, ps);
  assert.ok(ids(an).includes('drumBank'));
  assert.strictEqual(an.channels[9].heardList[0].preset.bank, 0);
  const { after } = fixAll(smf, an);
  assert.ok(ids(after).includes('drumOk'));
  assert.ok(after.channels[9].heardList.every(h => h.preset.bank >= 120));
});

test('a clean file still gets the guard against a broken song before it', () => {
  const smf = M.parseMidi(midi([[tempo120], [ch(0, 0xc0, 9, 0), ...beat(9, [36, 38], 16)]]));
  const an = M.analyze(smf, ps);
  assert.ok(ids(an).includes('drumGuard'));
  assert.ok(ids(fixAll(smf, an).after).includes('drumOk'));
});

test('drums on channel 5 marked by GS SysEx move to channel 10', () => {
  const gsRhythm = { tick: 0, kind: 'sysex', data: new Uint8Array([0x41, 0x10, 0x42, 0x12, 0x40, 0x15, 0x15, 0x02, 0x14, 0xf7]) };
  const smf = M.parseMidi(midi([[tempo120, gsRhythm], [meta(0, 3, [...Buffer.from('Drums')]), ch(0, 0xc0, 4, 25), ...beat(4, [36, 42, 38, 42], 32)]]));
  const an = M.analyze(smf, ps);
  assert.ok(ids(an).includes('move4'));
  const { after } = fixAll(smf, an);
  assert.strictEqual(after.channels[4].notes, 0);
  assert.strictEqual(after.channels[9].notes, 32);
  assert.ok(after.channels[9].heardList.every(h => h.preset.bank >= 120));
});

test('a missing kit (TR-707) maps to the closest kit in GeneralUser GS', () => {
  assert.strictEqual(M.mapKit(ps, 29), 25);
  assert.strictEqual(M.mapKit(ps, 9), 8);
  assert.strictEqual(M.mapKit(ps, 0), 0);
});

test('thinning keeps notes and gets a dense file under 1000 events per second', () => {
  const lead = [ch(0, 0xc0, 0, 80)];
  for (let i = 0; i < 8000; i++) lead.push(ch(i, 0xe0, 0, i & 0x7f, 64 + ((i >> 7) & 7)));
  for (let i = 0; i < 300; i++) lead.push(ch(i * 50, 0xb0, 0, 99, 1), ch(i * 50, 0xb0, 0, 98, 8), ch(i * 50, 0xb0, 0, 6, i & 0x7f));
  lead.push(...beat(0, [60, 62, 64], 40));
  lead.sort((a, b) => a.tick - b.tick);
  const smf = M.parseMidi(midi([[tempo120], lead]));
  const an = M.analyze(smf, ps);
  assert.ok(an.peak > 1000 && ids(an).includes('thin'));
  const { after } = fixAll(smf, an);
  assert.ok(after.peak < 1000);
  assert.strictEqual(after.channels[0].notes, an.channels[0].notes);
});

test('boost brings a quiet file to full level and keeps the balance', () => {
  const smf = M.parseMidi(midi([[tempo120],
    [ch(0, 0xb0, 0, 7, 80), ch(0, 0xc0, 0, 0), ...beat(0, [60, 64], 16, 70)],
    [ch(0, 0xb0, 1, 7, 60), ch(0, 0xc0, 1, 33), ...beat(1, [40, 43], 16, 70)]]));
  const an = M.analyze(smf, ps);
  assert.ok(an.headroom >= 3 && ids(an).includes('loud'));
  const { after } = fixAll(smf, an, { loudTarget: 0 });
  assert.ok(Math.abs(after.level) < 0.5, 'loudest notes at about 0 dB, got ' + after.level);
  const lv = M.noteLevels(M.parseMidi(fixAll(smf, an).r.bytes));
  const gap = Math.max(...lv.filter(l => l.ch === 0).map(l => l.db)) - Math.max(...lv.filter(l => l.ch === 1).map(l => l.db));
  const gap0 = 40 * Math.log10(80 / 60);
  assert.ok(Math.abs(gap - gap0) < 0.6, 'channel balance kept: ' + gap.toFixed(2) + ' vs ' + gap0.toFixed(2));
});

test('zip output lists every file', () => {
  const z = M.makeZip([{ name: 'a.mid', data: new Uint8Array([1, 2, 3]) }, { name: 'a.mid', data: new Uint8Array([4]) }]);
  const text = Buffer.from(z).toString('latin1');
  assert.ok(text.includes('a.mid') && text.includes('a_2.mid'));
});

console.log(`\n${passed} tests passed`);
