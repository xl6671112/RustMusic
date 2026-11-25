export const playlistEditableGroups = ["content", "layout", "appearance", "tracks", "customCss"] as const;
export type PlaylistEditableGroup = typeof playlistEditableGroups[number];

// A template can rearrange supplied sections, but cannot add active content.
function playlistTemplateHTML(fragment: string): string | null {
  if (!fragment) return "";
  if (new TextEncoder().encode(fragment).length > 12000 ||
    fragment.split("{{header}}").length !== 2 || fragment.split("{{tracks}}").length !== 2) return null;
  const document = new DOMParser().parseFromString(`<root>${fragment}</root>`, "application/xml");
  if (document.getElementsByTagName("parsererror").length) return null;
  let headers = 0, tracks = 0;
  let html = "";
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
  const visit = (parent: Node): boolean => Array.from(parent.childNodes).every(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      headers += (node.textContent?.match(/\{\{header\}\}/g) || []).length;
      tracks += (node.textContent?.match(/\{\{tracks\}\}/g) || []).length;
      html += escape(node.textContent || "");
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as Element;
    if (!["div", "section", "article", "header", "footer"].includes(element.tagName) ||
      element.namespaceURI !== null || element.attributes.length > 1 || !Array.from(element.attributes).every(attribute =>
        attribute.name === "class" && /^[A-Za-z0-9 _-]{0,200}$/.test(attribute.value))) return false;
    html += `<${element.tagName}${element.hasAttribute("class") ? ` class="${element.getAttribute("class")}"` : ""}>`;
    if (!visit(element)) return false;
    html += `</${element.tagName}>`;
    return true;
  });
  return visit(document.documentElement) && headers === 1 && tracks === 1 ? html : null;
}
export function validPlaylistTemplate(fragment: string): boolean {
  return playlistTemplateHTML(fragment) !== null;
}

export function applyPlaylistTemplate(page: string, fragment = ""): string {
  if (!fragment) return page;
  const canonical = playlistTemplateHTML(fragment);
  if (canonical === null) return page;
  const header = page.indexOf("<header>");
  const tracks = page.indexOf("<ul>");
  const end = page.lastIndexOf("</main>");
  if (header < 0 || tracks < header || end < tracks) return page;
  // A single pass keeps placeholders in user titles from being expanded.
  const body = canonical.replace(/\{\{(header|tracks)\}\}/g, (_, key: string) =>
    key === "header" ? page.slice(header, tracks) : page.slice(tracks, end));
  return page.slice(0, header) + body + page.slice(end);
}
