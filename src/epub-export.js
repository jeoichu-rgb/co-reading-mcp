import { deflateRawSync } from "node:zlib";
import crypto from "node:crypto";

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const store = entry.store === true;
    const compressed = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, eocd]);
}

const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function buildEpub({ title, author, chapters, annotations, coverData, coverExt }) {
  const uid = `urn:uuid:${crypto.randomUUID()}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const style = `body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Songti SC",Georgia,serif;line-height:1.85;color:#333;margin:1em 1.5em}
h1,h2{text-align:center;margin:2em 0 1em;color:#222}h1{font-size:1.6em}h2{font-size:1.3em}
p{text-indent:0;margin:.6em 0}
.ann{background:#faf5f0;border-left:3px solid #d9795c;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:.88em;line-height:1.6}
.ann-quote{font-style:italic;color:#8a8883;margin:0 0 6px;padding:6px 0;border-bottom:1px solid #eee}
.ann-author{font-weight:700;color:#6b5b4b}
.ann-reply{margin:6px 0 0;padding-left:16px;color:#555;font-size:.95em}
.ann-reply::before{content:"\\2191  ";color:#aaa}`;

  const entries = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: "OEBPS/style.css", data: style },
  ];

  let coverManifest = "";
  let coverSpine = "";
  let coverMeta = "";
  if (coverData && coverExt) {
    const ext = coverExt.replace(/^\./, "");
    const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
    entries.push({ name: `OEBPS/images/cover.${ext}`, data: coverData, store: true });
    entries.push({
      name: "OEBPS/cover.xhtml",
      data: `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>Cover</title><style>body{margin:0;text-align:center}img{max-width:100%;max-height:100vh}</style></head><body><img src="images/cover.${ext}" alt="Cover"/></body></html>`,
    });
    coverManifest = `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n<item id="cover-image" href="images/cover.${ext}" media-type="${mime}" properties="cover-image"/>`;
    coverSpine = `<itemref idref="cover"/>`;
    coverMeta = `<meta name="cover" content="cover-image"/>`;
  }

  let chapterManifest = "";
  let chapterSpine = "";
  let navItems = "";

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chunkAnnotations = annotations
      .filter((a) => a.chunkId === ch.id && !a.parentId)
      .sort((a, b) => (a.quoteOffset ?? Infinity) - (b.quoteOffset ?? Infinity));

    let body = `<h2>${esc(ch.title)}</h2>\n`;
    const text = ch.text || "";
    for (const para of text.split(/\n\n+/)) {
      const trimmed = para.trim();
      if (trimmed) body += `<p>${esc(trimmed).replace(/\n/g, "<br/>")}</p>\n`;
    }

    if (chunkAnnotations.length) {
      body += `<hr style="margin:1.5em 0;border:none;border-top:1px solid #ddd"/>\n`;
      for (const ann of chunkAnnotations) {
        body += `<div class="ann">`;
        if (ann.quote) body += `<div class="ann-quote">"${esc(ann.quote)}"</div>`;
        body += `<span class="ann-author">${esc(ann.author)}</span>: ${esc(ann.note)}`;
        const replies = annotations
          .filter((a) => a.parentId === ann.id)
          .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
        for (const reply of replies) {
          body += `<div class="ann-reply"><span class="ann-author">${esc(reply.author)}</span>: ${esc(reply.note)}</div>`;
        }
        body += `</div>\n`;
      }
    }

    const fname = `ch${String(i).padStart(3, "0")}.xhtml`;
    entries.push({
      name: `OEBPS/${fname}`,
      data: `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><meta charset="utf-8"/><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`,
    });
    chapterManifest += `<item id="ch${i}" href="${fname}" media-type="application/xhtml+xml"/>\n`;
    chapterSpine += `<itemref idref="ch${i}"/>\n`;
    navItems += `<li><a href="${fname}">${esc(ch.title)}</a></li>\n`;
  }

  entries.push({
    name: "OEBPS/content.opf",
    data: `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:identifier id="uid">${uid}</dc:identifier>\n<dc:title>${esc(title)}</dc:title>\n${author ? `<dc:creator>${esc(author)}</dc:creator>\n` : ""}<dc:language>zh</dc:language>\n<meta property="dcterms:modified">${now}</meta>\n${coverMeta}\n</metadata>\n<manifest>\n<item id="css" href="style.css" media-type="text/css"/>\n<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n${coverManifest}\n${chapterManifest}</manifest>\n<spine>\n${coverSpine}\n${chapterSpine}</spine>\n</package>`,
  });

  entries.push({
    name: "OEBPS/toc.xhtml",
    data: `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><nav epub:type="toc"><h1>目录</h1><ol>\n${navItems}</ol></nav></body></html>`,
  });

  return buildZip(entries);
}
