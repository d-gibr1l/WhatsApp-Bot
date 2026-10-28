// serialize() unwraps the View Once wrapper and WhatsApp doesn't reliably keep
// the viewOnce flag on the quoted copy, so "is it view-once" can't be trusted.
// Gate on "is it downloadable media" instead.
export function quotedMediaKind(quoted) {
  if (!quoted) return null;
  const mime = quoted.msg?.mimetype || "";
  if (/image/.test(mime) || quoted.type === "imageMessage") return "image";
  if (/video/.test(mime) || quoted.type === "videoMessage") return "video";
  if (/audio/.test(mime) || quoted.type === "audioMessage") return "audio";
  return null;
}

// WhatsApp never delivers View Once media to the bot directly — the media key
// only arrives inside the owner's reply (quoted copy), so this only works as a reply.
export async function saveViewOnce(Hooper, m) {
  const q = m.quoted;
  const target = m.sender;
  try {
    const kind = quotedMediaKind(q);
    if (!kind) return;

    const buffer = await Hooper.downloadMediaMessage(q.msg || q);
    if (!buffer?.length) throw new Error("WhatsApp returned no media for that message");

    const senderNumber = q.sender.split("@")[0];
    const originalCaption = q.msg?.caption ? `\n\n${q.msg.caption}` : "";
    const label = q.msg?.viewOnce ? "viewonce saved" : "saved";
    const caption = `${label} from @${senderNumber}${originalCaption}`;
    const mentions = [q.sender];

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
}
