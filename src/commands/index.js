import { generalCommands }     from "./general.js";
import { downloaderCommands }  from "./downloader.js";
import { stickerCommands }     from "./sticker.js";
import { funCommands }         from "./fun.js";
import { remindCommands }      from "./remind.js";
import { menuCommands }        from "./menu.js";
import { warningCommands }     from "./warnings.js";
import { broadcastCommands }   from "./broadcast.js";
import { statsCommands }       from "./stats.js";
import { apikeyCommands }      from "./apikey.js";
import { adminCommands }       from "./admins.js";
import { settingsCommands }    from "./settings.js";
import { bannedCommands }      from "./banned.js";
import { groupCommands }       from "./groups.js";
import { autoreplyCommands }   from "./autoreplies.js";
import { aiCommands }          from "./ai.js";
import { wordFilterCommands }  from "./wordfilter.js";
import { adminToolCommands }   from "./admintools.js";
import { groupManageCommands } from "./groupmanage.js";
import { antilinkCommands }    from "./antilink.js";
import { viewonceCommands }    from "./viewonce.js";
import { mp3Commands }         from "./mp3.js";
import { antideleteCommands }  from "./antidelete.js";
import { voiceCommands }       from "./voice.js";
import { aistickerCommands }   from "./aisticker.js";
import { schedulerCommands }   from "./scheduler.js";
import { aliasCommands }       from "./aliases.js";
import { searchCommands }      from "./search.js";
import { factsCommands }       from "./facts.js";
import { jokeCommands }        from "./joke.js";

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
  ...jokeCommands,
};

export { replyMsg, isAdmin } from "./helpers.js";
