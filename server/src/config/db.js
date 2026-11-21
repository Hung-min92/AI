import dns from "node:dns";
import mongoose from "mongoose";

export function configureDnsServers(servers) {
  dns.setServers(servers);
}

export async function connectDb(uri) {
  configureDnsServers(["8.8.8.8", "1.1.1.1"]);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoCreate: false,
    autoIndex: false,
  });
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
