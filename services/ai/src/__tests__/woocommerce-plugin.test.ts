/**
 * ★ "GOTCHA for WooCommerce", the backend side (docs/api/woocommerce-plugin-v1.md).
 * Through the real routes:
 *   - bind: only the store the workspace is connected to, back only to that
 *     store's /wp-admin/, with the plugin's nonce; a single-use code
 *   - exchange: the code once, for the widget id and a site key shown once
 *     (only its hash is kept); reconnecting revokes the old key
 *   - signals: unknown key 401; one heartbeat a day; deactivated / removed;
 *     an uninstall revokes the key; the key index is rebuilt from the setting
 *   - the zip: the plugin's files in their folder, a valid archive
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const H = vi.hoisted(() => ({
  redis: new Map<string, string>(), settings: new Map<string, string>(), allowed: true,
  integration: { config: { storeUrl: "https://shop.example.com" } } as any, webchat: { externalId: "widget_abc" } as any,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const redis = {
    get: async (k: string) => H.redis.get(k) ?? null,
    set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
    del: async (k: string) => { H.redis.delete(k); return 1; },
    multi: () => {
      const ops: Array<() => any> = [];
      const m = { get: (k: string) => { ops.push(() => H.redis.get(k) ?? null); return m; }, del: (k: string) => { ops.push(() => { H.redis.delete(k); return 1; }); return m; }, exec: async () => ops.map((op) => [null, op()]) };
      return m;
    },
  };
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, res: any, n: any) => (H.allowed ? n() : res.status(403).json({ error: "forbidden" })),
    resolveAppPublicUrl: () => "https://app.test",
    getRedis: () => redis,
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
    writeDurableSetting: async (t: string, k: string, v: string) => { H.settings.set(`${t}:${k}`, v); },
    prisma: {
      tenantIntegration: { findFirst: async () => H.integration },
      channelAccount: { findFirst: async () => H.webchat },
      tenant: { findUnique: async () => ({ name: "Urban Supply" }) },
      $queryRaw: async (_s: TemplateStringsArray, key: string, like: string) => {
        const needle = like.replace(/%/g, "");
        return [...H.settings.entries()].filter(([k, v]) => k.endsWith(`:${key}`) && v.includes(needle)).map(([k]) => ({ tenant_id: k.split(":")[0] }));
      },
    },
  };
});

import router, { pluginZip } from "../routes/woocommerce-plugin";
import { crc32 } from "../lib/zip";

const app = express();
app.use("/api/woocommerce-plugin", router);
const RETURN = "https://shop.example.com/wp-admin/admin.php?page=gotcha-for-woocommerce";
const bind = (o: any = {}) => request(app).post("/api/woocommerce-plugin/bind").send({ siteUrl: "https://shop.example.com/", returnUrl: RETURN, nonce: "n0nce-abcdefgh", ...o });
const exchange = (code: string, siteUrl = "https://shop.example.com") => request(app).post("/api/woocommerce-plugin/exchange").send({ code, siteUrl });
const sig = (key: string, event: string) => request(app).post("/api/woocommerce-plugin/signal").set("Authorization", `Bearer ${key}`).send({ event, pluginVersion: "0.1.0", wpVersion: "6.8", wcVersion: "9.1" });
const sites = () => JSON.parse(H.settings.get("T:woocommerce_plugin_sites") ?? "[]");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const codeOf = (redirect: string) => new URL(redirect).searchParams.get("gotcha_code")!;

async function connect(): Promise<string> {
  const b = await bind();
  return (await exchange(codeOf(b.body.data.redirect))).body.siteKey;
}

beforeEach(() => {
  H.redis = new Map(); H.settings = new Map(); H.allowed = true;
  H.integration = { config: { storeUrl: "https://shop.example.com" } };
  H.webchat = { externalId: "widget_abc" };
});

describe("★ bind", () => {
  it("a single-use code back to the store's own admin page, with the plugin's nonce", async () => {
    const r = await bind();
    expect(r.status).toBe(200);
    const u = new URL(r.body.data.redirect);
    expect(u.origin + u.pathname).toBe("https://shop.example.com/wp-admin/admin.php");
    expect(u.searchParams.get("page")).toBe("gotcha-for-woocommerce");
    expect(u.searchParams.get("nonce")).toBe("n0nce-abcdefgh");
    expect(u.searchParams.get("gotcha_code")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it.each([
    ["a store the workspace is not connected to", { siteUrl: "https://other.example.com" }, 409, "STORE_NOT_CONNECTED"],
    ["a return outside the store", { returnUrl: "https://evil.example/wp-admin/x" }, 422, "BAD_RETURN_URL"],
    ["a return outside /wp-admin/", { returnUrl: "https://shop.example.com/checkout" }, 422, "BAD_RETURN_URL"],
    ["a malformed nonce", { nonce: "x" }, 422, "BAD_NONCE"],
  ])("refused: %s", async (_n, o, status, code) => {
    const r = await bind(o);
    expect([r.status, r.body.code]).toEqual([status, code]);
  });

  it("no WooCommerce connection, or no web chat yet", async () => {
    H.integration = null;
    expect((await bind()).body.code).toBe("STORE_NOT_CONNECTED");
    H.integration = { config: { storeUrl: "https://shop.example.com" } }; H.webchat = null;
    expect((await bind()).body.code).toBe("WIDGET_NOT_CREATED");
  });

  it("needs the permission to connect systems", async () => {
    H.allowed = false;
    expect((await bind()).status).toBe(403);
  });
});

describe("★ exchange", () => {
  it("the code once: the widget id and a site key shown once (only its hash is kept)", async () => {
    const code = codeOf((await bind()).body.data.redirect);
    const r = await exchange(code);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ widgetId: "widget_abc", apiUrl: "https://app.test", scriptUrl: "https://app.test/widget/chatcenter-widget.js", workspaceName: "Urban Supply" });
    expect(r.body.siteKey).toMatch(/^gws_/);
    expect(JSON.stringify(sites())).not.toContain(r.body.siteKey);
    expect(sites()[0]).toMatchObject({ siteUrl: "https://shop.example.com", status: "connected", keyHash: crypto.createHash("sha256").update(r.body.siteKey).digest("hex") });
    expect((await exchange(code)).body.code).toBe("CODE_EXPIRED");
  });

  it("another site's code is refused", async () => {
    const code = codeOf((await bind()).body.data.redirect);
    expect((await exchange(code, "https://other.example.com")).body.code).toBe("SITE_MISMATCH");
  });

  it("reconnecting the same site: one site, the old key stops working (its index entry is gone)", async () => {
    const first = await connect();
    const second = await connect();
    expect(sites()).toHaveLength(1);
    expect(H.redis.has(`wcplugin:key:${sha(first)}`)).toBe(false);
    expect(H.redis.has(`wcplugin:key:${sha(second)}`)).toBe(true);
    expect((await sig(first, "heartbeat")).status).toBe(401);
    expect((await sig(second, "deactivated")).status).toBe(204);
  });
});

describe("★ signals", () => {
  it("an unknown key is 401", async () => {
    expect((await sig("gws_nope", "heartbeat")).status).toBe(401);
    expect((await sig("not-a-key", "heartbeat")).status).toBe(401);
  });

  it("deactivated, then activated; versions recorded; one heartbeat a day", async () => {
    const key = await connect();
    await sig(key, "deactivated");
    expect(sites()[0]).toMatchObject({ status: "deactivated", pluginVersion: "0.1.0", wpVersion: "6.8", wcVersion: "9.1" });
    await sig(key, "activated");
    expect(sites()[0].status).toBe("connected");
    const seen = sites()[0].lastSeenAt;
    await sig(key, "heartbeat");
    expect(sites()[0].lastSeenAt).toBe(seen);
  });

  it("★ an uninstall revokes the key", async () => {
    const key = await connect();
    expect((await sig(key, "uninstalled")).status).toBe(204);
    expect(sites()[0].status).toBe("removed");
    expect(H.redis.has(`wcplugin:key:${sha(key)}`)).toBe(false);
    expect((await sig(key, "heartbeat")).status).toBe(401);
  });

  it("a removed site's key is refused even if its index entry survived", async () => {
    const key = await connect();
    await sig(key, "uninstalled");
    H.redis.set(`wcplugin:key:${sha(key)}`, "T");
    expect((await sig(key, "heartbeat")).status).toBe(401);
  });

  it("the key index is rebuilt from the setting when Redis lost it", async () => {
    const key = await connect();
    for (const k of [...H.redis.keys()]) if (k.startsWith("wcplugin:key:")) H.redis.delete(k);
    expect((await sig(key, "deactivated")).status).toBe(204);
    expect([...H.redis.keys()].some((k) => k.startsWith("wcplugin:key:"))).toBe(true);
  });

  it("an unknown event is refused", async () => {
    const key = await connect();
    expect((await sig(key, "explode")).status).toBe(422);
  });
});

describe("removing a site from GOTCHA", () => {
  it("removed; the plugin's next signal is 401", async () => {
    const key = await connect();
    const id = sites()[0].id;
    expect((await request(app).delete(`/api/woocommerce-plugin/sites/${id}`)).status).toBe(200);
    expect((await sig(key, "heartbeat")).status).toBe(401);
    expect((await request(app).delete("/api/woocommerce-plugin/sites/nope")).status).toBe(404);
  });
});

describe("★ the zip", () => {
  it("the plugin's files in their folder, a valid archive", async () => {
    const r = await request(app).get("/api/woocommerce-plugin/download").buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toContain("gotcha-for-woocommerce.zip");
    const zip: Buffer = r.body;
    // Walk the local headers and check every entry against its CRC.
    const names: string[] = [];
    let at = 0;
    while (zip.readUInt32LE(at) === 0x04034b50) {
      const crc = zip.readUInt32LE(at + 14), size = zip.readUInt32LE(at + 18), nameLen = zip.readUInt16LE(at + 26);
      const name = zip.subarray(at + 30, at + 30 + nameLen).toString("utf8");
      const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
      expect(crc32(data), name).toBe(crc);
      names.push(name);
      at += 30 + nameLen + size;
    }
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(names).toEqual(["gotcha-for-woocommerce/gotcha-for-woocommerce.php", "gotcha-for-woocommerce/readme.txt", "gotcha-for-woocommerce/uninstall.php"]);
    expect(pluginZip("https://app.test").equals(zip)).toBe(true);
  });

  it("★ the served plugin talks to the GOTCHA that served it (a dev install never reaches production)", () => {
    const php = (origin: string) => {
      const zip = pluginZip(origin);
      const nameLen = zip.readUInt16LE(26), size = zip.readUInt32LE(18);
      return zip.subarray(30 + nameLen, 30 + nameLen + size).toString("utf8"); // the first entry: the main PHP file
    };
    const dev = php("https://dev.gotcha.co.il");
    expect(dev).toContain("define( 'GOTCHA_APP_URL', 'https://dev.gotcha.co.il' );");
    expect(dev).not.toContain("__GOTCHA_APP_URL__");
    expect(dev).not.toContain("app.gotcha.co.il");
    expect(php("https://app.gotcha.co.il/")).toContain("define( 'GOTCHA_APP_URL', 'https://app.gotcha.co.il' );");
    expect(() => pluginZip("")).toThrow();
  });

  it("\"Open in GOTCHA\" goes to the website chat settings (the page that exists)", () => {
    const zip = pluginZip("https://dev.gotcha.co.il").toString("utf8");
    expect(zip).toContain("'/v2/settings/channels/website'");
    expect(zip).not.toContain("'/v2/widgets'");
  });

  it("crc32 is the standard one", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
