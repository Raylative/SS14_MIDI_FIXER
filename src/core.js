/* MIDI Doctor core: read/write SMF, model how SS14 plays it, find problems, repair, zip. */
(function (root) {
  'use strict';

  var DRUM_CH = 9;            // MIDI channel 10 (9 zero-based), RobustMidiEvent.PercussionChannel
  var SS14_DRUM_BANK = 120;   // GeneralUser GS has the same kits in bank 120 (GM2 rhythm bank)
  var EVENTS_PER_SEC = 1000;  // CCVar midi.max_events_per_second
  var THIN_GAP = 0.025;       // seconds: at most one value per controller and channel in this window

  // ---------------------------------------------------------------- helpers
  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function str4(b, p) { return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); }
  function be32(b, p) { return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; }
  function be16(b, p) { return (b[p] << 8) | b[p + 1]; }
  function le32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function le16(b, p) { return b[p] | (b[p + 1] << 8); }

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
  }

  function readVLQ(b, p, end) {
    var v = 0;
    for (var n = 0; n < 4; n++) {
      if (p >= end) throw new Error('File ends in the middle of a delta time');
      var c = b[p++];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return [v, p];
    }
    throw new Error('Invalid delta time (VLQ)');
  }

  function vlq(v) {
    var out = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { out.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    return out;
  }

  // ---------------------------------------------------------------- read SMF
  // event: {tick, kind:'ch'|'meta'|'sysex'|'escape', status, ch, d1, d2, type, data}
  function parseMidi(input) {
    var b = u8(input);
    var warnings = [];
    var off = 0;
    // RIFF RMID wrapper
    if (b.length >= 12 && str4(b, 0) === 'RIFF' && str4(b, 8) === 'RMID') {
      var q = 12, found = false;
      while (q + 8 <= b.length) {
        var id = str4(b, q), sz = le32(b, q + 4);
        if (id === 'data') { b = b.subarray(q + 8, Math.min(b.length, q + 8 + sz)); found = true; break; }
        q += 8 + sz + (sz & 1);
      }
      if (!found) throw new Error('RMID file without MIDI data');
      warnings.push('Removed RIFF (RMID) wrapper');
    }
    // some files have junk before the header
    var start = -1;
    for (var s = 0; s + 4 <= Math.min(b.length, 4096); s++) { if (str4(b, s) === 'MThd') { start = s; break; } }
    if (start < 0) throw new Error('Not a MIDI file (no MThd header)');
    if (start > 0) warnings.push('Ignored ' + start + ' bytes before the MIDI header');
    off = start;
    var hlen = be32(b, off + 4);
    var format = be16(b, off + 8), ntrks = be16(b, off + 10), division = be16(b, off + 12);
    off += 8 + hlen;

    var tracks = [], others = [];
    while (off + 8 <= b.length) {
      var cid = str4(b, off), clen = be32(b, off + 4);
      var cstart = off + 8, cend = cstart + clen;
      if (cend > b.length) { warnings.push('Track ' + (tracks.length + 1) + ' is cut off'); cend = b.length; }
      if (cid === 'MTrk') tracks.push(parseTrack(b, cstart, cend, tracks.length, warnings));
      else others.push({ id: cid, data: b.slice(cstart, cend), afterTrack: tracks.length });
      off = cend;
      if (!/^[\x20-\x7e]{4}$/.test(cid)) { warnings.push('Ignored unknown data at the end of the file'); break; }
    }
    if (tracks.length !== ntrks) warnings.push('Header says ' + ntrks + ' tracks, found ' + tracks.length);
    return { format: format, division: division, tracks: tracks, others: others, warnings: warnings };
  }

  function parseTrack(b, p, end, ti, warnings) {
    var events = [], tick = 0, running = 0, seq = 0;
    while (p < end) {
      var r;
      try { r = readVLQ(b, p, end); } catch (e) { warnings.push('Track ' + (ti + 1) + ': ' + e.message); break; }
      tick += r[0]; p = r[1];
      if (p >= end) break;
      var st = b[p];
      if (st === 0xff) {
        if (p + 2 > end) break;
        var type = b[p + 1];
        var lr = readVLQ(b, p + 2, end);
        var dend = Math.min(end, lr[1] + lr[0]);
        events.push({ tick: tick, kind: 'meta', type: type, data: b.slice(lr[1], dend), seq: seq++ });
        p = dend;
        if (type === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) {
        var sr = readVLQ(b, p + 1, end);
        var send = Math.min(end, sr[1] + sr[0]);
        events.push({ tick: tick, kind: st === 0xf0 ? 'sysex' : 'escape', status: st, data: b.slice(sr[1], send), seq: seq++ });
        p = send;
        running = 0;
        continue;
      }
      var status;
      if (st & 0x80) { status = st; p++; if (st < 0xf0) running = st; }
      else if (running) { status = running; }
      else { warnings.push('Track ' + (ti + 1) + ': skipped a data byte without status'); p++; continue; }
      if (status >= 0xf0) { // system common/realtime inside a file: guess the length, skip
        var len = status === 0xf2 ? 2 : (status === 0xf1 || status === 0xf3) ? 1 : 0;
        p += len;
        continue;
      }
      var hi = status & 0xf0;
      var two = hi === 0xc0 || hi === 0xd0;
      var d1 = b[p++] & 0x7f, d2 = 0;
      if (!two) d2 = b[p++] & 0x7f;
      if (p > end) break;
      events.push({ tick: tick, kind: 'ch', status: status, ch: status & 0x0f, d1: d1, d2: d2, seq: seq++ });
    }
    var last = events[events.length - 1];
    if (!last || !(last.kind === 'meta' && last.type === 0x2f)) {
      events.push({ tick: tick, kind: 'meta', type: 0x2f, data: new Uint8Array(0), seq: seq++, added: true });
    }
    return { events: events };
  }

  // ---------------------------------------------------------------- write SMF
  function writeMidi(smf) {
    var parts = [];
    var hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
      0, smf.format & 0xff, (smf.tracks.length >> 8) & 0xff, smf.tracks.length & 0xff,
      (smf.division >> 8) & 0xff, smf.division & 0xff];
    parts.push(new Uint8Array(hdr));
    for (var t = 0; t < smf.tracks.length; t++) {
      var evs = smf.tracks[t].events.filter(function (e) { return !e.deleted; });
      // end of track always last, on the latest tick
      var maxTick = 0, eot = null, body = [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (e.tick > maxTick) maxTick = e.tick;
        if (e.kind === 'meta' && e.type === 0x2f) { eot = e; continue; }
        body.push(e);
      }
      body.push({ tick: maxTick, kind: 'meta', type: 0x2f, data: new Uint8Array(0) });
      var bytes = [], prev = 0;
      for (var k = 0; k < body.length; k++) {
        var ev = body[k];
        var tk = Math.max(ev.tick, prev);
        pushArr(bytes, vlq(tk - prev));
        prev = tk;
        if (ev.kind === 'ch') {
          var hi = ev.status & 0xf0;
          bytes.push(hi | (ev.ch & 0x0f), ev.d1 & 0x7f);
          if (hi !== 0xc0 && hi !== 0xd0) bytes.push(ev.d2 & 0x7f);
        } else if (ev.kind === 'meta') {
          bytes.push(0xff, ev.type);
          pushArr(bytes, vlq(ev.data.length));
          pushArr(bytes, ev.data);
        } else {
          bytes.push(ev.kind === 'sysex' ? 0xf0 : 0xf7);
          pushArr(bytes, vlq(ev.data.length));
          pushArr(bytes, ev.data);
        }
      }
      var n = bytes.length;
      parts.push(new Uint8Array([0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
      parts.push(new Uint8Array(bytes));
    }
    var total = 0;
    parts.forEach(function (x) { total += x.length; });
    var out = new Uint8Array(total), o = 0;
    parts.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }
  function pushArr(dst, src) { for (var i = 0; i < src.length; i++) dst.push(src[i]); }

  function cloneSmf(smf) {
    return {
      format: smf.format, division: smf.division, others: smf.others, warnings: smf.warnings.slice(),
      tracks: smf.tracks.map(function (t) {
        return { events: t.events.map(function (e) { return Object.assign({}, e); }) };
      })
    };
  }

  // ---------------------------------------------------------------- time
  function buildClock(smf) {
    var div = smf.division;
    if (div & 0x8000) {
      var fps = 256 - (div >> 8), tpf = div & 0xff;
      if (fps === 29) fps = 29.97;
      var spt = 1 / (fps * tpf);
      return { toSec: function (t) { return t * spt; } };
    }
    var tpq = div || 480;
    var tempos = [];
    smf.tracks.forEach(function (tr) {
      tr.events.forEach(function (e) {
        if (e.kind === 'meta' && e.type === 0x51 && e.data.length >= 3 && !e.deleted)
          tempos.push({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] });
      });
    });
    tempos.sort(function (a, b) { return a.tick - b.tick; });
    var segs = [{ tick: 0, sec: 0, us: 500000 }];
    tempos.forEach(function (tp) {
      var last = segs[segs.length - 1];
      var sec = last.sec + (tp.tick - last.tick) * last.us / 1e6 / tpq;
      if (tp.tick === last.tick) { last.us = tp.us; }
      else segs.push({ tick: tp.tick, sec: sec, us: tp.us });
    });
    return {
      toSec: function (t) {
        var lo = 0, hi = segs.length - 1;
        while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (segs[mid].tick <= t) lo = mid; else hi = mid - 1; }
        var s = segs[lo];
        return s.sec + (t - s.tick) * s.us / 1e6 / tpq;
      }
    };
  }

  // all events of all tracks in playback order (tick, then track, like the FluidSynth player)
  function timeline(smf) {
    var all = [];
    smf.tracks.forEach(function (tr, ti) {
      tr.events.forEach(function (e, idx) { if (!e.deleted) all.push({ e: e, t: ti, i: idx }); });
    });
    all.sort(function (a, b) { return a.e.tick - b.e.tick || a.t - b.t || a.i - b.i; });
    return all;
  }

  // ---------------------------------------------------------------- soundfont presets
  function PresetSet(list) {
    this.map = new Map();
    var self = this;
    (list || []).forEach(function (p) { self.map.set(p[0] * 1000 + p[1], p[2]); });
  }
  PresetSet.prototype.has = function (bank, prog) { return this.map.has(bank * 1000 + prog); };
  PresetSet.prototype.name = function (bank, prog) { return this.map.get(bank * 1000 + prog); };
  PresetSet.prototype.kits = function () {
    var out = [];
    this.map.forEach(function (n, k) { if (Math.floor(k / 1000) === 128) out.push(k % 1000); });
    return out.sort(function (a, b) { return a - b; });
  };
  PresetSet.prototype.size = function () { return this.map.size; };

  // read phdr from an .sf2 (skips the sample data)
  function sf2Presets(input) {
    var b = u8(input);
    if (b.length < 12 || str4(b, 0) !== 'RIFF' || str4(b, 8) !== 'sfbk') throw new Error('Not an SF2 soundfont');
    var p = 12;
    while (p + 8 <= b.length) {
      var id = str4(b, p), sz = le32(b, p + 4);
      if (id === 'LIST' && str4(b, p + 8) === 'pdta') {
        var q = p + 12, end = Math.min(b.length, p + 8 + sz);
        while (q + 8 <= end) {
          var sid = str4(b, q), ssz = le32(b, q + 4);
          if (sid === 'phdr') {
            var out = [];
            for (var i = 0; i < Math.floor(ssz / 38) - 1; i++) {
              var r = q + 8 + i * 38, name = '';
              for (var c = 0; c < 20 && b[r + c]; c++) name += String.fromCharCode(b[r + c]);
              out.push([le16(b, r + 22), le16(b, r + 20), name.trim()]);
            }
            return out;
          }
          q += 8 + ssz + (ssz & 1);
        }
      }
      p += 8 + sz + (sz & 1);
    }
    throw new Error('SF2 without a preset list');
  }

  // fluid_synth_program_change: find the preset, else fall back
  function resolvePreset(ps, isDrumCh, bank, prog) {
    if (ps.has(bank, prog)) return { bank: bank, prog: prog };
    if (isDrumCh) {
      if (ps.has(128, prog)) return { bank: 128, prog: prog, fallback: true };
      if (ps.has(128, 0)) return { bank: 128, prog: 0, fallback: true };
    } else {
      if (ps.has(0, prog)) return { bank: 0, prog: prog, fallback: true };
      if (ps.has(0, 0)) return { bank: 0, prog: 0, fallback: true };
    }
    return { bank: bank, prog: prog, missing: true };
  }

  var GS_KITS = {
    0: 'Standard', 1: 'Standard 2', 2: 'Standard 3', 8: 'Room', 16: 'Power', 24: 'Electronic', 25: 'TR-808',
    26: 'Dance', 27: 'CR-78', 28: 'TR-606', 29: 'TR-707', 30: 'TR-909', 32: 'Jazz', 40: 'Brush', 48: 'Orchestra',
    49: 'Ethnic', 50: 'Kick & Snare', 52: 'Asia', 53: 'Cymbal & Claps', 54: 'Gamelan', 56: 'SFX', 57: 'Rhythm FX',
    58: 'Rhythm FX 2', 59: 'Rhythm FX 3', 127: 'CM-64/32L'
  };
  function kitLabel(ps, prog) { return ps.name(128, prog) || GS_KITS[prog] || ('Kit ' + prog); }

  function mapKit(ps, prog) {
    if (ps.has(128, prog)) return prog;
    if (prog >= 27 && prog <= 31) { if (ps.has(128, 25)) return 25; if (ps.has(128, 24)) return 24; }
    for (var q = prog - 1; q >= (prog & ~7); q--) if (ps.has(128, q)) return q;
    return ps.has(128, 0) ? 0 : prog;
  }

  function presetLabel(ps, p) {
    if (p.bank >= 120) return 'Drum kit “' + kitLabel(ps, p.prog) + '”';
    var n = ps.name(p.bank, p.prog) || ps.name(0, p.prog) || ('program ' + p.prog);
    return '“' + n + '”' + (p.bank ? ' (bank ' + p.bank + ')' : '');
  }

  // ---------------------------------------------------------------- SysEx
  function gsPartToChannel(n) { return n === 0 ? 9 : (n <= 9 ? n - 1 : n); }
  function readSysex(data) {
    // data without the leading F0
    var d = data;
    if (d.length >= 9 && d[0] === 0x41 && d[2] === 0x42 && d[3] === 0x12) {
      var a1 = d[4], a2 = d[5], a3 = d[6];
      if (a1 === 0x40 && a2 === 0x00 && a3 === 0x7f) return { kind: 'gsReset' };
      if (a1 === 0x40 && (a2 & 0xf0) === 0x10 && a3 === 0x15) return { kind: 'gsRhythm', ch: gsPartToChannel(a2 & 0x0f), map: d[7] };
      return { kind: 'gs' };
    }
    if (d.length >= 7 && d[0] === 0x43 && (d[1] & 0xf0) === 0x10 && d[2] === 0x4c) {
      if (d[3] === 0x00 && d[4] === 0x00 && d[5] === 0x7e) return { kind: 'xgReset' };
      if (d[3] === 0x08 && d[5] === 0x07) return { kind: 'xgPartMode', ch: d[4] & 0x0f, mode: d[6] };
      return { kind: 'xg' };
    }
    if (d.length >= 4 && d[0] === 0x7e && d[2] === 0x09) return { kind: d[3] === 0x01 || d[3] === 0x03 ? 'gmOn' : 'gmOff' };
    return { kind: 'other' };
  }

  var DRUM_NAME = /\b(drums?|drumkit|perc\w*|kit|schlagzeug|snares?|kicks?|hi.?hats?|cymbals?|toms?|808|909|707|606|tr-?\d{3})\b/i;
  var GM_DRUM_KEYS = new Set([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 59]);

  // ---------------------------------------------------------------- analysis
  function analyze(smf, ps, opts) {
    opts = opts || {};
    var clock = buildClock(smf);
    var tl = timeline(smf);
    var chs = [];
    for (var c = 0; c < 16; c++) {
      chs.push({
        ch: c, notes: 0, minKey: 127, maxKey: 0, firstNote: null, firstNoteSec: null, tracks: new Set(),
        programs: [], cc0: [], cc32: [], drumKeyHits: 0, keys: new Set(),
        heard: new Map(), intendedHeard: new Map(), pcBeforeFirstNote: false, missingKits: new Set()
      });
    }
    // track names and SS14 channel labels
    var trackInfo = smf.tracks.map(function () { return { name: null, inst: null, prog: null, chans: new Set() }; });
    smf.tracks.forEach(function (tr, ti) {
      tr.events.forEach(function (e) {
        if (e.deleted) return;
        if (e.kind === 'meta') {
          var info = trackInfo[ti];
          if (e.type === 0x03 && info.name === null) info.name = decodeText(e.data).trim();
          if (e.type === 0x04 && info.inst === null) info.inst = decodeText(e.data).trim();
          if (e.type === 0x08 && info.prog === null) info.prog = decodeText(e.data).trim();
        } else if (e.kind === 'ch') trackInfo[ti].chans.add(e.ch);
      });
    });
    var ss14Labels = [];
    trackInfo.forEach(function (ti) {
      if (ti.name === null && ti.prog === null && ti.inst === null) return;
      if (ti.name !== null || ti.prog !== null) ss14Labels.push(ti.name !== null ? ti.name : ti.prog);
      else ss14Labels.push(null);
    });

    // state: SS14 (DAW) and "intended" (a normal GS/GM player)
    var ss = { bank: [], preset: [] }, it = { bank: [], preset: [], drum: [] };
    var sysexInfo = { count: 0, gsReset: 0, xgReset: 0, gmOn: 0, rhythm: [], xgDrum: [] };
    var nrpnMsb = new Array(16).fill(-1), nrpnActive = new Array(16).fill(false), nrpnJunk = 0;
    for (var k = 0; k < 16; k++) {
      ss.bank[k] = k === DRUM_CH ? 128 : 0;
      ss.preset[k] = k === DRUM_CH ? resolvePreset(ps, true, 128, 0) : resolvePreset(ps, false, 0, 0);
      it.drum[k] = k === DRUM_CH;
      it.bank[k] = 0;
      it.preset[k] = k === DRUM_CH ? { bank: 128, prog: 0 } : { bank: 0, prog: 0 };
    }
    // which channels SysEx or bank selects mark as drums
    var drumCue = [];
    for (var z = 0; z < 16; z++) drumCue.push({ strong: [], medium: [] });

    var chEvents = []; // for event density
    var dupCount = 0, ccState = [];
    for (var y = 0; y < 16; y++) ccState.push({ cc: new Int16Array(128).fill(-1), pb: -1, cp: -1 });

    tl.forEach(function (ref) {
      var e = ref.e;
      if (e.kind === 'sysex') {
        sysexInfo.count++;
        var sx = readSysex(e.data);
        if (sx.kind === 'gsReset') sysexInfo.gsReset++;
        if (sx.kind === 'xgReset') sysexInfo.xgReset++;
        if (sx.kind === 'gmOn') sysexInfo.gmOn++;
        if (sx.kind === 'gsRhythm') {
          sysexInfo.rhythm.push({ ch: sx.ch, map: sx.map, tick: e.tick });
          if (sx.map > 0 && sx.ch !== DRUM_CH) drumCue[sx.ch].strong.push('GS SysEx “use for rhythm part”');
          it.drum[sx.ch] = sx.map > 0;
          it.preset[sx.ch] = sx.map > 0 ? { bank: 128, prog: it.preset[sx.ch].prog } : { bank: it.bank[sx.ch], prog: it.preset[sx.ch].prog };
        }
        if (sx.kind === 'xgPartMode') {
          sysexInfo.xgDrum.push({ ch: sx.ch, mode: sx.mode });
          if (sx.mode > 0 && sx.ch !== DRUM_CH) drumCue[sx.ch].strong.push('XG SysEx “part mode: drum”');
          it.drum[sx.ch] = sx.mode > 0;
        }
        return;
      }
      if (e.kind !== 'ch') return;
      var ch = e.ch, hi = e.status & 0xf0, info = chs[ch];
      info.tracks.add(ref.t);
      chEvents.push(clock.toSec(e.tick));
      var st = ccState[ch];
      if (hi === 0x90 && e.d2 > 0) {
        info.notes++;
        info.keys.add(e.d1);
        if (e.d1 < info.minKey) info.minKey = e.d1;
        if (e.d1 > info.maxKey) info.maxKey = e.d1;
        if (GM_DRUM_KEYS.has(e.d1)) info.drumKeyHits++;
        if (info.firstNote === null) { info.firstNote = e.tick; info.firstNoteSec = clock.toSec(e.tick); }
        var key = ss.preset[ch].bank * 1000 + ss.preset[ch].prog;
        var h = info.heard.get(key) || { preset: ss.preset[ch], notes: 0, firstSec: clock.toSec(e.tick) };
        h.notes++; info.heard.set(key, h);
        var raw = it.preset[ch];
        var ip = resolvePreset(ps, it.drum[ch], raw.bank, raw.prog);
        if (it.drum[ch] && !ps.has(128, raw.prog)) info.missingKits.add(raw.prog);
        var ik = ip.bank * 1000 + ip.prog;
        var ih = info.intendedHeard.get(ik) || { preset: ip, notes: 0 };
        ih.notes++; info.intendedHeard.set(ik, ih);
      } else if (hi === 0xb0) {
        var cc = e.d1, v = e.d2;
        if (cc === 99) { nrpnMsb[ch] = v; nrpnActive[ch] = true; }
        if (cc === 101 || cc === 100) nrpnActive[ch] = false;
        if (cc === 99) { if (v !== 120 && v !== 127) nrpnJunk++; }
        else if (nrpnActive[ch] && nrpnMsb[ch] !== 120 && nrpnMsb[ch] !== 127 && (cc === 98 || cc === 6 || cc === 38 || cc === 96 || cc === 97)) nrpnJunk++;
        if (isDedupCC(cc)) { if (st.cc[cc] === v) dupCount++; st.cc[cc] = v; }
        if (cc === 0) {
          info.cc0.push({ tick: e.tick, v: v });
          ss.bank[ch] = v;
          if (!it.drum[ch]) it.bank[ch] = v;
          if (ch !== DRUM_CH && info.firstNote === null) {
            if (v === 120) drumCue[ch].strong.push('bank 120 (GM2 drum bank)');
            else if (v === 127 || v === 126) drumCue[ch].medium.push('bank ' + v + ' (XG drum bank)');
          }
        }
        if (cc === 32) info.cc32.push({ tick: e.tick, v: v });
      } else if (hi === 0xc0) {
        info.programs.push({ tick: e.tick, prog: e.d1, ssBank: ss.bank[ch], sec: clock.toSec(e.tick) });
        if (info.firstNote === null) info.pcBeforeFirstNote = true;
        ss.preset[ch] = resolvePreset(ps, ch === DRUM_CH, ss.bank[ch], e.d1);
        it.preset[ch] = it.drum[ch] ? { bank: 128, prog: e.d1 } : { bank: it.bank[ch], prog: e.d1 };
      } else if (hi === 0xe0) {
        var pb = e.d1 | (e.d2 << 7);
        if (st.pb === pb) dupCount++; st.pb = pb;
      } else if (hi === 0xd0) {
        if (st.cp === e.d1) dupCount++; st.cp = e.d1;
      }
    });

    // density (sliding 1 s window)
    chEvents.sort(function (a, b) { return a - b; });
    var peak = 0, peakAt = 0, j0 = 0;
    for (var j = 0; j < chEvents.length; j++) {
      while (chEvents[j] - chEvents[j0] >= 1) j0++;
      if (j - j0 + 1 > peak) { peak = j - j0 + 1; peakAt = chEvents[j0]; }
    }
    var lastTick = 0;
    smf.tracks.forEach(function (tr) { tr.events.forEach(function (e) { if (!e.deleted && e.tick > lastTick) lastTick = e.tick; }); });

    // per channel
    chs.forEach(function (info) {
      info.used = info.notes > 0;
      info.trackNames = Array.from(info.tracks).map(function (t) { return trackInfo[t].name; }).filter(Boolean);
      if (info.ch !== DRUM_CH && info.used) {
        var nm = info.trackNames.join(' ');
        if (DRUM_NAME.test(nm)) drumCue[info.ch].medium.push('track name “' + nm + '”');
        var ratio = info.drumKeyHits / info.notes;
        info.drumLikeNotes = ratio > 0.8 && info.keys.size >= 3 && info.minKey >= 27;
      }
      info.heardList = Array.from(info.heard.values()).sort(function (a, b) { return b.notes - a.notes; });
      info.intendedList = Array.from(info.intendedHeard.values()).sort(function (a, b) { return b.notes - a.notes; });
      info.cue = drumCue[info.ch];
      info.drumSuspect = info.ch !== DRUM_CH && info.used &&
        (info.cue.strong.length > 0 || (info.cue.medium.length > 0 && info.drumLikeNotes));
      info.ss14Label = ss14Labels[info.ch] === undefined ? null : ss14Labels[info.ch];
      info.isDrumIntended = info.ch === DRUM_CH ? it.drum[DRUM_CH] : info.drumSuspect;
    });

    var issues = [];
    var d = chs[DRUM_CH];
    var dWrong = d.heardList.filter(function (h) { return h.preset.bank < 120; });
    var wrongNotes = dWrong.reduce(function (s, h) { return s + h.notes; }, 0);
    var missingKits = [];
    d.missingKits.forEach(function (k) { missingKits.push(k); });
    // guarded = channel 10 sets a drum bank (>= 120) and a kit itself before its first note
    var cc0BeforeNote = d.cc0.filter(function (x) { return d.firstNote === null || x.tick <= d.firstNote; });
    var guarded = d.pcBeforeFirstNote && cc0BeforeNote.length > 0 && d.cc0.every(function (x) { return x.v >= 120; });

    if (d.used && wrongNotes > 0) {
      issues.push({
        id: 'drumBank', level: 'error',
        title: 'Drums play as ' + presetLabel(ps, dWrong[0].preset) + ' in SS14',
        text: wrongNotes + ' of ' + d.notes + ' drum notes on channel 10 come out as ' +
          dWrong.map(function (h) { return presetLabel(ps, h.preset); }).join(', ') +
          '. The file sends a bank select on channel 10 (CC0 = ' + d.cc0.map(function (x) { return x.v; }).filter(uniq).join(', ') +
          ') and SS14 applies it directly, without the drum channel exception.',
        fix: 'drumBank', fixDefault: true
      });
    } else if (d.used && !guarded) {
      issues.push({
        id: 'drumGuard', level: 'warn',
        title: 'Drums can turn into a piano after a broken song',
        text: 'On a fresh DAW, channel 10 sounds right. SS14 does not reset the synth between songs, though. ' +
          'Switch straight from a broken song to this one and channel 10 stays on bank 0, so the drums play as a piano. ' +
          'The fix makes the file set bank 120' + (d.pcBeforeFirstNote ? '' : ' and kit 0') + ' itself at the start.',
        fix: 'drumBank', fixDefault: true
      });
    } else if (d.used) {
      issues.push({ id: 'drumOk', level: 'ok', title: 'Drums on channel 10 are fine', text: 'Channel 10 sets the drum bank and a kit itself at the start.' });
    }
    if (d.used && missingKits.length) {
      issues.push({
        id: 'kitMap', level: 'warn',
        title: 'Drum kit missing from the soundfont: ' + missingKits.map(function (k) { return k + ' ' + (GS_KITS[k] || ''); }).join(', '),
        text: 'SS14 falls back to the Standard kit. Closest replacement: ' + missingKits.map(function (k) {
          var m = mapKit(ps, k); return (GS_KITS[k] || ('kit ' + k)) + ' → ' + kitLabel(ps, m);
        }).join(', ') + '.',
        fix: 'kitMap', fixDefault: true
      });
    }
    var suspects = chs.filter(function (c) { return c.drumSuspect; });
    suspects.forEach(function (c) {
      issues.push({
        id: 'move' + c.ch, level: c.cue.strong.length ? 'error' : 'warn',
        title: 'Channel ' + (c.ch + 1) + ' looks like drums too',
        text: 'Clues: ' + c.cue.strong.concat(c.cue.medium).join('; ') + '. SS14 only plays drums on channel 10, so this comes out as ' +
          (c.heardList[0] ? presetLabel(ps, c.heardList[0].preset) : '?') + '.' +
          (d.used ? ' Channel 10 already has notes, so moving merges both.' : ''),
        fix: 'move:' + c.ch, fixDefault: c.cue.strong.length > 0 && !d.used
      });
    });
    if (peak > EVENTS_PER_SEC * 0.8) {
      issues.push({
        id: 'thin', level: peak > EVENTS_PER_SEC ? 'error' : 'warn',
        title: 'Too many events: ' + peak + ' per second at ' + fmtTime(peakAt),
        text: 'SS14 sends at most ' + EVENTS_PER_SEC + ' events per second to other players. Above that they hear lag and dropouts, while it sounds fine to you. ' +
          (nrpnJunk ? nrpnJunk + ' NRPN messages do nothing in SS14. ' : '') +
          (dupCount ? dupCount + ' controller messages only repeat the previous value. ' : '') +
          'Thinning removes those and keeps one value per ' + Math.round(THIN_GAP * 1000) + ' ms in controller sweeps. Notes stay untouched.',
        fix: 'thin', fixDefault: true
      });
    }
    // volume
    var lv = noteLevels(smf).map(function (l) { return l.db; });
    var level = lv.length ? percentile(lv, LOUD_PCT) : 0;
    var headroom = -level;
    if (lv.length && headroom >= 1) {
      issues.push({
        id: 'loud', level: headroom >= 3 ? 'warn' : 'info',
        title: 'Quiet: the loudest notes sit ' + headroom.toFixed(1) + ' dB below full volume',
        text: 'SS14 instruments are quiet to begin with, so every lost dB counts. Boost raises channel volume (CC7), expression (CC11) and note velocity together. The balance between instruments stays the same.',
        fix: 'loud', fixDefault: headroom >= 3
      });
    } else if (lv.length) {
      issues.push({ id: 'loudOk', level: 'ok', title: 'Volume is already at full level', text: 'The loudest notes reach ' + level.toFixed(1) + ' dB, so boosting cannot make it louder. To hear instruments louder, raise Options → Audio → MIDI (Instrument) Volume in SS14.' });
    }
    if (sysexInfo.count) {
      issues.push({
        id: 'sysex', level: 'info',
        title: sysexInfo.count + ' SysEx message' + (sysexInfo.count === 1 ? '' : 's'),
        text: 'SS14 ignores SysEx completely' + (sysexInfo.rhythm.length ? ', including GS “rhythm part” assignments' : '') + '. They stay in the file and do no harm.'
      });
    }
    var maxVel = 0, maxCC7 = 0;
    tl.forEach(function (r) {
      var e = r.e; if (e.kind !== 'ch') return;
      var hi = e.status & 0xf0;
      if (hi === 0x90 && e.d2 > maxVel) maxVel = e.d2;
      if (hi === 0xb0 && e.d1 === 7 && e.d2 > maxCC7) maxCC7 = e.d2;
    });

    return {
      format: smf.format, tracks: smf.tracks.length, division: smf.division,
      duration: clock.toSec(lastTick), channels: chs, trackInfo: trackInfo, ss14Labels: ss14Labels,
      sysex: sysexInfo, peak: peak, peakAt: peakAt, nrpnJunk: nrpnJunk, dupCount: dupCount,
      maxVel: maxVel, maxCC7: maxCC7, level: level, headroom: headroom, issues: issues, warnings: smf.warnings,
      drumChannels: chs.filter(function (c) { return c.isDrumIntended; }).map(function (c) { return c.ch; })
    };
  }
  function uniq(v, i, a) { return a.indexOf(v) === i; }
  function fmtTime(s) { var m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + (r < 10 ? '0' : '') + r; }

  function isDedupCC(cc) {
    // never touch bank, data entry, (N)RPN or channel mode messages
    if (cc === 0 || cc === 32 || cc === 6 || cc === 38) return false;
    if (cc >= 96 && cc <= 101) return false;
    if (cc >= 120) return false;
    return true;
  }
  function isStreamCC(cc) {
    // continuous controllers where in-between values may go
    if (!isDedupCC(cc)) return false;
    if (cc >= 64 && cc <= 69) return false; // pedals/switches
    return true;
  }

  // ---------------------------------------------------------------- volume
  // Level of every note in dB below full scale. FluidSynth's default modulators turn velocity,
  // CC7 and CC11 into attenuation along the concave curve, roughly 40·log10(value/127) each.
  var LOUD_PCT = 0.98; // the loudest 2 % of notes may clip at velocity 127
  function db(v) { return v <= 0 ? -96 : 40 * Math.log10(v / 127); }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  }
  function noteLevels(smf) {
    var cc7 = new Array(16).fill(100), cc11 = new Array(16).fill(127), out = [];
    timeline(smf).forEach(function (r) {
      var e = r.e; if (e.kind !== 'ch') return;
      var hi = e.status & 0xf0;
      if (hi === 0xb0) {
        if (e.d1 === 7) cc7[e.ch] = e.d2;
        else if (e.d1 === 11) cc11[e.ch] = e.d2;
        else if (e.d1 === 121) cc11[e.ch] = 127; // reset all controllers
        return;
      }
      if (hi === 0x90 && e.d2 > 0) out.push({ ch: e.ch, cc7: cc7[e.ch], cc11: cc11[e.ch], db: db(e.d2) + db(cc7[e.ch]) + db(cc11[e.ch]) });
    });
    return out;
  }

  // ---------------------------------------------------------------- repair
  function repair(smf, ps, opts) {
    var out = cloneSmf(smf);
    var log = [];
    var moved = opts.move || [];

    // 1) move drums from other channels to channel 10
    moved.forEach(function (ch) {
      var n = 0;
      out.tracks.forEach(function (tr) {
        tr.events.forEach(function (e) {
          if (e.kind === 'ch' && e.ch === ch) { e.ch = DRUM_CH; e.status = (e.status & 0xf0) | DRUM_CH; n++; }
        });
      });
      log.push('Moved channel ' + (ch + 1) + ' to channel 10 (' + n + ' events)');
    });

    // 2) replace bank selects on channel 10
    if (opts.drumBank || moved.length) {
      var removed = 0;
      out.tracks.forEach(function (tr) {
        tr.events.forEach(function (e) {
          if (e.kind === 'ch' && e.ch === DRUM_CH && (e.status & 0xf0) === 0xb0 && (e.d1 === 0 || e.d1 === 32)) { e.deleted = true; removed++; }
        });
      });
      var tl = timeline(out);
      var first = null, firstNoteIdx = -1, pcBefore = null;
      for (var i = 0; i < tl.length; i++) {
        var e = tl[i].e;
        if (e.kind !== 'ch' || e.ch !== DRUM_CH) continue;
        if (!first) first = tl[i];
        var hi = e.status & 0xf0;
        if (hi === 0xc0 && !pcBefore) pcBefore = e;
        if (hi === 0x90 && e.d2 > 0) { firstNoteIdx = i; break; }
      }
      if (first) {
        var tr = out.tracks[first.t];
        var pos = 0;
        while (pos < tr.events.length) {
          var ev = tr.events[pos];
          if (ev.tick > 0 || ev === first.e || (ev.kind === 'ch' && ev.ch === DRUM_CH)) break;
          pos++;
        }
        var ins = [{ tick: 0, kind: 'ch', status: 0xb0 | DRUM_CH, ch: DRUM_CH, d1: 0, d2: SS14_DRUM_BANK, added: true }];
        if (!pcBefore) ins.push({ tick: 0, kind: 'ch', status: 0xc0 | DRUM_CH, ch: DRUM_CH, d1: 0, d2: 0, added: true });
        Array.prototype.splice.apply(tr.events, [pos, 0].concat(ins));
        log.push('Channel 10: ' + (removed ? 'removed ' + removed + ' bank select' + (removed === 1 ? '' : 's') + ' (CC0/CC32), ' : '') +
          'set bank ' + SS14_DRUM_BANK + (pcBefore ? '' : ' and kit 0') + ' at the start');
      }
    }

    // 3) replace missing kits
    if (opts.kitMap) {
      var maps = {};
      out.tracks.forEach(function (tr) {
        tr.events.forEach(function (e) {
          if (e.kind === 'ch' && e.ch === DRUM_CH && (e.status & 0xf0) === 0xc0 && !e.deleted) {
            var m = mapKit(ps, e.d1);
            if (m !== e.d1) { maps[e.d1] = m; e.d1 = m; }
          }
        });
      });
      Object.keys(maps).forEach(function (k) { log.push('Drum kit ' + k + ' (' + (GS_KITS[k] || '?') + ') → ' + maps[k] + ' (' + kitLabel(ps, maps[k]) + ')'); });
    }

    // 4) thin out
    if (opts.thin) {
      var clock = buildClock(out);
      var tl2 = timeline(out);
      var nrpnMsb = new Array(16).fill(-1), nrpnOn = new Array(16).fill(false);
      var cnt = { nrpn: 0, dup: 0, stream: 0 };
      var state = [];
      for (var c = 0; c < 16; c++) state.push({ cc: new Int16Array(128).fill(-1), pb: -1, cp: -1 });
      var streams = new Map(); // key -> [{e, s}]
      var noteTimes = [];
      for (var c2 = 0; c2 < 16; c2++) noteTimes.push([]);
      tl2.forEach(function (r) {
        var e = r.e;
        if (e.kind !== 'ch') return;
        var ch = e.ch, hi = e.status & 0xf0, st = state[ch];
        if (hi === 0x90 && e.d2 > 0) { noteTimes[ch].push(clock.toSec(e.tick)); return; }
        if (hi === 0xb0) {
          var cc = e.d1, v = e.d2;
          if (cc === 99) {
            nrpnMsb[ch] = v; nrpnOn[ch] = true;
            if (v !== 120 && v !== 127) { e.deleted = true; cnt.nrpn++; }
            return;
          }
          if (cc === 101 || cc === 100) { nrpnOn[ch] = false; return; }
          if (nrpnOn[ch] && nrpnMsb[ch] !== 120 && nrpnMsb[ch] !== 127 && (cc === 98 || cc === 6 || cc === 38 || cc === 96 || cc === 97)) {
            e.deleted = true; cnt.nrpn++; return;
          }
          if (isDedupCC(cc)) {
            if (st.cc[cc] === v) { e.deleted = true; cnt.dup++; return; }
            st.cc[cc] = v;
            if (isStreamCC(cc)) addStream(streams, ch + ':c' + cc, e, clock);
          }
          return;
        }
        if (hi === 0xe0) {
          var pb = e.d1 | (e.d2 << 7);
          if (st.pb === pb) { e.deleted = true; cnt.dup++; return; }
          st.pb = pb; addStream(streams, ch + ':pb', e, clock); return;
        }
        if (hi === 0xd0) {
          if (st.cp === e.d1) { e.deleted = true; cnt.dup++; return; }
          st.cp = e.d1; addStream(streams, ch + ':cp', e, clock); return;
        }
        if (hi === 0xa0) addStream(streams, ch + ':kp' + e.d1, e, clock);
      });
      streams.forEach(function (list, key) {
        var ch = parseInt(key, 10), nt = noteTimes[ch], np = 0;
        var lastKept = -1e9;
        for (var i = 0; i < list.length; i++) {
          var cur = list[i], next = list[i + 1];
          var keep = i === 0 || !next || (next.s - cur.s >= THIN_GAP) || (cur.s - lastKept >= THIN_GAP);
          if (!keep && next) {
            // always keep the value that is in effect when a note starts
            while (np < nt.length && nt[np] < cur.s) np++;
            if (np < nt.length && nt[np] >= cur.s && nt[np] < next.s) keep = true;
          }
          if (keep) lastKept = cur.s; else { cur.e.deleted = true; cnt.stream++; }
        }
      });
      log.push('Thinned out ' + cnt.nrpn + ' NRPN messages SS14 ignores, ' + cnt.dup + ' repeated values and ' + cnt.stream + ' in-between controller values');
    }

    // 5) boost volume
    if (opts.loud) {
      // loudTarget: a level in dB for the loudest notes (0 = full), or 'half' to close half the gap
      var before = noteLevels(out);
      if (before.length) {
        var lvl0 = percentile(before.map(function (l) { return l.db; }), LOUD_PCT);
        var target = opts.loudTarget === 'half' ? lvl0 / 2 : (typeof opts.loudTarget === 'number' ? opts.loudTarget : 0);
        var wanted = Math.max(0, target - lvl0);
        // Channel level = CC7 + CC11 in dB. Raise every channel by the same amount B, so the
        // loudest channel lands on full CC7 and CC11. CC7 takes the boost first, CC11 the rest.
        var G = new Array(16).fill(-1e9), m7 = new Array(16).fill(0), m11 = new Array(16).fill(0);
        before.forEach(function (l) {
          var g = db(l.cc7) + db(l.cc11);
          if (g > G[l.ch]) G[l.ch] = g;
          if (l.cc7 > m7[l.ch]) m7[l.ch] = l.cc7;
          if (l.cc11 > m11[l.ch]) m11[l.ch] = l.cc11;
        });
        var B = Math.min(-Math.max.apply(null, G), wanted); // never raise past the target
        var f7 = new Array(16).fill(1), f11 = new Array(16).fill(1);
        for (var c7 = 0; c7 < 16; c7++) {
          if (G[c7] < -1e8 || B <= 0.05) continue;
          f7[c7] = Math.min(Math.pow(10, B / 40), 127 / m7[c7]);
          var rest = B - 40 * Math.log10(f7[c7]);
          if (rest > 0.05) f11[c7] = Math.min(Math.pow(10, rest / 40), 127 / m11[c7]);
        }
        var any7 = f7.some(function (f) { return f > 1.001; }), any11 = f11.some(function (f) { return f > 1.001; });
        out.tracks.forEach(function (tr) {
          tr.events.forEach(function (e) {
            if (e.kind !== 'ch' || e.deleted || (e.status & 0xf0) !== 0xb0) return;
            if (e.d1 === 7 && f7[e.ch] > 1.001) e.d2 = Math.min(127, Math.round(e.d2 * f7[e.ch]));
            if (e.d1 === 11 && f11[e.ch] > 1.001) e.d2 = Math.min(127, Math.round(e.d2 * f11[e.ch]));
          });
        });
        // channels that play before any CC7 run at FluidSynth's default 100: give them an explicit value
        var tl3 = timeline(out), seen7 = new Array(16).fill(false), done = new Array(16).fill(false), firstEv = new Array(16).fill(null);
        tl3.forEach(function (r) {
          var e = r.e; if (e.kind !== 'ch') return;
          if (!firstEv[e.ch]) firstEv[e.ch] = r;
          if ((e.status & 0xf0) === 0xb0 && e.d1 === 7) seen7[e.ch] = true;
          if ((e.status & 0xf0) === 0x90 && e.d2 > 0 && !seen7[e.ch] && !done[e.ch]) {
            done[e.ch] = true;
            if (f7[e.ch] <= 1.001) return;
            var f = firstEv[e.ch], evs = out.tracks[f.t].events, at = evs.indexOf(f.e);
            evs.splice(at, 0, { tick: f.e.tick, kind: 'ch', status: 0xb0 | e.ch, ch: e.ch, d1: 7, d2: Math.min(127, Math.round(100 * f7[e.ch])), added: true });
          }
        });
        // then velocity, so the loudest notes land on the target
        var mid = noteLevels(out);
        var gain = target - percentile(mid.map(function (l) { return l.db; }), LOUD_PCT);
        var kv = gain > 0.05 ? Math.pow(10, gain / 40) : 1;
        if (kv > 1) {
          out.tracks.forEach(function (tr) {
            tr.events.forEach(function (e) {
              if (e.kind === 'ch' && !e.deleted && (e.status & 0xf0) === 0x90 && e.d2 > 0) e.d2 = Math.max(1, Math.min(127, Math.round(e.d2 * kv)));
            });
          });
        }
        var lvl1 = percentile(noteLevels(out).map(function (l) { return l.db; }), LOUD_PCT);
        var parts = [];
        if (any7) parts.push('channel volume');
        if (any11) parts.push('expression');
        if (kv > 1) parts.push('velocity ×' + kv.toFixed(2));
        if (lvl1 - lvl0 > 0.05) log.push('Boosted volume by ' + (lvl1 - lvl0).toFixed(1) + ' dB' + (parts.length ? ' (' + parts.join(', ') + ')' : ''));
      }
    }

    return { smf: out, bytes: writeMidi(out), log: log };
  }
  function addStream(map, key, e, clock) {
    var l = map.get(key); if (!l) { l = []; map.set(key, l); }
    l.push({ e: e, s: clock.toSec(e.tick) });
  }

  // ---------------------------------------------------------------- ZIP (stored, no compression)
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { var c = 0xffffffff; for (var i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function makeZip(files) {
    var enc = new TextEncoder(), chunks = [], central = [], offset = 0;
    var d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var used = {};
    files.forEach(function (f) {
      var nm = f.name, n = 2;
      while (used[nm]) nm = f.name.replace(/(\.[^.]*)?$/, '_' + (n++) + '$1');
      used[nm] = true;
      var name = enc.encode(nm), data = u8(f.data), crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, tm, true); lh.setUint16(12, dt, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, tm, true); ch.setUint16(14, dt, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    var all = chunks.concat(central, [new Uint8Array(eo.buffer)]);
    var total = all.reduce(function (s, x) { return s + x.length; }, 0);
    var out = new Uint8Array(total), o = 0;
    all.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }

  // ---------------------------------------------------------------- preview (js-synthesizer)
  // The synth must be created with midiBankSelect:'gm', like RobustToolbox's MidiManager.
  // cfg: {mode:'ss14'|'intended', drumChannels:[...], muted:[16 bool], stale:bool}
  function preparePreview(synth, cfg) {
    synth.midiSystemReset();
    for (var c = 0; c < 16; c++) {
      var drum = cfg.mode === 'ss14' ? c === DRUM_CH : cfg.drumChannels.indexOf(c) >= 0;
      synth.midiSetChannelType(c, drum);
      synth.midiBankSelect(c, drum ? 128 : 0);
      synth.midiProgramChange(c, 0);
    }
    if (cfg.mode === 'ss14' && cfg.stale) {
      // left over from a previous broken song: channel 10 sits on bank 0, piano
      synth.midiBankSelect(DRUM_CH, 0);
      synth.midiProgramChange(DRUM_CH, 0);
    }
  }
  function makeHook(cfg) {
    var drum = [];
    for (var c = 0; c < 16; c++) drum[c] = cfg.mode === 'ss14' ? c === DRUM_CH : cfg.drumChannels.indexOf(c) >= 0;
    return function (synth, type, ev) {
      var hi = type & 0xf0;
      if (hi < 0x80 || hi === 0xf0) return true;           // SysEx, text etc.: SS14 drops them
      var ch = ev.getChannel();
      if (hi === 0x90) return ev.getVelocity() > 0 && !!cfg.muted[ch]; // muted = drop the note (like FilteredChannels)
      if (hi === 0xb0) {
        var cc = ev.getControl();
        if (cfg.mode === 'ss14') {
          if (cc === 0) { synth.midiBankSelect(ch, ev.getValue()); return true; } // MidiRenderer: _synth.BankSelect, unconditionally
          return false;
        }
        if (cc === 0) { if (!drum[ch]) synth.midiBankSelect(ch, ev.getValue()); return true; }
        if (cc === 32) return true;
        return false;
      }
      if (hi === 0xc0 && cfg.mode !== 'ss14' && drum[ch]) synth.midiBankSelect(ch, 128);
      return false;
    };
  }

  var api = {
    preparePreview: preparePreview, makeHook: makeHook, noteLevels: noteLevels,
    DRUM_CH: DRUM_CH, SS14_DRUM_BANK: SS14_DRUM_BANK, EVENTS_PER_SEC: EVENTS_PER_SEC,
    parseMidi: parseMidi, writeMidi: writeMidi, analyze: analyze, repair: repair,
    PresetSet: PresetSet, sf2Presets: sf2Presets, resolvePreset: resolvePreset, presetLabel: presetLabel,
    kitLabel: kitLabel, mapKit: mapKit, makeZip: makeZip, crc32: crc32, fmtTime: fmtTime, timeline: timeline, buildClock: buildClock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MidiFix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
