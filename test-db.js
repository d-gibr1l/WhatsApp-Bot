import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB, { family: 4 });
  console.log("Connected to MongoDB");
  const collections = await mongoose.connection.db.listCollections().toArray();
  console.log("Collections:", collections.map(c => c.name));
  
  for (const coll of collections) {
    const docs = await mongoose.connection.db.collection(coll.name).find({}).toArray();
    let hooperCount = 0;
    for (const doc of docs) {
      const str = JSON.stringify(doc);
      if (str.toLowerCase().includes("hooper")) {
        hooperCount++;
      }
    }
    if (hooperCount > 0) {
      console.log(`Collection ${coll.name} has ${hooperCount} docs containing 'hooper'`);
    }
  }
  process.exit(0);
};
run();
