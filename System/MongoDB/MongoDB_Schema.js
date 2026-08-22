import mongoose from "mongoose";
import config from "../../Configurations.js";
const options = {
  socketTimeoutMS: 30000,
};

// ----------------------- Hooper can work with upto 4 MongoDB databases at once to distribute DB load  -------------------- //

const db1 = mongoose.createConnection(config.mongodb, options); // You malually put first mongodb url here
const db2 = mongoose.createConnection(config.mongodb, options); // You malually put second mongodb url here

const GroupSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  antilink: { type: Boolean, default: false },
  antidelete: { type: Boolean, default: false },
  nsfw: { type: Boolean, default: false },
  bangroup: { type: Boolean, default: false },
  chatBot: { type: Boolean, default: false },
  botSwitch: { type: Boolean, default: true },
  switchNSFW: { type: Boolean, default: false },
  switchWelcome: { type: Boolean, default: false },
  allowed: { type: Boolean, default: false },
});

const UserSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  ban: { type: Boolean, default: false },
  name: { type: String },
  addedMods: { type: Boolean, default: false },
  allowed: { type: Boolean, default: false },
});

const CoreSchema = new mongoose.Schema({
  id: { type: String, unique: false, required: true, default: "1" },
  seletedCharacter: { type: String, default: "0" },
  PMchatBot: { type: Boolean, default: false },
  botMode: { type: String, default: "public" },
  aiActive: { type: Boolean, default: true },
  groqKey: { type: String, default: "" },
  aiPrompt: { type: String, default: "You are a helpful WhatsApp bot assistant. Be concise, friendly, and helpful. Keep responses brief and suitable for WhatsApp." }
});

const PluginSchema = new mongoose.Schema({
  plugin: { type: String },
  url: { type: String },
});

const ContactSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String },
  notify: { type: String },
  verifiedName: { type: String }
});

const MessageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  chatId: { type: String, required: true },
  participant: { type: String },
  data: { type: mongoose.Schema.Types.Mixed, required: true }, // The full Baileys message object
  createdAt: { type: Date, default: Date.now, index: { expires: '2d' } } // Auto-delete after 2 days
});
MessageSchema.index({ id: 1, chatId: 1 }, { unique: true });

const userData = db1.model("UserData", UserSchema);
const groupData = db1.model("GroupData", GroupSchema);
const contactData = db1.model("ContactData", ContactSchema);
const messageData = db1.model("MessageData", MessageSchema);

const systemData = db2.model("SystemData", CoreSchema);
const pluginData = db2.model("PluginData", PluginSchema);

export { userData, groupData, systemData, pluginData, contactData, messageData };
