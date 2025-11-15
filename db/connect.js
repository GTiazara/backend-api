const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const CONNECTION_STRING = process.env.ATLAS_URI;

if (!CONNECTION_STRING) {
  console.warn("⚠️ Warning: ATLAS_URI is not defined. MongoDB will fail until provided.");
}

let cachedClient = null;
let cachedDb = null;

async function getClient(options = {}) {
  if (cachedClient) return cachedClient;

  if (!CONNECTION_STRING) {
    throw new Error("ATLAS_URI is missing in environment variables.");
  }

  const client = new MongoClient(CONNECTION_STRING, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
    ...options,
  });

  await client.connect();
  cachedClient = client;
  return client;
}

async function connectToDb(dbName, collectionName, options = {}) {
  if (!dbName) throw new Error("dbName is required.");

  const { validatorObject = null, createIfMissing = true, clientOptions = {} } = options;

  const client = await getClient(clientOptions);
  const db = cachedDb || client.db(dbName);
  cachedDb = db;

  let collection = null;
  if (collectionName) {
    const exists = await db.listCollections({ name: collectionName }).toArray();

    if (exists.length === 0 && createIfMissing) {
      const collOptions = {};
      if (validatorObject) {
        collOptions.validator = validatorObject.$jsonSchema ? validatorObject : { $jsonSchema: validatorObject };
      }
      await db.createCollection(collectionName, collOptions);
      collection = db.collection(collectionName);
    } else {
      collection = db.collection(collectionName);
    }
  }

  return { client, db, collection };
}

module.exports = { connectToDb, getClient };
