import { m } from '../Core.js';

export default {
  name: "debugadmin",
  description: "Debug admin privileges",
  run: async (Hooper, m, { isAdmin, isBotAdmin, groupAdmin, isCreator, participants, botNumber }) => {
    
    const sanitize = (jid) => {
      if (!jid) return "";
      return jid.split("@")[0].split(":")[0] + "@" + jid.split("@")[1];
    };

    let resolvedSender = m.sender;
    let lidDebug = "No LID";
    if (m.sender.endsWith("@lid")) {
      lidDebug = "Was LID";
      const cached = global.lidToJidMap?.get(sanitize(m.sender));
      if (cached && cached.endsWith("@s.whatsapp.net")) {
        resolvedSender = cached;
        lidDebug = "Resolved via Cache: " + resolvedSender;
      } else if (m.key?.participantAlt?.endsWith("@s.whatsapp.net")) {
        resolvedSender = sanitize(m.key.participantAlt);
        lidDebug = "Resolved via participantAlt: " + resolvedSender;
      } else if (m.isGroup) {
        const pMatch = participants.find(
          (p) => sanitize(p.id) === sanitize(m.sender) && p.phoneNumber
        );
        if (pMatch) {
            resolvedSender = sanitize(pMatch.phoneNumber);
            lidDebug = "Resolved via phoneNumber: " + resolvedSender;
        } else {
            lidDebug = "Could not resolve via phoneNumber. pMatch was undefined.";
        }
      }
    }

    const ownerDigits = new Set(
      [sanitize(botNumber), ...global.owner].map((v) => v.replace(/[^0-9]/g, ""))
    );
    const inOwnerDigits = ownerDigits.has(resolvedSender.replace(/[^0-9]/g, "")) || ownerDigits.has(m.sender.replace(/[^0-9]/g, ""));

    let txt = `*Admin Debug Info*\n\n`;
    txt += `*Sender:* ${m.sender}\n`;
    txt += `*Resolved Sender:* ${resolvedSender}\n`;
    txt += `*LID Debug:* ${lidDebug}\n`;
    txt += `*isAdmin (passed from Core):* ${isAdmin}\n`;
    txt += `*isCreator (passed from Core):* ${isCreator}\n`;
    txt += `*botNumber:* ${botNumber}\n`;
    txt += `*global.owner:* ${global.owner.join(", ")}\n`;
    txt += `*inOwnerDigits:* ${inOwnerDigits}\n`;
    txt += `*groupAdmins length:* ${groupAdmin.length}\n`;
    txt += `*is m.sender in groupAdmins:* ${groupAdmin.includes(m.sender)}\n`;
    txt += `*is resolvedSender in groupAdmins:* ${groupAdmin.includes(resolvedSender)}\n`;
    
    await m.reply(txt);
  }
};
