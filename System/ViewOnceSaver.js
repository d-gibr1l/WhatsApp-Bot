export const isViewOnceQuoted = (quoted) =>
  Boolean(quoted && (quoted.msg?.viewOnce || quoted.type?.toLowerCase().includes("viewonce")));

// WhatsApp never delivers View Once media to the bot directly — the media key
// only arrives inside the owner's reply (quoted copy), so this only works as a reply.
export async function saveViewOnce(Hooper, m) {
  const q = m.quoted;
  const target = m.sender;
  try {
    const mime = q.msg?.mimetype || "";
    const kind = /image/.test(mime) || q.type === "imageMessage" ? "image"
      : /video/.test(mime) || q.type === "videoMessage" ? "video"
      : /audio/.test(mime) || q.type === "audioMessage" ? "audio"
      : null;
    if (!kind) return;

    const buffer = await Hooper.downloadMediaMessage(q.msg || q);
    if (!buffer?.length) {
      console.error("[ VIEWONCE ] Downloaded buffer is empty");
      return;
    }

    const senderNumber = q.sender.split("@")[0];
    const originalCaption = q.msg?.caption ? `\n\n${q.msg.caption}` : "";
    const caption = `viewonce saved from @${senderNumber}${originalCaption}`;
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
