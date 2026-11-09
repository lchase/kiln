/**
 * A small markdown subset for the board. Text is escaped before any tag is
 * added, so a draft cannot inject HTML or a script. Links are http(s) only.
 */

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let index = 0;
  let html = "";
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const fence: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        fence.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      html += `<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      const level = Math.min(heading[1].length, 3);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      html += `<blockquote>${inline(quote.join(" "))}</blockquote>`;
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && (isList(lines[index] ?? "") || (/^\s{2,}\S/.test(lines[index] ?? "") && items.length > 0))) {
        const item = lines[index] ?? "";
        index += 1;
        if (isList(item)) items.push(item.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
        else items[items.length - 1] = `${items[items.length - 1]} ${item.trim()}`;
      }
      const tag = ordered ? "ol" : "ul";
      html += `<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlock(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    html += `<p>${inline(paragraph.join(" "))}</p>`;
  }
  return html;
}

function isList(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isBlock(line: string): boolean {
  return /^(?:#{1,6}\s|```|>)/.test(line) || isList(line);
}

function inline(raw: string): string {
  const codes: string[] = [];
  const slotted = raw.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(escapeHtml(code));
    return `\u0000${codes.length - 1}\u0000`;
  });
  let html = escapeHtml(slotted);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  return html.replace(/\u0000(\d+)\u0000/g, (_match, slot: string) => `<code>${codes[Number(slot)] ?? ""}</code>`);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
