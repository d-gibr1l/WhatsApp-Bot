import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const menuCommands = {

  menu: {
    adminOnly: false,
    requiresArgs: false,
    description: "Show the menu",
    handler: async (sock, msg, _args, from, prefix) => {
      const menu = cachedGetSetting("menu", null);
      if (!menu) return replyMsg(sock, from, msg, `No menu set yet. Admin can set one with ${prefix}setmenu`);
      await replyMsg(sock, from, msg, menu);
    },
  },

  setmenu: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the menu that users see when they type the menu command",
    usage: "!setmenu <content>",
    examples: ["!setmenu 🍔 *Our Menu*\n\n• Burger - $5\n• Pizza - $8"],
    notes: "You can use WhatsApp formatting: *bold*, _italic_, ~strikethrough~",
    handler: async (sock, msg, args, from, prefix) => {
      try {
        await setSetting("menu", args.join(" "));
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Menu updated. Type ${prefix}menu to preview it.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setmenu`, err);
      }
    },
  },

};
