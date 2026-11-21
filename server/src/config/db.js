import mongoose from "mongoose";

export async function connectDb(uri) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoCreate: false,
    autoIndex: false,
  });
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
