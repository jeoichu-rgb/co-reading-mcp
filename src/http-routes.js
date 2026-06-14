import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotatePassage,
  collectCard,
  continueReading,
  dataDir,
  deleteBook,
  dismissCard,
  getProgress,
  listCardInbox,
  listCardCollection,
  listCards,
  listAnnotations,
  listBooks,
  listChunks,
  loadManifest,
  markRead,
  readCard,
  readChunk,
  replyToAnnotation,
  searchChunks,
  submitUserNotes,
} from "./store.js";
import { importBook } from "./importer.js";
import { renderCardPng, renderCardSvg } from "./card-renderer.js";
import { buildEpub } from "./epub-export.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(ROOT, "public");
const defaultMaxBodyBytes = Number(process.env.READING_HTTP_MAX_BODY_BYTES || process.env.READING_IMPORT_MAX_BYTES || 25_000_000);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

export async function readBody(req, { maxBytes = defaultMaxBodyBytes, allowEmpty = true } = {}) {
  const contentType = req.headers["content-type"] || "";
  if (contentType && !contentType.includes("application/json")) {
    const err = new Error("Content-Type must be application/json");
    err.statusCode = 415;
    throw err;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) {
    if (allowEmpty) return {};
    throw new Error("Missing JSON body");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function routeParts(url) {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

export async function handleApi(req, res, url, options = {}) {
  const parts = routeParts(url);
  const maxBytes = options.maxBodyBytes || defaultMaxBodyBytes;

  if (req.method === "GET" && parts.length === 2 && parts[1] === "books") {
    return sendJson(res, 200, await listBooks({ includePrivate: true }));
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "books" && parts[3] === "chunks") {
    return sendJson(res, 200, await listChunks(parts[2], { includePrivate: true }));
  }

  if (req.method === "DELETE" && parts.length === 3 && parts[1] === "books") {
    return sendJson(res, 200, await deleteBook(parts[2]));
  }

  if (req.method === "GET" && parts.length === 5 && parts[1] === "books" && parts[3] === "chunks") {
    return sendJson(res, 200, await readChunk(parts[2], parts[4]));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "continue") {
    return sendJson(res, 200, await continueReading({ bookId: url.searchParams.get("bookId") || undefined }));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "annotations") {
    return sendJson(
      res,
      200,
      await listAnnotations({
        bookId: url.searchParams.get("bookId") || undefined,
        chunkId: url.searchParams.get("chunkId") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        author: url.searchParams.get("author") || undefined,
        status: url.searchParams.get("status") || undefined,
        parentId: url.searchParams.has("parentId") ? url.searchParams.get("parentId") : undefined,
        includePrivate: true,
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "cards") {
    return sendJson(
      res,
      200,
      await listCards({
        bookId: url.searchParams.get("bookId") || undefined,
        chunkId: url.searchParams.get("chunkId") || undefined,
        source: url.searchParams.get("source") || undefined,
        limit: Number(url.searchParams.get("limit") || 20),
        offset: Number(url.searchParams.get("offset") || 0),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "card-collection") {
    return sendJson(
      res,
      200,
      await listCardCollection({
        bookId: url.searchParams.get("bookId") || undefined,
        limit: Number(url.searchParams.get("limit") || 12),
        offset: Number(url.searchParams.get("offset") || 0),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "card-inbox") {
    return sendJson(
      res,
      200,
      await listCardInbox({
        bookId: url.searchParams.get("bookId") || undefined,
        limit: Number(url.searchParams.get("limit") || 10),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "cards" && parts[3] === "image.svg") {
    const card = await readCard(parts[2]);
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
    res.end(renderCardSvg(card));
    return;
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "cards" && parts[3] === "image.png") {
    const card = await readCard(parts[2]);
    res.writeHead(200, { "content-type": "image/png" });
    res.end(renderCardPng(card));
    return;
  }

  if (req.method === "POST" && parts.length === 4 && parts[1] === "cards" && parts[3] === "dismiss") {
    return sendJson(res, 200, await dismissCard(parts[2]));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "cards") {
    const body = await readBody(req, { maxBytes });
    return sendJson(res, 201, await collectCard({ ...body, createdBy: body.createdBy || "human" }));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "annotations") {
    const body = await readBody(req, { maxBytes });
    return sendJson(
      res,
      201,
      await annotatePassage({
        ...body,
        author: body.author || "user",
        status: body.status || "open",
      }),
    );
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "replies") {
    const body = await readBody(req, { maxBytes });
    return sendJson(
      res,
      201,
      await replyToAnnotation({
        ...body,
        author: body.author || "user",
        kind: body.kind || "reply",
        status: body.status || "open",
      }),
    );
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "submit-notes") {
    return sendJson(res, 200, await submitUserNotes(await readBody(req, { maxBytes })));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "mark-read") {
    const body = await readBody(req, { maxBytes });
    return sendJson(res, 200, await markRead(body.bookId, body.chunkId));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "import") {
    return sendJson(res, 201, await importBook(await readBody(req, { maxBytes })));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "progress") {
    return sendJson(res, 200, await getProgress(url.searchParams.get("bookId") || undefined));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "search") {
    return sendJson(
      res,
      200,
      await searchChunks({
        bookId: url.searchParams.get("bookId") || undefined,
        query: url.searchParams.get("q") || "",
        limit: Number(url.searchParams.get("limit") || 10),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "books" && parts[3] === "cover") {
    const manifest = await loadManifest(parts[2]);
    if (!manifest.coverImage) return sendError(res, 404, "No cover image");
    const booksDir = path.join(dataDir, "books");
    const coverPath = path.resolve(booksDir, parts[2], manifest.coverImage);
    if (!coverPath.startsWith(path.resolve(booksDir))) return sendError(res, 403, "Forbidden");
    try {
      const data = await readFile(coverPath);
      const ext = path.extname(coverPath).toLowerCase();
      res.writeHead(200, {
        "content-type": contentTypes[ext] || "application/octet-stream",
        "cache-control": "public, max-age=86400",
      });
      res.end(data);
    } catch (error) {
      if (error.code === "ENOENT") return sendError(res, 404, "Cover not found");
      throw error;
    }
    return;
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "export") {
    const bookId = url.searchParams.get("bookId");
    if (!bookId) return sendError(res, 400, "bookId is required");
    const format = (url.searchParams.get("format") || "epub").toLowerCase();
    const chunks = await listChunks(bookId, { includePrivate: true });
    const allAnnotations = await listAnnotations({ bookId, includePrivate: true });
    const sorted = chunks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const chaptersWithText = [];
    let bookTitle = bookId;
    let bookAuthor = null;
    for (const chunk of sorted) {
      const data = await readChunk(bookId, chunk.id);
      if (!bookAuthor) { bookTitle = data.title || bookId; bookAuthor = data.author || null; }
      chaptersWithText.push({ ...chunk, text: data.text });
    }

    let coverData = null;
    let coverExt = null;
    try {
      const manifest = await loadManifest(bookId);
      if (manifest.coverImage) {
        const booksDir = path.join(dataDir, "books");
        const coverPath = path.resolve(booksDir, bookId, manifest.coverImage);
        if (coverPath.startsWith(path.resolve(booksDir))) {
          coverData = await readFile(coverPath);
          coverExt = path.extname(manifest.coverImage).toLowerCase().replace(".", "");
        }
      }
    } catch {}

    const safeName = (bookTitle || "export").replace(/[^\w一-鿿 -]/gu, "_");

    if (format === "epub") {
      const epub = buildEpub({
        title: bookTitle,
        author: bookAuthor,
        chapters: chaptersWithText,
        annotations: allAnnotations,
        coverData,
        coverExt,
      });
      res.writeHead(200, {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename="${encodeURIComponent(safeName)}.epub"`,
      });
      res.end(epub);
      return;
    }

    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let coverImg = "";
    if (coverData && coverExt) {
      const mime = coverExt === "png" ? "image/png" : coverExt === "gif" ? "image/gif" : "image/jpeg";
      coverImg = `<div class="cover"><img src="data:${mime};base64,${coverData.toString("base64")}" alt="Cover"></div>`;
    }

    let body = "";
    for (const chunk of chaptersWithText) {
      const text = esc(chunk.text).replace(/\n/g, "<br>");
      body += `<section class="chapter"><h2>${esc(chunk.title)}</h2><div class="text">${text}</div>`;
      const roots = allAnnotations
        .filter((a) => a.chunkId === chunk.id && !a.parentId)
        .sort((a, b) => (a.quoteOffset ?? Infinity) - (b.quoteOffset ?? Infinity));
      if (roots.length) {
        body += `<div class="annotations"><h3>批注</h3>`;
        for (const ann of roots) {
          body += `<div class="ann">`;
          if (ann.quote) body += `<blockquote>${esc(ann.quote)}</blockquote>`;
          body += `<p class="note"><span class="author">${esc(ann.author)}</span> <span class="kind">${esc(ann.kind || "note")}</span> ${esc(ann.note)}</p>`;
          const replies = allAnnotations.filter((a) => a.parentId === ann.id).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
          for (const reply of replies) {
            body += `<p class="reply"><span class="author">${esc(reply.author)}</span> ${esc(reply.note)}</p>`;
          }
          body += `</div>`;
        }
        body += `</div>`;
      }
      body += `</section>`;
    }

    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(bookTitle)}</title>
<style>
:root{color-scheme:light dark;--bg:#faf8f4;--text:#1f1e1b;--muted:#8a8883;--accent:#d9795c;--panel:rgba(255,255,255,.72);--line:rgba(45,42,36,.1)}
@media(prefers-color-scheme:dark){:root{--bg:#11100f;--text:#f3eee8;--muted:#aaa29a;--panel:rgba(255,255,255,.07);--line:rgba(255,255,255,.1)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6}
.wrap{max-width:720px;margin:0 auto;padding:24px 20px 80px}
.cover{text-align:center;margin:0 0 32px}.cover img{max-width:280px;max-height:400px;border-radius:6px 12px 12px 6px;box-shadow:4px 4px 20px rgba(0,0,0,.15)}
h1{font-size:32px;margin:0 0 8px}h2{font-size:22px;margin:48px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--line)}h3{font-size:15px;color:var(--muted);margin:24px 0 12px;text-transform:uppercase;letter-spacing:.06em}
.meta{color:var(--muted);font-size:15px;margin:0 0 32px}
.text{font-family:Georgia,"Times New Roman","Songti SC",serif;font-size:18px;line-height:1.85;white-space:pre-wrap}
.annotations{margin:20px 0 0;padding:16px;border-radius:16px;background:var(--panel)}
.ann{margin:0 0 20px}.ann:last-child{margin:0}
blockquote{margin:0 0 8px;padding:8px 12px;border-left:3px solid var(--accent);color:var(--muted);font-family:Georgia,"Songti SC",serif;font-size:15px;line-height:1.6}
.note{margin:0 0 4px;font-size:15px;line-height:1.55}
.reply{margin:0 0 4px;padding-left:20px;font-size:14px;line-height:1.5;color:var(--text)}
.reply::before{content:"↳ ";color:var(--muted)}
.author{font-weight:700}.kind{color:var(--muted);font-size:13px}
.chapter{margin:0 0 16px}
</style></head><body><div class="wrap">
${coverImg}<h1>${esc(bookTitle)}</h1>${bookAuthor ? `<p class="meta">${esc(bookAuthor)}</p>` : ""}
${body}
</div></body></html>`;

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${encodeURIComponent(safeName)}.html"`,
    });
    res.end(html);
    return;
  }

  return sendError(res, 404, "Not found");
}

export async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "reader.html" : url.pathname.slice(1);
  const resolved = path.resolve(publicDir, requested);
  const relative = path.relative(publicDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendError(res, 403, "Forbidden");
  }

  try {
    const body = await readFile(resolved);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(resolved)] || "application/octet-stream",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return sendError(res, 404, "Not found");
    throw error;
  }
}
