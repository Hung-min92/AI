const maxTransactionAttempts = 3;

export class ProjectTransactionUnavailableError extends Error {}

export async function runProjectTransaction(projectModel, work) {
  let attempts = 0;
  try {
    return await projectModel.db.transaction(async (session) => {
      if (attempts >= maxTransactionAttempts) {
        throw new ProjectTransactionUnavailableError("Project transaction retry limit reached.");
      }
      attempts++;
      return await work(session);
    }, {
      readPreference: "primary",
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      maxCommitTimeMS: 5_000,
    });
  } catch (error) {
    if (error?.hasErrorLabel?.("TransientTransactionError") ||
        error?.hasErrorLabel?.("UnknownTransactionCommitResult") ||
        ["MongoServerSelectionError", "MongoOperationTimeoutError",
          "MongoNetworkError", "MongoNetworkTimeoutError"].includes(error?.name)) {
      throw new ProjectTransactionUnavailableError("Project transaction could not be confirmed.");
    }
    throw error;
  }
}

export async function touchOwnedProject(projectModel, filter, session) {
  if (!session?.inTransaction()) throw new Error("An active Project transaction is required.");
  const result = await projectModel.updateOne(
    { _id: filter._id, owner: filter.owner },
    { $inc: { taskLinkVersion: 1 } },
    { session, timestamps: false },
  );
  if (!result.acknowledged) throw new Error("Project coordination write was not acknowledged.");
  return result.matchedCount === 1;
}
