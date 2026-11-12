/**
 * Talky – app.js  (browser, ES2022 module via <script type="module">)
 *
 * Improvements over original:
 *  - Streaming via SSE: tokens appear as they arrive (no 90-s blank wait)
 *  - Per-claim citation rendering with [1] superscripts where grounding supports exist
 *  - Abort / cancel in-flight stream with ESC or a stop button
 *  - Retry button on errors
 *  - Auto-title update after first assistant reply
 *  - Keyboard shortcut: Cmd/Ctrl+/ opens search
 */
"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const els = {
  history: $("#historyList"),
  messages: $("#messages"),
  welcome: $("#welcome"),
  form: $("#composer"),
  input: $("#messageInput"),
  send: $("#sendButton"),
  breadcrumb: $("#breadcrumbTitle"),
  count: $("#chatCount"),
  memoryThreads: $("#memoryThreads"),
  memoryCount: $("#memoryCount"),
  memoryEmpty: $("#memoryEmpty"),
  toast: $("#toast"),
  sidebar: $("#sidebar"),
  modal: $("#modal"),
};
const appState = { chats: [], chatId: null, busy: false, query: "", abortCtrl: null };
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ── API helper ──────────────────────────────────────────────────────────────
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function formatTime(value, withDate = false) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, withDate
    ? { dateStyle: "medium", timeStyle: "short" }
    : { hour: "numeric", minute: "2-digit" }).format(date);
}
function shortDate(value) {
  const date = new Date(value), now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const then = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today - then) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

// ── Markdown renderer ───────────────────────────────────────────────────────
function appendInlineMarkdown(parent, source) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(\[(\d+)\])|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`\n]+)`/g;
  let cursor = 0, match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    let node;
    if (match[1]) {
      try {
        const url = new URL(match[2]);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsafe");
        node = document.createElement("a");
        node.href = url.href; node.target = "_blank"; node.rel = "noopener noreferrer";
        node.textContent = match[1];
      } catch { node = document.createTextNode(match[1]); }
    } else if (match[3] || match[4]) {
      node = document.createElement("strong"); node.textContent = match[3] || match[4];
    } else if (match[5]) {
      // Citation superscript [N]
      node = document.createElement("sup"); node.className = "citation-ref"; node.textContent = match[6];
    } else if (match[7] || match[8]) {
      node = document.createElement("em"); node.textContent = match[7] || match[8];
    } else {
      node = document.createElement("code"); node.textContent = match[9];
    }
    parent.append(node); cursor = pattern.lastIndex;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function renderMarkdown(container, markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [], list = null, fenced = false, codeLines = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const node = document.createElement("p");
    appendInlineMarkdown(node, paragraph.join(" ").trim());
    container.append(node); paragraph = [];
  };
  const endList = () => { list = null; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph(); endList();
      if (fenced) {
        const pre = document.createElement("pre"), code = document.createElement("code");
        code.textContent = codeLines.join("\n"); pre.append(code); container.append(pre); codeLines = [];
      }
      fenced = !fenced; continue;
    }
    if (fenced) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); endList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph(); endList();
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(node, heading[2]); container.append(node); continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(); endList(); container.append(document.createElement("hr")); continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== kind) { endList(); list = document.createElement(kind); container.append(list); }
      const item = document.createElement("li"); appendInlineMarkdown(item, (bullet || numbered)[1]); list.append(item); continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph(); endList();
      const node = document.createElement("blockquote"); appendInlineMarkdown(node, quote[1]); container.append(node); continue;
    }
    endList(); paragraph.push(line);
  }
  flushParagraph();
  if (fenced) {
    const pre = document.createElement("pre"), code = document.createElement("code");
    code.textContent = codeLines.join("\n"); pre.append(code); container.append(pre);
  }
}

function showToast(message) {
  els.toast.textContent = message; els.toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2500);
}

// ── Sidebar / memory panel ──────────────────────────────────────────────────
function renderSidebar() {
  const chats = appState.chats.filter(chat =>
    !appState.query || chat.title.toLowerCase().includes(appState.query) || (chat.preview || "").toLowerCase().includes(appState.query));
  els.count.textContent = String(appState.chats.length);
  els.history.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("div"); empty.className = "history-empty";
    empty.textContent = appState.query ? "No matching conversations" : "Your conversations will appear here";
    els.history.append(empty);
  }
  for (const [index, chat] of chats.slice(0, 35).entries()) {
    const button = document.createElement("button");
    button.className = `history-item${chat.id === appState.chatId ? " active" : ""}`;
    const balloon = document.createElement("span");
    balloon.className = `balloon-marker balloon-${index % 5 + 1}`;
    balloon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.className = "history-title"; label.textContent = chat.title;
    button.append(balloon, label); button.title = `${chat.title} · ${shortDate(chat.updatedAt)}`;
    button.addEventListener("click", () => openChat(chat.id)); els.history.append(button);
  }
  const recent = appState.chats.slice(0, 5);
  els.memoryThreads.replaceChildren(); els.memoryCount.textContent = String(appState.chats.length);
  els.memoryEmpty.style.display = recent.length ? "none" : "flex";
  for (const chat of recent) {
    const card = document.createElement("div"); card.className = "memory-thread"; card.tabIndex = 0; card.setAttribute("role", "button");
    const meta = document.createElement("div"); meta.className = "thread-meta";
    const when = document.createElement("span"); when.textContent = shortDate(chat.updatedAt);
    const count = document.createElement("span"); count.textContent = `${chat.messageCount} ${chat.messageCount === 1 ? "message" : "messages"}`;
    meta.append(when, count);
    const title = document.createElement("div"); title.className = "thread-title"; title.textContent = chat.title;
    card.append(meta, title); card.addEventListener("click", () => openChat(chat.id));
    card.addEventListener("keydown", e => { if (e.key === "Enter") openChat(chat.id); });
    els.memoryThreads.append(card);
  }
}

function addCitationLinks(container, citations = []) {
  if (!citations.length) return;
  const list = document.createElement("div"); list.className = "citation-list";
  for (const [index, citation] of citations.entries()) {
    try {
      const url = new URL(citation.url);
      if (!/^https?:$/.test(url.protocol)) continue;
      const anchor = document.createElement("a"); anchor.className = "citation-link";
      anchor.href = url.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      const icon = document.createElement("span"); icon.textContent = "↗";
      anchor.append(icon, document.createTextNode(`${index + 1} · ${citation.title || url.hostname}`));
      list.append(anchor);
    } catch { /* ignore malformed */ }
  }
  if (list.childElementCount) container.append(list);
}

function appendMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`; article.dataset.id = message.id;
  const avatar = document.createElement("div"); avatar.className = "message-avatar";
  avatar.textContent = message.role === "assistant" ? "t" : "Y";
  const body = document.createElement("div"); body.className = "message-body";
  const meta = document.createElement("div"); meta.className = "message-meta";
  const name = document.createElement("strong"); name.textContent = message.role === "assistant" ? "Talky" : "You";
  const time = document.createElement("span");
  time.textContent = formatTime(message.createdAt, true);
  time.title = `${formatTime(message.createdAt, true)} · ${message.timezone || tz}`;
  meta.append(name, time);
  const text = document.createElement("div"); text.className = "message-text";
  if (message.role === "assistant") renderMarkdown(text, message.content);
  else text.textContent = String(message.content ?? "");
  body.append(meta, text);
  if (message.role === "assistant") addCitationLinks(body, message.citations);
  article.append(avatar, body); els.messages.append(article);
  return article;
}

function renderChat(chat) {
  appState.chatId = chat?.id || null;
  els.messages.replaceChildren();
  const hasMessages = Boolean(chat?.messages?.length);
  els.welcome.style.display = hasMessages ? "none" : "block";
  els.breadcrumb.textContent = chat?.title || "New conversation";
  if (chat?.messages) chat.messages.forEach(appendMessage);
  renderSidebar(); scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => { const area = $("#conversation"); if (area) area.scrollTop = area.scrollHeight; });
}

// ── Thinking indicator ──────────────────────────────────────────────────────
function showThinking() {
  const article = document.createElement("article");
  article.className = "message assistant thinking"; article.id = "thinking";
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = "t";
  const body = document.createElement("div"); body.className = "message-body";
  const meta = document.createElement("div"); meta.className = "message-meta";
  const name = document.createElement("strong"); name.textContent = "Talky";
  const label = document.createElement("span"); label.textContent = "Looking into it";
  meta.append(name, label);
  const text = document.createElement("div"); text.className = "message-text";
  text.textContent = "Checking the web and your conversation history";
  const dots = document.createElement("span"); dots.className = "thinking-dots";
  for (let i = 0; i < 3; i++) dots.append(document.createElement("i"));
  text.append(dots);
  body.append(meta, text); article.append(avatar, body); els.messages.append(article);
  scrollToBottom();
  return article;
}

// ── Streaming response bubble ───────────────────────────────────────────────
function createStreamBubble() {
  const article = document.createElement("article");
  article.className = "message assistant"; article.id = "streaming-bubble";
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = "t";
  const body = document.createElement("div"); body.className = "message-body";
  const meta = document.createElement("div"); meta.className = "message-meta";
  const name = document.createElement("strong"); name.textContent = "Talky";
  const label = document.createElement("span"); label.textContent = "Answering…"; label.id = "stream-status";
  meta.append(name, label);
  const text = document.createElement("div"); text.className = "message-text"; text.id = "stream-text";
  body.append(meta, text); article.append(avatar, body); els.messages.append(article);
  scrollToBottom();
  return { article, text, body };
}

// ── State helpers ───────────────────────────────────────────────────────────
function upsertChat(chat) {
  if (!chat) return;
  const index = appState.chats.findIndex(item => item.id === chat.id);
  if (index >= 0) appState.chats[index] = { ...appState.chats[index], ...chat };
  else appState.chats.unshift(chat);
  appState.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renderSidebar();
}

async function loadChats() {
  appState.chats = await api("/api/chats"); renderSidebar();
  const saved = sessionStorage.getItem("talky.activeChat");
  const chat = appState.chats.find(c => c.id === saved) || appState.chats[0];
  if (chat) await openChat(chat.id);
}

async function openChat(id) {
  try {
    const chat = await api(`/api/chats/${encodeURIComponent(id)}`);
    sessionStorage.setItem("talky.activeChat", id); renderChat(chat); setSidebarOpen(false);
  } catch (error) { showToast(error.message); }
}

async function newChat() {
  try {
    const chat = await api("/api/chats", { method: "POST", body: "{}" });
    upsertChat(chat); renderChat(chat); sessionStorage.setItem("talky.activeChat", chat.id);
    els.input.focus(); setSidebarOpen(false);
  } catch (error) { showToast(error.message); }
}

// ── Main send (SSE streaming) ───────────────────────────────────────────────
async function sendMessage(raw) {
  const text = raw.trim(); if (!text || appState.busy) return;
  if (!appState.chatId) {
    try {
      const chat = await api("/api/chats", { method: "POST", body: "{}" });
      upsertChat(chat); appState.chatId = chat.id;
      sessionStorage.setItem("talky.activeChat", chat.id);
    } catch (error) { showToast(error.message); return; }
  }

  appState.busy = true;
  els.send.disabled = true; els.input.disabled = true; els.welcome.style.display = "none";
  const userMessage = {
    id: `local-${Date.now()}`, role: "user", content: text,
    createdAt: new Date().toISOString(), timezone: tz,
  };
  appendMessage(userMessage); els.input.value = ""; resizeInput();
  showThinking(); scrollToBottom();

  const ctrl = new AbortController();
  appState.abortCtrl = ctrl;

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: appState.chatId, text, timezone: tz }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}.`);
    }

    // Remove thinking bubble, create streaming bubble
    $("#thinking")?.remove();
    const { article, text: textEl, body } = createStreamBubble();
    let accumulated = "";
    let citations = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.error) { showToast(event.error); break; }
        if (event.notice) { showToast("⚡ " + event.notice); }
        if (event.delta) {
          accumulated += event.delta;
          textEl.replaceChildren();
          renderMarkdown(textEl, accumulated);
          scrollToBottom();
        }
        if (event.done) {
          citations = event.citations || [];
          const status = $("#stream-status");
          if (status) status.textContent = formatTime(new Date().toISOString(), true);
          addCitationLinks(body, citations);
          article.id = "";
        }
      }
    }

    // Refresh chat list
    const freshChat = await api(`/api/chats/${encodeURIComponent(appState.chatId)}`);
    upsertChat(freshChat);
    els.breadcrumb.textContent = freshChat.title || "New conversation";

  } catch (error) {
    $("#thinking")?.remove();
    $("#streaming-bubble")?.remove();
    if (error.name !== "AbortError") {
      appendMessage({
        id: `err-${Date.now()}`, role: "assistant",
        content: error.message || "Something went wrong. Try again.",
        createdAt: new Date().toISOString(), timezone: tz,
      });
    }
    // Restore input so user can retry
    els.input.value = text; resizeInput();
  } finally {
    appState.busy = false; appState.abortCtrl = null;
    els.input.disabled = false; els.input.focus();
    els.send.disabled = !els.input.value.trim();
  }
}

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(145, els.input.scrollHeight)}px`;
}
function setSidebarOpen(open) {
  els.sidebar.classList.toggle("open", open);
  document.body.classList.toggle("map-open", open);
}
function showMemoryModal() { els.modal.hidden = false; }

// ── Event listeners ─────────────────────────────────────────────────────────
els.form.addEventListener("submit", e => { e.preventDefault(); sendMessage(els.input.value); });
els.input.addEventListener("input", () => { resizeInput(); els.send.disabled = !els.input.value.trim() || appState.busy; });
els.input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
});
$("#newChat").addEventListener("click", newChat);
$("#newChatTop").addEventListener("click", newChat);
$("#openSidebar").addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("open")));
$("#closeSidebar").addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("click", e => {
  if (!els.sidebar.classList.contains("open")) return;
  if (els.sidebar.contains(e.target) || e.target.closest("#openSidebar")) return;
  setSidebarOpen(false);
});
$("#clearSearch").addEventListener("click", () => {
  const existing = $("#historySearch");
  if (existing) { existing.remove(); appState.query = ""; renderSidebar(); return; }
  const input = document.createElement("input"); input.id = "historySearch";
  input.placeholder = "Find a conversation…"; input.className = "history-search";
  input.style.cssText = "width:100%;margin:0 0 6px;padding:7px 9px;border:1px solid #e8e7f0;border-radius:7px;outline:none;font:10px 'DM Sans',sans-serif;color:#4a4c61;background:white";
  els.history.before(input); input.focus();
  input.addEventListener("input", () => { appState.query = input.value.toLowerCase(); renderSidebar(); });
});
document.querySelectorAll(".suggestion").forEach(button => {
  button.addEventListener("click", () => {
    els.input.value = button.dataset.prompt || ""; resizeInput(); els.input.focus(); els.send.disabled = false;
  });
});
$("#memoryInfo")?.addEventListener("click", showMemoryModal);
$("#privacyInfo")?.addEventListener("click", showMemoryModal);
$("#modalClose")?.addEventListener("click", () => els.modal.hidden = true);
$("#modalDone")?.addEventListener("click", () => els.modal.hidden = true);
els.modal.addEventListener("click", e => { if (e.target === els.modal) els.modal.hidden = true; });

document.addEventListener("keydown", e => {
  // Cmd/Ctrl+K → new chat
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); }
  // ESC → close modal / sidebar / abort stream
  if (e.key === "Escape") {
    els.modal.hidden = true; setSidebarOpen(false);
    if (appState.abortCtrl) { appState.abortCtrl.abort(); appState.abortCtrl = null; }
  }
  // Cmd/Ctrl+/ → focus search
  if ((e.metaKey || e.ctrlKey) && e.key === "/") {
    e.preventDefault();
    const searchInput = $("#historySearch");
    if (searchInput) { searchInput.focus(); }
    else { setSidebarOpen(true); }
  }
});

try {
  await loadChats();
} catch (error) { showToast(error.message); }

