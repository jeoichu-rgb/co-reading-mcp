const state = {
  books: [],
  chunks: [],
  annotations: [],
  bookId: null,
  chunkId: null,
  chunk: null,
  quote: "",
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBooks() {
  $("books").innerHTML = state.books
    .map((book) => {
      const total = book.chunkCount || 0;
      const read = book.chunksRead || 0;
      const pct = total ? Math.round((read / total) * 100) : 0;
      return `<button class="book ${book.bookId === state.bookId ? "active" : ""}" data-book="${escapeHtml(book.bookId)}">
        <span class="book-title">${escapeHtml(book.title || book.bookId)}</span>
        <span class="book-meta">${escapeHtml(book.author || "Unknown author")} · ${read}/${total} · ${book.annotationCount || 0} notes</span>
        <span class="progress"><span style="width: ${pct}%"></span></span>
      </button>`;
    })
    .join("");
}

function renderChunks() {
  $("chunks").innerHTML = state.chunks
    .map(
      (chunk) => `<button class="chunk ${chunk.id === state.chunkId ? "active" : ""}" data-chunk="${escapeHtml(chunk.id)}">
        <span class="chunk-title">${escapeHtml(chunk.title)}</span>
        <span class="chunk-meta">${escapeHtml(chunk.id)} · ${chunk.read ? "read" : "unread"} · ${chunk.annotationCount || 0} notes</span>
      </button>`,
    )
    .join("");
}

function renderText() {
  if (!state.chunk) return;
  let html = escapeHtml(state.chunk.text);
  for (const note of state.annotations.filter((item) => item.chunkId === state.chunkId && item.quote)) {
    const quote = escapeHtml(note.quote);
    if (quote && html.includes(quote)) {
      html = html.replace(quote, `<mark title="${escapeHtml(note.note)}">${quote}</mark>`);
    }
  }
  $("text").innerHTML = html;
}

function renderAnnotations() {
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const openCount = state.annotations.filter((item) => item.author === "user" && (item.status || "open") === "open")
    .length;

  $("margins").innerHTML = notes
    .map(
      (note) => `<article class="note-card ${(note.status || "") === "open" ? "open" : ""}">
        <p class="note-quote">${escapeHtml(note.quote)}</p>
        <p class="note-body">${escapeHtml(note.note)}</p>
        <div class="note-meta">${escapeHtml(note.author || "unknown")} · ${escapeHtml(note.kind || "note")} · ${escapeHtml(note.status || "published")}</div>
      </article>`,
    )
    .join("");

  $("submit-notes").disabled = openCount === 0;
  $("submit-notes").textContent = openCount ? `Send ${openCount} to Claude` : "Send to Claude";
  $("status").textContent = openCount
    ? `${openCount} open note${openCount === 1 ? "" : "s"} waiting.`
    : "Open notes stay local until you send them.";
}

async function loadBooks() {
  state.books = await api("/api/books");
  renderBooks();
}

async function selectBook(bookId) {
  state.bookId = bookId;
  state.chunkId = null;
  state.chunk = null;
  state.chunks = await api(`/api/books/${encodeURIComponent(bookId)}/chunks`);
  state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(bookId)}`);
  const book = state.books.find((item) => item.bookId === bookId);
  $("book-meta").textContent = book?.author || "Unknown author";
  $("book-title").textContent = book?.title || bookId;
  $("chunk-file").textContent = "No chapter selected";
  $("chunk-title").textContent = "Open a chapter to start reading";
  $("text").innerHTML = `<p class="empty">Choose a chapter. Highlight text to leave a note for Claude.</p>`;
  $("mark-read").disabled = true;
  renderBooks();
  renderChunks();
  renderAnnotations();
}

async function selectChunk(chunkId) {
  state.chunkId = chunkId;
  state.chunk = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  $("chunk-file").textContent = state.chunk.chunk.id;
  $("chunk-title").textContent = state.chunk.chunk.title;
  $("mark-read").disabled = false;
  renderChunks();
  renderText();
  renderAnnotations();
}

function openNoteForm(quote) {
  state.quote = quote.trim();
  if (!state.bookId || !state.chunkId || !state.quote) return;
  $("quote-preview").textContent = state.quote;
  $("note").value = "";
  $("note-form").hidden = false;
  $("note").focus();
}

async function refreshCurrent() {
  await loadBooks();
  if (state.bookId) {
    state.chunks = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks`);
    state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(state.bookId)}`);
    renderBooks();
    renderChunks();
    renderText();
    renderAnnotations();
  }
}

$("books").addEventListener("click", (event) => {
  const button = event.target.closest("[data-book]");
  if (button) selectBook(button.dataset.book).catch(showError);
});

$("chunks").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chunk]");
  if (button) selectChunk(button.dataset.chunk).catch(showError);
});

$("text").addEventListener("mouseup", () => {
  const selection = window.getSelection();
  const quote = selection?.toString() || "";
  if (quote.trim().length > 0) openNoteForm(quote);
});

$("cancel-note").addEventListener("click", () => {
  $("note-form").hidden = true;
});

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/annotations", {
    method: "POST",
    body: {
      bookId: state.bookId,
      chunkId: state.chunkId,
      quote: state.quote,
      note: $("note").value.trim(),
      kind: "note",
    },
  });
  $("note-form").hidden = true;
  await refreshCurrent();
});

$("submit-notes").addEventListener("click", async () => {
  await api("/api/submit-notes", {
    method: "POST",
    body: {
      bookId: state.bookId,
      sessionId: "reader",
      contextMode: "chunk-once-per-session",
    },
  });
  await refreshCurrent();
});

$("mark-read").addEventListener("click", async () => {
  await api("/api/mark-read", {
    method: "POST",
    body: { bookId: state.bookId, chunkId: state.chunkId },
  });
  await refreshCurrent();
});

$("refresh").addEventListener("click", () => refreshCurrent().catch(showError));

function showError(error) {
  $("status").textContent = error.message || String(error);
}

loadBooks().catch(showError);
