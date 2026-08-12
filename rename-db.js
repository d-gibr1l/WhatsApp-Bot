import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB, { family: 4 });
  console.log("Connected to MongoDB for rename");
  
  // Update sessionschemas collection
  const result = await mongoose.connection.db.collection('sessionschemas').updateMany(
    { sessionId: "DOMINIC-ATLAS-MD-12345" },
    { $set: { sessionId: "DOMINIC-HOOPER-MD-12345" } }
  );
  
  console.log(`Updated ${result.modifiedCount} session documents.`);
  process.exit(0);
};
run();
