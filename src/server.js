#!/usr/bin/env node
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  annotatePassage,
  dataDir,
  getProgress,
  listAnnotations,
  listBooks,
  listChunks,
  markRead,
  readChunk,
  replyToAnnotation,
  searchChunks,
  submitUserNotes,
} from "./store.js";

const protocolVersion = "2024-11-05";

export const tools = [
  {
    name: "reading_list_books",
    description: "List imported books with progress and annotation counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { title: "List Books", readOnlyHint: true },
  },
  {
    name: "reading_list_chunks",
    description: "List chunks for a book in reading order.",
    inputSchema: {
      type: "object",
      required: ["bookId"],
      properties: { bookId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "List Chunks", readOnlyHint: true },
  },
  {
    name: "reading_read_chunk",
    description: "Read one book chunk and return prevId/nextId.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId"],
      properties: { bookId: { type: "string" }, chunkId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Read Chunk", readOnlyHint: true },
  },
  {
    name: "reading_search_chunks",
    description: "Search book chunks by keyword.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        bookId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Search Chunks", readOnlyHint: true },
  },
  {
    name: "reading_annotate_passage",
    description: "Write a margin annotation anchored to a quote in a chunk.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId", "quote", "note"],
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        quote: { type: "string" },
        note: { type: "string" },
        author: { type: "string" },
        kind: { type: "string" },
        mood: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string" },
        parentId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Annotate Passage" },
  },
  {
    name: "reading_list_annotations",
    description: "List annotations, optionally filtered by book, chunk, kind, or author.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        kind: { type: "string" },
        author: { type: "string" },
        status: { type: "string" },
        parentId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "List Annotations", readOnlyHint: true },
  },
  {
    name: "reading_submit_user_notes",
    description:
      "Submit open user notes for Claude review. By default, include each chunk's full text once per session and mark notes submitted so they are not sent again.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string" },
        chunkId: { type: "string" },
        sessionId: { type: "string" },
        contextMode: {
          type: "string",
          enum: ["chunk-once-per-session", "chunk-always", "notes-only"],
        },
        includeContext: { type: "boolean" },
        forceChunkContext: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Submit User Notes" },
  },
  {
    name: "reading_reply_to_annotation",
    description: "Attach a Claude reply under an existing user or Claude annotation.",
    inputSchema: {
      type: "object",
      required: ["parentId", "note"],
      properties: {
        parentId: { type: "string" },
        note: { type: "string" },
        author: { type: "string" },
        kind: { type: "string" },
        mood: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        bookId: { type: "string" },
        chunkId: { type: "string" },
        quote: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Reply To Annotation" },
  },
  {
    name: "reading_mark_read",
    description: "Mark a chunk as read and update last-read progress.",
    inputSchema: {
      type: "object",
      required: ["bookId", "chunkId"],
      properties: { bookId: { type: "string" }, chunkId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Mark Read" },
  },
  {
    name: "reading_get_progress",
    description: "Get reading progress for one book or all books.",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Get Progress", readOnlyHint: true },
  },
];

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textContent(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function callTool(name, args = {}) {
  switch (name) {
    case "reading_list_books":
      return textContent(await listBooks());
    case "reading_list_chunks":
      return textContent(await listChunks(args.bookId));
    case "reading_read_chunk":
      return textContent(await readChunk(args.bookId, args.chunkId));
    case "reading_search_chunks":
      return textContent(await searchChunks(args));
    case "reading_annotate_passage":
      return textContent(await annotatePassage(args));
    case "reading_list_annotations":
      return textContent(await listAnnotations(args));
    case "reading_submit_user_notes":
      return textContent(await submitUserNotes(args));
    case "reading_reply_to_annotation":
      return textContent(await replyToAnnotation(args));
    case "reading_mark_read":
      return textContent(await markRead(args.bookId, args.chunkId));
    case "reading_get_progress":
      return textContent(await getProgress(args.bookId));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return null;

  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion,
      serverInfo: { name: "co-reading-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
      instructions: `Use this server to read chunked books, search passages, track progress, and leave margin annotations. Data dir: ${dataDir}`,
    });
  }

  if (message.method === "notifications/initialized") {
    return null;
  }

  if (message.method === "tools/list") {
    return result(message.id, { tools });
  }

  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params || {};
    return result(message.id, await callTool(name, args || {}));
  }

  return error(message.id, -32601, `Method not found: ${message.method}`);
}

export function startStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const response = await handle(JSON.parse(line));
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      let id = null;
      try {
        id = JSON.parse(line).id ?? null;
      } catch {
        // Keep id null for parse errors.
      }
      output.write(`${JSON.stringify(error(id, -32000, err.message || String(err)))}\n`);
    }
  });

  return rl;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
