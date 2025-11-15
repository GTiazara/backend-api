const { MongoClient, ServerApiVersion } = require('mongodb');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONNECTION_STRING = process.env.ATLAS_URI;

if (!CONNECTION_STRING) {
  // Don't exit here; throw when connect is attempted so library can be imported safely in tests.
  // But log a warning to help users configure environment.
  console.warn('Warning: ATLAS_URI not set. connectToDb will fail until ATLAS_URI is provided.');
}

let _client = null;
let _connected = false;

const defaultClientOptions = {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
};

/**
 * Reads a validator object from a JSON file path.
 * Accepts an absolute path or a path relative to project root.
 */
function readValidatorFromFile(filePath) {
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) return null;

  const raw = fs.readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in validator file ${resolved}: ${err.message}`);
  }
}

/**
 * Ensure a single MongoClient is created and connected.
 */
async function getClient(clientOptions = {}) {
  if (_connected && _client) return _client;

  if (!_client) {
    if (!CONNECTION_STRING) throw new Error('ATLAS_URI not configured in environment');
    _client = new MongoClient(CONNECTION_STRING, Object.assign({}, defaultClientOptions, clientOptions));
  }

  await _client.connect();
  _connected = true;
  return _client;
}

/**
 * Connect to a database, optionally ensure a collection exists and apply a validator.
 *
 * Params:
 *   dbName (string) - required
 *   collectionName (string) - optional. If provided and collection doesn't exist it will be created when createIfMissing=true
 *   options (object) - optional fields:
 *     - validatorFilePath (string) - path to JSON file containing either a full {"$jsonSchema": {...}} or the jsonSchema object
 *     - validatorObject (object) - an object representing the validator (overrides file)
 *     - createIfMissing (bool, default true)
 *     - clientOptions (object) - options passed into MongoClient (merges with defaults)
 *
 * Returns: { client, db, collection (or null if not requested) }
 */
async function connectToDb(dbName, collectionName, options = {}) {
  if (!dbName) throw new Error('dbName is required');

  const { validatorFilePath, validatorObject, createIfMissing = true, clientOptions = {} } = options;

  const client = await getClient(clientOptions);
  const db = client.db(dbName);

  let collection = null;
  if (collectionName) {
    const existing = await db.listCollections({ name: collectionName }).toArray();

    if (existing.length === 0) {
      if (!createIfMissing) {
        collection = db.collection(collectionName);
      } else {
        // compose validator
        let validator = validatorObject || readValidatorFromFile(validatorFilePath);
        // If validator is null, create without validator
        if (validator) {
          // If the file contains the $jsonSchema wrapper, use it directly, otherwise wrap
          const validatorHasWrapper = Object.prototype.hasOwnProperty.call(validator, '$jsonSchema');
          const validatorOption = validatorHasWrapper ? validator : { $jsonSchema: validator };

          await db.createCollection(collectionName, { validator: validatorOption });
        } else {
          await db.createCollection(collectionName);
        }
        collection = db.collection(collectionName);
      }
    } else {
      collection = db.collection(collectionName);
    }
  }

  return { client, db, collection };
}

async function closeClient() {
  if (_client) {
    await _client.close();
    _client = null;
    _connected = false;
  }
}

module.exports = {
  connectToDb,
  getClient,
  closeClient,
  // exported for testing
  _readValidatorFromFile: readValidatorFromFile,
};
