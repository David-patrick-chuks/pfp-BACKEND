const mongoose = require("mongoose");

// Function to drop all databases using Mongoose
async function dropAllDatabasesWithMongoose(uri) {
  const connection = mongoose.createConnection(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  try {
    // Connect to the MongoDB server
    await connection.asPromise();
    console.log("Connected to MongoDB server");

    // Use the underlying MongoDB driver to list databases
    const adminDb = connection.db.admin();
    const dbList = await adminDb.listDatabases();
    const databases = dbList.databases.map((db) => db.name);
    console.log("Databases:", databases);

    if (databases.length === 0) {
      console.log("No databases found on this server.");
      return;
    }

    console.log("Available databases:", databases);

    // Filter out system databases
    const systemDatabases = ["admin", "local", "config"];
    const userDatabases = databases.filter(
      (dbName) => !systemDatabases.includes(dbName)
    );

    if (userDatabases.length === 0) {
      console.log(
        "No user databases found to drop (system databases will not be dropped)."
      );
      return;
    }

    console.log("User databases to drop:", userDatabases);

    // Drop each user database
    for (const dbName of userDatabases) {
      const db = connection.useDb(dbName);
      await db.dropDatabase();
      console.log(`Dropped database: ${dbName}`);
    }

    console.log("All user databases have been dropped successfully.");
  } catch (error) {
    console.error("Error dropping MongoDB databases:", error.message);
    throw error;
  } finally {
    await connection.close();
    console.log("MongoDB connection closed.");
  }
}

// Example usage
(async () => {
  try {
    const uri =
      // "mongodb+srv://pd3072894:5drZWpuq9YNQMSXj@cluster0.5rrseq1.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
      "mongodb+srv://pd3072894:2yHZdEg6b99VsSV8@cluster0.p6k6pqf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
    await dropAllDatabasesWithMongoose(uri);
  } catch (error) {
    console.error("Failed to drop databases:", error.message);
  }
})();
