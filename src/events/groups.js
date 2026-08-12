import { cachedGetSetting } from "../cache.js";

export function bindGroupEvents(sock) {
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    try {
      let groupMeta = null;
      for (const participant of participants) {
        const number = participant.split("@")[0];
        if (action === "add") {
          const enabled = cachedGetSetting(`welcome_enabled_${id}`, "false");
          if (enabled !== "true") continue;
          
          if (groupMeta === null) {
            groupMeta = await sock.groupMetadata(id).catch(() => undefined) || {};
          }
          const groupName = groupMeta.subject || "the group";
          
          const template  = cachedGetSetting(`welcome_${id}`, `Welcome *{name}* to *{group}*!`);
          const text = template
            .replace(/{name}/g,   number)
            .replace(/{group}/g,  groupName)
            .replace(/{number}/g, number);
          await sock.sendMessage(id, { text, mentions: [participant] });
        } else if (action === "remove") {
          const enabled = cachedGetSetting(`goodbye_enabled_${id}`, "false");
          if (enabled !== "true") continue;
          
          if (groupMeta === null) {
            groupMeta = await sock.groupMetadata(id).catch(() => undefined) || {};
          }
          const groupName = groupMeta.subject || "the group";
          
          const template  = cachedGetSetting(`goodbye_${id}`, `*{name}* has left *{group}*. Goodbye!`);
          const text = template
            .replace(/{name}/g,   number)
            .replace(/{group}/g,  groupName)
            .replace(/{number}/g, number);
          await sock.sendMessage(id, { text });
        }
      }
    } catch (err) {
      console.error("Welcome/goodbye error:", err.message);
    }
  });
}
