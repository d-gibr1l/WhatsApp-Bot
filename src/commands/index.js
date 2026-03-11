import { generalCommands }    from "./general.js";
import { downloaderCommands } from "./downloader.js";
import { stickerCommands }    from "./sticker.js";
import { funCommands }        from "./fun.js";
import { remindCommands }     from "./remind.js";
import { menuCommands }       from "./menu.js";
import { warningCommands }    from "./warnings.js";
import { broadcastCommands }  from "./broadcast.js";
import { statsCommands }      from "./stats.js";
import { apikeyCommands }     from "./apikey.js";
import { adminCommands }      from "./admins.js";
import { settingsCommands }   from "./settings.js";
import { bannedCommands }     from "./banned.js";
import { groupCommands }      from "./groups.js";
import { autoreplyCommands }  from "./autoreplies.js";

export const commands = {
  ...generalCommands,
  ...downloaderCommands,
  ...stickerCommands,
  ...funCommands,
  ...remindCommands,
  ...menuCommands,
  ...warningCommands,
  ...broadcastCommands,
  ...statsCommands,
  ...apikeyCommands,
  ...adminCommands,
  ...settingsCommands,
  ...bannedCommands,
  ...groupCommands,
  ...autoreplyCommands,
  ...aiCommands,
  ...wordFilterCommands,
  ...adminToolCommands,
  ...groupManageCommands,
  ...antilinkCommands,
  ...viewonceCommands,
  ...mp3Commands,
  ...antideleteCommands,
  ...voiceCommands,
  ...aistickerCommands,
  ...schedulerCommands,
  ...aliasCommands,
  ...searchCommands,
  ...factsCommands,
};

// Re-export helpers so handler.js import path stays the same
export { replyMsg, isAdmin } from "./helpers.js";
