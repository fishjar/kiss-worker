/**
 * KISS-Translator 同步服务的 Cloudflare Worker 实现。
 *
 * 对外继续提供 POST /sync 与 GET /rules?psk=...，请求字段、摘要算法和成功响应均与
 * 旧版 KV Worker 保持一致。内部则按业务 key 路由到独立的 SyncObject Durable Object，
 * 在对象内串行完成读取、版本比较和写入。每个对象首次访问时会从原 KV 命名空间懒迁移
 * 同名记录，因此现有 Worker 可以原地升级，无需客户端更换地址或重新上传数据。
 */
import { DurableObject } from "cloudflare:workers";
import { mirrorWords } from "./mirror.js";

// 固定盐、分享记录 key 均属于已发布客户端协议，修改会使现有密钥或分享链接失效。
const KV_SALT_SYNC = "KISS-Translator-SYNC";
const KV_SALT_SHARE = "KISS-Translator-SHARE";
const KV_RULES_SHARE_KEY = "kiss-rules-share.json";
// KISS-Translator 生词本同步键；命中该键时触发 TypeWords 镜像。
const KV_WORDS_KEY = "kiss-words.json";

// 每个 Durable Object 只管理一个业务 key，因此对象存储中使用固定内部键即可。
const RECORD_STORAGE_KEY = "record";
// 与旧 Cloudflare KV 的 key 上限对齐，保证升级前后的合法输入集合一致。
const MAX_KEY_BYTES = 512;
// updateAt 必须能被 JavaScript Number 与 Go int64 双方无损处理。
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
// 低于该阈值的正整数视为旧 Go 后端产生的秒级时间戳。
const LEGACY_SECONDS_CUTOFF = 100_000_000_000;

// 浏览器扩展和用户脚本需要跨站访问同步服务，因此保留既有的开放 CORS 行为。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * 生成具有统一 CORS 与 JSON Content-Type 的响应。
 * init 中显式提供的响应头最后合并，便于调用方在不丢失公共头的情况下覆盖默认值。
 */
function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...corsHeaders,
      "content-type": "application/json;charset=UTF-8",
      ...init.headers,
    },
  });
}

/**
 * 将历史秒级 Unix 时间戳转换为当前客户端使用的毫秒时间戳。
 * updateAt=0 是“首次同步”标记，必须保持为零；现代毫秒值也不得重复放大。
 */
function normalizeUpdateAt(updateAt) {
  if (
    Number.isSafeInteger(updateAt) &&
    updateAt > 0 &&
    updateAt < LEGACY_SECONDS_CUTOFF
  ) {
    return updateAt * 1000;
  }
  return updateAt;
}

/**
 * 校验业务 key。TextEncoder 按 UTF-8 字节数计算长度，避免非 ASCII key 绕过存储限制。
 */
function isValidKey(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    new TextEncoder().encode(key).byteLength <= MAX_KEY_BYTES
  );
}

/**
 * 校验 /sync 的完整协议记录。
 * value 被视为不透明字符串，既可以是旧版明文 JSON，也可以是客户端生成的加密 envelope；
 * Object.prototype.hasOwnProperty.call 可避免请求中的同名字段覆盖实例方法。
 */
function isValidRecord(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Object.prototype.hasOwnProperty.call(data, "key") &&
    Object.prototype.hasOwnProperty.call(data, "value") &&
    Object.prototype.hasOwnProperty.call(data, "updateAt") &&
    isValidKey(data.key) &&
    typeof data.value === "string" &&
    Number.isSafeInteger(data.updateAt) &&
    data.updateAt >= 0 &&
    data.updateAt <= MAX_SAFE_INTEGER
  );
}

/**
 * 实现客户端既有的 SHA256(text + salt) 十六进制摘要算法。
 * 拼接顺序和盐值属于协议的一部分，不应在服务端单独调整。
 */
async function sha256(text, salt) {
  const data = new TextEncoder().encode(text + salt);
  const digest = await crypto.subtle.digest({ name: "SHA-256" }, data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 使用原始业务 key 获取唯一且稳定的 Durable Object stub。
 * 相同 key 始终路由到同一对象，不同 key 的同步互不阻塞。
 */
function getSyncObject(env, key) {
  const id = env.SYNC_OBJECT.idFromName(key);
  return env.SYNC_OBJECT.get(id);
}

/**
 * 调用 Durable Object 的内部接口。
 * 这里的 /sync 和 /get 仅用于 Worker 与对象之间通信，不属于对客户端公开的 HTTP API。
 */
async function callSyncObject(env, operation, data) {
  const stub = getSyncObject(env, data.key);
  return stub.fetch(`https://sync.internal/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * 处理 CORS 预检和普通 OPTIONS 请求，保持旧 Worker 的响应头与允许方法不变。
 */
function handleOptions(request) {
  if (
    request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null &&
    request.headers.get("Access-Control-Request-Headers") !== null
  ) {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Headers": request.headers.get(
          "Access-Control-Request-Headers"
        ),
      },
    });
  }
  return new Response(null, {
    headers: { Allow: "GET, HEAD, POST, OPTIONS" },
  });
}

/**
 * 按单个业务 key 保存权威同步记录的 Durable Object。
 *
 * Durable Object 能保证同一对象只位于一个位置，但异步事件仍可能在 await 处交错；显式 Promise
 * 队列让完整的“KV 懒迁移、读取、比较、写入”按到达顺序执行，防止较旧时间戳覆盖较新数据。
 */
export class SyncObject extends DurableObject {
  /** 初始化对象内的请求串行队列；队列本身无需持久化，权威记录保存在对象存储中。 */
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
  }

  /**
   * 将事件追加到串行队列。即使前一个请求失败，也只向该请求返回错误，并通过 catch 恢复队列，
   * 避免后续合法请求永久被一个 rejected Promise 阻断。
   */
  fetch(request) {
    const result = this.queue.then(() => this.handleRequest(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * 读取对象中的权威记录；对象尚无记录时，从旧 KV 同名 key 懒迁移。
   * KV 中的 value 原样保存，metadata.updateAt 只做时间单位兼容。value 为空字符串仍是有效数据，
   * 因此必须用 value === null 判断“不存在”，不能使用真值判断。
   */
  async loadRecord(key) {
    let record = await this.ctx.storage.get(RECORD_STORAGE_KEY);
    if (record !== undefined) {
      return record;
    }
    // 对象存储一旦存在记录便不再读取 KV，避免迁移后被旧 KV 数据反向覆盖。
    const { value, metadata } = await this.env.KV.getWithMetadata(key);
    if (value === null) {
      return null;
    }

    const legacyUpdateAt = normalizeUpdateAt(metadata?.updateAt ?? 0);
    record = {
      key,
      value,
      updateAt: Number.isSafeInteger(legacyUpdateAt) ? legacyUpdateAt : 0,
    };
    await this.ctx.storage.put(RECORD_STORAGE_KEY, record);
    return record;
  }

  /**
   * 处理 Worker 发来的内部 POST 请求。
   * /get 只读取或触发迁移；/sync 按 remote.updateAt >= request.updateAt 的既有规则解决冲突。
   * 当远端不存在且 updateAt=0 时，才由服务端生成当前毫秒时间戳。
   */
  async handleRequest(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const data = await request.json();
    if (!isValidKey(data?.key)) {
      return new Response("Fields Error.", { status: 400 });
    }

    if (pathname === "/get") {
      const record = await this.loadRecord(data.key);
      return jsonResponse(record);
    }

    if (pathname !== "/sync" || !isValidRecord(data)) {
      return new Response("Fields Error.", { status: 400 });
    }
    // 相同时间戳也返回远端值，保持现有客户端的确定性冲突处理规则。
    const current = await this.loadRecord(data.key);
    if (current !== null && current.updateAt >= data.updateAt) {
      return jsonResponse(current);
    }

    const next = {
      key: data.key,
      value: data.value,
      updateAt: data.updateAt === 0 ? Date.now() : data.updateAt,
    };
    await this.ctx.storage.put(RECORD_STORAGE_KEY, next);
    return jsonResponse(next);
  }
}

/**
 * Worker 对外入口。鉴权和输入校验在边缘入口完成，Durable Object 只接收内部调用。
 * 捕获异常时返回固定错误文本，避免将 KV、对象存储或运行时内部信息暴露给客户端。
 */
export default {
  async fetch(request, env, ctx) {
    // AUTH_VALUE 是部署必需的 Secret；缺失时拒绝提供一个看似可用但无法鉴权的服务。
    if (!env.AUTH_VALUE) {
      return new Response("Must set AUTH_VALUE environment.", { status: 503 });
    }

    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "POST" && pathname === "/sync") {
      // /sync 使用 Authorization Bearer 摘要，保持 KISS-Translator 当前请求协议不变。
      const expectPsk = `Bearer ${await sha256(env.AUTH_VALUE, KV_SALT_SYNC)}`;
      if (request.headers.get("Authorization") !== expectPsk) {
        return new Response("Sorry, you have supplied an invalid key.", {
          status: 403,
        });
      }

      try {
        const data = await request.json();
        if (!isValidRecord(data)) {
          return new Response("Fields Error.", { status: 400 });
        }
        // 外部请求通过验证后才转发到按 key 隔离的内部对象。
        const response = await callSyncObject(env, "sync", data);
        if (!response.ok) {
          return new Response("Fields Error.", { status: response.status });
        }
        const record = await response.json();
        // 生词本同步成功后，异步镜像到 TypeWords（Supabase），不阻塞客户端响应。
        if (data.key === KV_WORDS_KEY && ctx?.waitUntil) {
          ctx.waitUntil(mirrorWords(env, record.value));
        }
        return jsonResponse(record);
      } catch {
        return new Response("Unknown Error", { status: 500 });
      }
    }

    if (request.method === "GET" && pathname === "/rules") {
      // psk 继续使用查询参数是分享链接的兼容要求；变更位置会使所有现有链接失效。
      if (!searchParams.has("psk")) {
        return new Response("Missing query parameter", { status: 403 });
      }

      const expectPsk = await sha256(env.AUTH_VALUE, KV_SALT_SHARE);
      if (searchParams.get("psk") !== expectPsk) {
        return new Response("Sorry, you have supplied an invalid key.", {
          status: 403,
        });
      }

      try {
        // 分享规则也走同一个对象存储路径，因此旧 KV 规则会在首次读取时自动迁移。
        const response = await callSyncObject(env, "get", {
          key: KV_RULES_SHARE_KEY,
        });
        const record = await response.json();
        if (record === null) {
          return new Response("Empty data", { status: 500 });
        }
        // 先解析再格式化，延续旧接口返回可读 JSON 且拒绝损坏规则数据的行为。
        return new Response(JSON.stringify(JSON.parse(record.value), null, 2), {
          headers: {
            ...corsHeaders,
            "content-type": "application/json;charset=UTF-8",
          },
        });
      } catch {
        return new Response("Unknown Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
