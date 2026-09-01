import { model, Schema } from "mongoose";

const schema = new Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  files: {
    type: Schema.Types.Mixed,
    default: {},
  },
  // Legacy single-blob session format (pre file-based storage). Declared so
  // Mongoose actually exposes it on hydrated docs — without this, `doc.session`
  // reads as undefined even when the field exists in MongoDB, which silently
  // broke migration of old sessions (MongoAuth._migrateLegacySession).
  session: {
    type: String,
    default: null,
  },
  lastSync: {
    type: Date,
    default: null,
  },
});

export default model("sessionschemas", schema);
