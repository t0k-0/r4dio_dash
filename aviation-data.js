(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AviationData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RAD_TO_DEG = 180 / Math.PI;
  const M_TO_FT = 3.280839895;
  const EARTH_M = 6371008.8;

  const STYLE_NAMES = {
    0x00: 'UNKNOWN', 0x01: 'CTR', 0x02: 'R', 0x03: 'P', 0x04: 'D',
    0x05: 'TRA', 0x06: 'TMA', 0x07: 'TIZ', 0x08: 'AWY', 0x09: 'CTA',
    0x0a: 'GLIDER', 0x0b: 'TMZ', 0x0c: 'MATZ', 0x0d: 'RMZ', 0x0f: 'NOTAM',
    0x80: 'ADVISORY', 0x81: 'ADIZ', 0x82: 'FIR', 0x83: 'FIR DELEGATED',
    0x84: 'TIA', 0x85: 'SRZ', 0x86: 'TFR', 0x87: 'ATZ', 0x88: 'FISA',
    0x89: 'RMZ', 0x8a: 'ASRA', 0x8b: 'TRZ', 0x8c: 'VFR ROUTE',
    0x8d: 'ALERT', 0x8e: 'TSA', 0x8f: 'WARNING'
  };
  const EXTENDED_STYLE_NAMES = {
    1: 'UIR', 2: 'MTR', 3: 'HTZ', 4: 'ACC SECTOR', 5: 'LTA',
    6: 'UTA', 7: 'MTA', 8: 'OFR', 9: 'TRA/TSA ROUTE', 10: 'VFR SECTOR'
  };
  const CLASS_NAMES = ['-', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const ALT_REFS = ['UNKNOWN', 'AGL', 'AMSL', 'FL', 'UNL', 'NOTAM'];

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) {
      let out = '';
      for (const byte of bytes) out += String.fromCharCode(byte);
      return out;
    }
  }

  function parseCsvLine(line) {
    const values = [];
    let value = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        values.push(value.trim()); value = '';
      } else value += ch;
    }
    values.push(value.trim());
    return values;
  }

  function parseCupCoordinate(value, isLatitude) {
    const match = String(value || '').trim().match(/^(\d{2,3})(\d{2})\.(\d+)([NSEW])$/i);
    if (!match) return NaN;
    const degrees = Number(match[1]);
    const minutes = Number(match[2] + '.' + match[3]);
    const sign = /[SW]/i.test(match[4]) ? -1 : 1;
    const result = sign * (degrees + minutes / 60);
    if ((isLatitude && Math.abs(result) > 90) || (!isLatitude && Math.abs(result) > 180)) return NaN;
    return result;
  }

  function parseMetric(value) {
    const match = String(value || '').trim().match(/^(-?[\d.]+)\s*(m|ft)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    return match[2] && match[2].toLowerCase() === 'ft' ? amount / M_TO_FT : amount;
  }

  function parseCup(text) {
    const clean = String(text || '').replace(/^\uFEFF/, '');
    const lines = clean.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return [];
    const header = parseCsvLine(lines[0]).map(value => value.toLowerCase());
    const at = name => header.indexOf(name);
    return lines.slice(1).map((line, index) => {
      const row = parseCsvLine(line);
      const lat = parseCupCoordinate(row[at('lat')], true);
      const lon = parseCupCoordinate(row[at('lon')], false);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const code = row[at('code')] || '';
      const runwayDirectionRaw = String(row[at('rwdir')] || '').trim();
      const runwayDirectionValue = runwayDirectionRaw === '' ? null : Number(runwayDirectionRaw);
      return {
        id: code || `WPT-${index + 1}`,
        name: row[at('name')] || code || `Waypoint ${index + 1}`,
        code,
        country: row[at('country')] || '',
        lat, lon,
        elevationM: parseMetric(row[at('elev')]) || 0,
        style: Number(row[at('style')]) || 0,
        runwayDirection: Number.isFinite(runwayDirectionValue) ? ((runwayDirectionValue % 360) + 360) % 360 : null,
        runwayLengthM: parseMetric(row[at('rwlen')]),
        frequency: row[at('freq')] || '',
        description: row[at('desc')] || ''
      };
    }).filter(Boolean);
  }

  function readString(view, start, length) {
    return decodeText(new Uint8Array(view.buffer, view.byteOffset + start, length)).replace(/\0+$/g, '').trim();
  }

  function decodeActiveTime(view, offset, littleEndian) {
    if (typeof view.getBigUint64 !== 'function') return { dayFlags: 0, start: 0, end: 0x3ffffff };
    const value = view.getBigUint64(offset, littleEndian);
    return {
      dayFlags: Number((value >> 52n) & 0xfffn),
      start: Number((value >> 26n) & 0x3ffffffn),
      end: Number(value & 0x3ffffffn)
    };
  }

  function parseCub(input) {
    const buffer = input instanceof ArrayBuffer
      ? input
      : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    const view = new DataView(buffer);
    if (view.byteLength < 210 || view.getUint32(0, true) !== 0x425543c2) {
      throw new Error('Not a valid SeeYou CUB airspace file.');
    }
    const littleEndian = view.getUint8(132) !== 0;
    if (view.getUint8(133) !== 0) throw new Error('Encrypted CUB files are not supported.');
    let cursor = 154;
    const sizeOfItem = view.getInt32(cursor, littleEndian); cursor += 4;
    const sizeOfPoint = view.getInt32(cursor, littleEndian); cursor += 4;
    const itemCount = view.getInt32(cursor, littleEndian); cursor += 4;
    const maxPoints = view.getInt32(cursor, littleEndian); cursor += 4;
    const bounds = {
      left: view.getFloat32(cursor, littleEndian) * RAD_TO_DEG,
      top: view.getFloat32(cursor + 4, littleEndian) * RAD_TO_DEG,
      right: view.getFloat32(cursor + 8, littleEndian) * RAD_TO_DEG,
      bottom: view.getFloat32(cursor + 12, littleEndian) * RAD_TO_DEG
    };
    cursor += 24;
    const coordinateScale = view.getFloat32(cursor, littleEndian); cursor += 4;
    const headerOffset = view.getInt32(cursor, littleEndian); cursor += 4;
    const dataOffset = view.getInt32(cursor, littleEndian);
    if (sizeOfItem < 22 || sizeOfPoint < 5 || itemCount < 0 || headerOffset < 0 || dataOffset < 0) {
      throw new Error('Invalid CUB header values.');
    }

    const rawItems = [];
    for (let index = 0; index < itemCount; index++) {
      const base = headerOffset + index * sizeOfItem;
      if (base + Math.min(sizeOfItem, 43) > view.byteLength) break;
      const left = view.getFloat32(base, littleEndian);
      const top = view.getFloat32(base + 4, littleEndian);
      const right = view.getFloat32(base + 8, littleEndian);
      const bottom = view.getFloat32(base + 12, littleEndian);
      const packedType = view.getUint8(base + 16);
      const altStyle = view.getUint8(base + 17);
      const minM = view.getInt16(base + 18, littleEndian);
      const maxM = view.getInt16(base + 20, littleEndian);
      const pointsOffset = sizeOfItem >= 26 ? view.getInt32(base + 22, littleEndian) : 0;
      const active = sizeOfItem >= 42 ? decodeActiveTime(view, base + 34, littleEndian) : { dayFlags: 0 };
      const extendedType = sizeOfItem >= 43 ? view.getUint8(base + 42) : 0;
      const styleCode = (packedType & 0x80) | (packedType & 0x0f);
      rawItems.push({
        index, left, top, right, bottom, packedType, altStyle, minM, maxM,
        pointsOffset, active, extendedType, styleCode
      });
    }

    const airspaces = rawItems.map((item, itemIndex) => {
      let originLon = item.left, originLat = item.bottom;
      let position = dataOffset + item.pointsOffset;
      const nextOffset = itemIndex + 1 < rawItems.length
        ? dataOffset + rawItems[itemIndex + 1].pointsOffset
        : view.byteLength;
      const end = Math.max(position, Math.min(nextOffset, view.byteLength));
      const points = [];
      let name = '', frequency = '', frequencyName = '', icao = '', remarks = '';
      while (position + sizeOfPoint <= end) {
        const flag = view.getUint8(position);
        if (flag === 0x01 || flag === 0x81) {
          const x = view.getInt16(position + 1, littleEndian) * coordinateScale;
          const y = view.getInt16(position + 3, littleEndian) * coordinateScale;
          if (flag === 0x81) { originLon += x; originLat += y; }
          else points.push({ lat: (originLat + y) * RAD_TO_DEG, lon: (originLon + x) * RAD_TO_DEG });
          position += sizeOfPoint;
          continue;
        }
        if ((flag & 0xc0) === 0x40) {
          const length = flag & 0x3f;
          const stringStart = position + sizeOfPoint;
          if (stringStart + length > end) break;
          name = readString(view, stringStart, length);
          position = stringStart + length;
          continue;
        }
        if ((flag & 0xc0) === 0xc0) {
          const length = flag & 0x3f;
          const rawFrequency = view.getUint32(position + 1, littleEndian);
          const stringStart = position + sizeOfPoint;
          if (stringStart + length > end) break;
          frequency = rawFrequency ? (rawFrequency / 1000).toFixed(3) : '';
          frequencyName = readString(view, stringStart, length);
          position = stringStart + length;
          continue;
        }
        if (flag === 0xa0) {
          const dataId = view.getUint8(position + 1);
          const b1 = view.getUint8(position + 2), b2 = view.getUint8(position + 3), b3 = view.getUint8(position + 4);
          let payloadLength = 0, extraLength = 0;
          if (dataId === 0 || dataId === 4) payloadLength = b3;
          if (dataId === 2 || dataId === 3) payloadLength = (b2 << 8) + b3;
          if (dataId === 5) extraLength = 1;
          const payloadStart = position + sizeOfPoint + extraLength;
          if (payloadStart + payloadLength > end) break;
          if (dataId === 0) icao = readString(view, payloadStart, payloadLength);
          if (dataId === 3) remarks = readString(view, payloadStart, payloadLength);
          if (dataId === 1) frequency = (((b1 << 16) + (b2 << 8) + b3) / 1000).toFixed(3);
          position = payloadStart + payloadLength;
          continue;
        }
        position += sizeOfPoint;
      }
      const minRefCode = item.altStyle & 0x0f;
      const maxRefCode = (item.altStyle >> 4) & 0x0f;
      let type = item.extendedType
        ? (EXTENDED_STYLE_NAMES[item.extendedType] || `TYPE ${item.extendedType}`)
        : (STYLE_NAMES[item.styleCode] || `TYPE ${item.styleCode}`);
      if (/^TRA GA\b/i.test(name)) type = 'TRA GA';
      else if (/^LKTSA\w*\b/i.test(name)) type = 'TSA';
      else if (/^LKTRA\w*\b/i.test(name)) type = 'TRA';
      else if (/^(?:LK)?M?TMA\b/i.test(name)) type = 'TMA';
      else if (/^(?:LK)?M?CTR\b/i.test(name)) type = 'CTR';
      return {
        id: `CUB-${item.index}`,
        name: name || `${type} ${item.index + 1}`,
        type,
        className: CLASS_NAMES[(item.packedType >> 4) & 0x07] || '-',
        // CUB stores integer metres; published Czech limits are normally whole hundreds of feet.
        minFt: Math.max(0, Math.round(item.minM * M_TO_FT / 100) * 100),
        maxFt: maxRefCode === 4 ? 60000 : Math.max(0, Math.round(item.maxM * M_TO_FT / 100) * 100),
        minRef: ALT_REFS[minRefCode] || 'UNKNOWN',
        maxRef: ALT_REFS[maxRefCode] || 'UNKNOWN',
        points,
        bounds: {
          left: item.left * RAD_TO_DEG, top: item.top * RAD_TO_DEG,
          right: item.right * RAD_TO_DEG, bottom: item.bottom * RAD_TO_DEG
        },
        frequency, frequencyName, icao, remarks,
        activation: item.active,
        flexible: type === 'TRA GA' || type === 'TRA' || type === 'TSA' || type === 'TFR' || type === 'NOTAM'
      };
    }).filter(area => area.points.length >= 3);

    return { title: readString(view, 4, 112), bounds, sizeOfItem, sizeOfPoint, itemCount, maxPoints, airspaces };
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function distanceToBoundsMeters(lat, lon, bounds) {
    const closestLat = Math.max(bounds.bottom, Math.min(bounds.top, lat));
    const closestLon = Math.max(bounds.left, Math.min(bounds.right, lon));
    return distanceMeters(lat, lon, closestLat, closestLon);
  }

  function geoToLocal(lat, lon, originLat, originLon) {
    const latRad = originLat * Math.PI / 180;
    return {
      x: (lon - originLon) * Math.PI / 180 * EARTH_M * Math.cos(latRad),
      y: (lat - originLat) * Math.PI / 180 * EARTH_M
    };
  }

  function formatAltitude(ft, reference) {
    if (reference === 'UNL') return 'UNL';
    if (!ft && (reference === 'AGL' || reference === 'AMSL' || reference === 'UNKNOWN')) return 'GND';
    if (reference === 'FL') return `FL${Math.round(ft / 100).toString().padStart(3, '0')}`;
    return `${Math.round(ft)} ft ${reference === 'UNKNOWN' ? '' : reference}`.trim();
  }

  return {
    parseCup, parseCub, parseCupCoordinate, geoToLocal, distanceMeters,
    distanceToBoundsMeters, formatAltitude, STYLE_NAMES, ALT_REFS
  };
});
