import { extractMessageContent, getContentType } from "@whiskeysockets/baileys";

const WRAPPERS = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
const CACHE_LIMIT = 200;

// WhatsApp doesn't include a View Once's content inside the reply that quotes
// it, so remember the View Once messages themselves (ours and everyone's) as
// they arrive and look the original up by id when the owner replies.
const viewOnceCache = new Map();

export function rememberViewOnce(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  let isViewOnce = WRAPPERS.some((w) => msg.message[w]);
  if (!isViewOnce) {
    const inner = extractMessageContent(msg.message);
    isViewOnce = Boolean(inner?.[getContentType(inner)]?.viewOnce);
  }
  if (!isViewOnce) return;
  viewOnceCache.delete(id);
  viewOnceCache.set(id, msg);
  if (viewOnceCache.size > CACHE_LIMIT) viewOnceCache.delete(viewOnceCache.keys().next().value);
}

const kindFromType = (type) =>
  type === "imageMessage" ? "image" : type === "videoMessage" ? "video" : type === "audioMessage" ? "audio" : null;

export function quotedMediaKind(quoted) {
  if (!quoted) return null;
  const mime = quoted.msg?.mimetype || "";
  if (/image/.test(mime) || quoted.type === "imageMessage") return "image";
  if (/video/.test(mime) || quoted.type === "videoMessage") return "video";
  if (/audio/.test(mime) || quoted.type === "audioMessage") return "audio";
  return null;
}

/** Resolves the media the owner replied to, from the quoted copy or the View Once cache. */
function resolveSource(m) {
  const q = m.quoted;
  const kind = quotedMediaKind(q);
  if (kind) return { kind, source: q.msg || q, content: q.msg, sender: q.sender };

  const cached = viewOnceCache.get(m.msg?.contextInfo?.stanzaId);
  if (!cached) return null;
  const inner = extractMessageContent(cached.message);
  const type = getContentType(inner);
  const cachedKind = kindFromType(type);
  if (!cachedKind) return null;
  const sender = cached.key.fromMe ? m.sender : cached.key.participant || cached.key.remoteJid;
  return { kind: cachedKind, source: cached, content: inner[type], sender };
}

/** Returns true when the message was a View Once save request (success or reported failure). */
export async function saveViewOnce(Hooper, m) {
  const target = m.sender;
  const found = resolveSource(m);
  if (!found) {
    const stanzaId = m.msg?.contextInfo?.stanzaId;
    if (stanzaId || m.quoted) {
      console.log(
        `[ VIEWONCE ] Trigger ignored — nothing to save (quoted=${Boolean(m.quoted)} quotedType=${m.quoted?.type} ` +
          `replyToId=${stanzaId ? "yes" : "no"} cached=${viewOnceCache.size})`,
      );
    }
    return false;
  }

  try {
    const { kind, source, content, sender } = found;
    const buffer = await Hooper.downloadMediaMessage(source);
    if (!buffer?.length) throw new Error("WhatsApp returned no media for that message");

    const senderNumber = sender.split("@")[0];
    const originalCaption = content?.caption ? `\n\n${content.caption}` : "";
    const caption = `viewonce saved from @${senderNumber}${originalCaption}`;
    const mentions = [sender];

    if (kind === "audio") {
      await Hooper.sendMessage(target, { audio: buffer, mimetype: "audio/mp4", ptt: true });
      if (originalCaption) await Hooper.sendMessage(target, { text: caption, mentions });
    } else {
      await Hooper.sendMessage(target, { [kind]: buffer, caption, mentions });
    }
    console.log(`[ VIEWONCE ] Saved ${kind} to ${target}`);
  } catch (e) {
    console.error("[ VIEWONCE ] Failed:", e);
    try {
      await Hooper.sendMessage(target, { text: `⚠️ View Once save failed:\n${e.message || String(e)}` });
    } catch {}
  }
  return true;
}
