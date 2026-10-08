'use strict';

/* ============================================================
 * 最小限のXLSX(Excel)ファイル生成ユーティリティ
 * 外部ライブラリを使わず、ZIP(格納/無圧縮)+ OOXML の最小構成で
 * 有効な.xlsxファイルをブラウザ上で直接生成する。
 * ============================================================ */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  constructor() {
    this.chunks = [];
  }
  u16(v) {
    this.chunks.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }
  u32(v) {
    this.chunks.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  }
  bytes(arr) {
    this.chunks.push(arr);
  }
  toUint8Array() {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/* files: [{ name: string, data: Uint8Array }] を無圧縮ZIPにまとめる */
function buildZip(files) {
  const encoder = new TextEncoder();
  const dosDateTime = { time: 0, date: 0x0021 }; // 1980-01-01固定
  const w = new ByteWriter();
  const centralEntries = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const localOffset = offset;

    const local = new ByteWriter();
    local.u32(0x04034b50);
    local.u16(20);
    local.u16(0);
    local.u16(0);
    local.u16(dosDateTime.time);
    local.u16(dosDateTime.date);
    local.u32(crc);
    local.u32(data.length);
    local.u32(data.length);
    local.u16(nameBytes.length);
    local.u16(0);
    local.bytes(nameBytes);
    local.bytes(data);
    const localBytes = local.toUint8Array();
    w.bytes(localBytes);
    offset += localBytes.length;

    centralEntries.push({ nameBytes, crc, size: data.length, localOffset });
  });

  const centralStart = offset;
  centralEntries.forEach((entry) => {
    const c = new ByteWriter();
    c.u32(0x02014b50);
    c.u16(20);
    c.u16(20);
    c.u16(0);
    c.u16(0);
    c.u16(dosDateTime.time);
    c.u16(dosDateTime.date);
    c.u32(entry.crc);
    c.u32(entry.size);
    c.u32(entry.size);
    c.u16(entry.nameBytes.length);
    c.u16(0);
    c.u16(0);
    c.u16(0);
    c.u16(0);
    c.u32(0);
    c.u32(entry.localOffset);
    c.bytes(entry.nameBytes);
    const cBytes = c.toUint8Array();
    w.bytes(cBytes);
    offset += cBytes.length;
  });
  const centralSize = offset - centralStart;

  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(centralEntries.length);
  end.u16(centralEntries.length);
  end.u32(centralSize);
  end.u32(centralStart);
  end.u16(0);
  w.bytes(end.toUint8Array());

  return w.toUint8Array();
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* rows: 2次元配列。各セルは文字列 or 数値 */
function buildSheetXml(rows) {
  const rowsXml = rows
    .map((row, rIdx) => {
      const r = rIdx + 1;
      const cellsXml = row
        .map((val, cIdx) => {
          const ref = colLetter(cIdx) + r;
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          const text = val === null || val === undefined ? '' : String(val);
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cellsXml}</row>`;
    })
    .join('');

  const maxCols = rows.reduce((m, row) => Math.max(m, row.length), 0);
  const dimension = `A1:${colLetter(Math.max(maxCols - 1, 0))}${Math.max(rows.length, 1)}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dimension}"/>
<sheetData>${rowsXml}</sheetData>
</worksheet>`;
}

function buildWorkbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function buildContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildWorkbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="10"/><name val="Arial"/></font>
<font><sz val="10"/><name val="Arial"/><b/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;
}

/* sheetName: シート名, headerRow: string[], dataRows: (string|number)[][] を渡すと .xlsx のバイト列(Uint8Array)を返す */
function buildXlsxFile(sheetName, headerRow, dataRows) {
  const encoder = new TextEncoder();
  const allRows = [headerRow, ...dataRows];
  const files = [
    { name: '[Content_Types].xml', data: encoder.encode(buildContentTypesXml()) },
    { name: '_rels/.rels', data: encoder.encode(buildRootRelsXml()) },
    { name: 'xl/workbook.xml', data: encoder.encode(buildWorkbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(buildWorkbookRelsXml()) },
    { name: 'xl/styles.xml', data: encoder.encode(buildStylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(buildSheetXml(allRows)) },
  ];
  return buildZip(files);
}

function downloadBytes(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // すぐに解放するとブラウザによってはファイル名が失われるため、少し待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
