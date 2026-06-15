/**
 * MongoDB adapter - production-grade with collection-level permissions.
 *
 * Auth: API key style - credentials hold a Mongo connection string
 * (mongodb:// or mongodb+srv://). Works with Mongo Atlas, self-hosted,
 * AWS DocumentDB.
 *
 * Permissions (`config`):
 *   {
 *     dbName: string,
 *     allowReads:   string[]   // collection names readable
 *     allowWrites:  string[]   // collection names writable (subset of reads)
 *     allowDeletes: string[]
 *     maxDocs: number          // hard cap on returned docs (default 100)
 *   }
 *
 * Tools - every operation enforces the allowlist + uses the official driver
 * to avoid query-string injection.
 *
 *   - mongodb.find_documents      - { filter, limit, sort, projection }
 *   - mongodb.get_document        - { _id }
 *   - mongodb.insert_document     - { doc }
 *   - mongodb.update_document     - { _id, set }
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

let mongoModulePromise: Promise<any> | null = null;
async function mongoLib(): Promise<any> {
  if (!mongoModulePromise) {
    mongoModulePromise = (async () => {
      try {
        return await import("mongodb");
      } catch {
        throw new Error("mongodb_module_not_installed: run `npm install mongodb` in services/ai");
      }
    })();
  }
  return mongoModulePromise;
}

const CLIENTS = new Map<string, any>();

const TOOLS: ToolDefinition[] = [
  {
    name: "mongodb.find_documents",
    description: "Query documents from a whitelisted collection.",
    whenToUse: "You need a list of documents matching a filter - e.g. orders for an email.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        filter: { type: "object", description: "Mongo filter document." },
        limit: { type: "number", description: "Default 20, capped by tenant policy." },
        sort: { type: "object", description: "Sort spec, e.g. { createdAt: -1 }." },
        projection: { type: "object", description: "Projection spec." },
      },
      required: ["collection"],
    },
  },
  {
    name: "mongodb.get_document",
    description: "Fetch a document by _id.",
    whenToUse: "You have a known _id (string or ObjectId hex).",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        _id: { description: "Document _id - string OR 24-hex ObjectId." },
      },
      required: ["collection", "_id"],
    },
  },
  {
    name: "mongodb.insert_document",
    description: "Insert one document into a writable collection.",
    whenToUse: "Recording a new event/lead/order in Mongo.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        doc: { type: "object", description: "Document to insert." },
      },
      required: ["collection", "doc"],
    },
  },
  {
    name: "mongodb.update_document",
    description: "Update one document by _id with $set.",
    whenToUse: "Patching a known document.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        _id: {},
        set: { type: "object" },
      },
      required: ["collection", "_id", "set"],
    },
  },
];

const MongoAdapter: ProviderAdapter = {
  slug: "mongodb",
  tools: () => TOOLS,

  async execute({ ctx, toolName, args, credentials, config }) {
    const connStr = credentials.connectionString || credentials.connection_string;
    if (!connStr) throw new Error("no_connection_string");
    const dbName = config.dbName || credentials.dbName;
    if (!dbName) throw new Error("dbName_not_configured");

    const allowReads: string[] = Array.isArray(config.allowReads) ? config.allowReads : [];
    const allowWrites: string[] = Array.isArray(config.allowWrites) ? config.allowWrites : [];
    const maxDocs: number = Number(config.maxDocs ?? 100);

    const collectionName = String(args.collection || "");
    const isRead = toolName === "find_documents" || toolName === "get_document";
    const isWrite = toolName === "insert_document" || toolName === "update_document";
    if (isRead && !allowReads.includes(collectionName)) {
      throw new Error(`collection_not_in_read_allowlist:${collectionName}`);
    }
    if (isWrite && !allowWrites.includes(collectionName)) {
      throw new Error(`collection_not_in_write_allowlist:${collectionName}`);
    }

    const { client, ObjectId } = await getClient(ctx.tenantIntegrationId, connStr);
    const db = client.db(dbName);
    const col = db.collection(collectionName);

    function coerceId(v: any): any {
      if (typeof v === "string" && /^[a-f0-9]{24}$/i.test(v)) {
        try { return new ObjectId(v); } catch { return v; }
      }
      return v;
    }

    switch (toolName) {
      case "find_documents": {
        const limit = Math.min(maxDocs, Number(args.limit ?? 20));
        const cursor = col.find(args.filter || {}, {
          projection: args.projection,
        }).limit(limit);
        if (args.sort) cursor.sort(args.sort);
        return await cursor.toArray();
      }
      case "get_document":
        return await col.findOne({ _id: coerceId(args._id) });
      case "insert_document": {
        const r = await col.insertOne(args.doc);
        return { _id: r.insertedId };
      }
      case "update_document": {
        const r = await col.updateOne(
          { _id: coerceId(args._id) },
          { $set: args.set },
        );
        return { matched: r.matchedCount, modified: r.modifiedCount };
      }
      default:
        throw new Error(`unknown_mongodb_tool:${toolName}`);
    }
  },
};

async function getClient(key: string, connStr: string): Promise<{ client: any; ObjectId: any }> {
  let cached = CLIENTS.get(key);
  if (cached) return cached;
  const { MongoClient, ObjectId } = await mongoLib();
  const client = new MongoClient(connStr, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  cached = { client, ObjectId };
  CLIENTS.set(key, cached);
  return cached;
}

registerAdapter(MongoAdapter);
export default MongoAdapter;
