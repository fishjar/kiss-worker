/**
 * 把 KISS-Translator 生词本镜像到 TypeWords（Supabase typewords_data）。
 * 仅在 /sync 处理 kiss-words.json 时被调用，best-effort，失败不影响主同步。
 *
 * 依赖三个环境变量/Secret：
 *   - SYNC_ENCRYPT_KEY          kiss-translator 的「同步端到端加密口令」
 *   - SUPABASE_URL              Supabase 项目地址，如 https://xxx.supabase.co
 *   - SUPABASE_SERVICE_ROLE_KEY Supabase service_role key
 */

const SYNC_CRYPTO_VERSION = 1;
const SYNC_CRYPTO_ALG = "AES-GCM";
const SYNC_CRYPTO_KDF = "PBKDF2-SHA-256";
const SYNC_CRYPTO_ITERATIONS = 100000;

const te = new TextEncoder();
const td = new TextDecoder();

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 与 kiss-translator src/libs/syncCrypto.js 完全一致。
async function decryptSyncValue(value, syncEncryptKey) {
  let envelope = null;
  try {
    envelope = JSON.parse(value);
  } catch {
    envelope = null;
  }
  if (!envelope || envelope.encrypted !== true) return value; // 旧版明文

  if (
    envelope.version !== SYNC_CRYPTO_VERSION ||
    envelope.alg !== SYNC_CRYPTO_ALG ||
    envelope.kdf !== SYNC_CRYPTO_KDF ||
    envelope.iterations !== SYNC_CRYPTO_ITERATIONS
  ) {
    throw new Error("Unsupported sync encryption format");
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    te.encode(syncEncryptKey),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(envelope.salt),
      iterations: SYNC_CRYPTO_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: SYNC_CRYPTO_ALG, length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: SYNC_CRYPTO_ALG, iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.data)
  );
  return td.decode(plain);
}

// 生词 → TypeWords Word 对象（字段补全，避免「单词测试」模式读取 trans/relWords 时报错）。
function kissWordToTypeWords(word, data = {}) {
  const trans = String(data.definition || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) => {
      const m = d.match(/^([a-zA-Z]+\.?)\s+(.*)$/);
      return m ? { pos: m[1].replace(/\.$/, ""), cn: m[2] } : { pos: "", cn: d };
    });
  if (!trans.length) trans.push({ pos: "", cn: "" });

  const sentences = (Array.isArray(data.examples) ? data.examples : [])
    .map((e) =>
      typeof e === "string"
        ? { c: e, cn: "" }
        : { c: e?.eng || "", cn: e?.chs || "" }
    )
    .filter((s) => s.c || s.cn);

  return {
    id: crypto.randomUUID().slice(0, 6),
    custom: true,
    word,
    phonetic0: data.phonetic || "",
    phonetic1: "",
    trans,
    sentences,
    phrases: [],
    synos: [],
    relWords: { root: "", rels: [] },
    etymology: [],
  };
}

async function mergeToSupabase(env, words) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/merge_kiss_words`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_words: words }),
  });
  if (!res.ok) throw new Error(`RPC failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function mirrorWords(env, rawValue) {
  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    !env.SYNC_ENCRYPT_KEY
  ) {
    console.warn(
      "mirror skipped: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SYNC_ENCRYPT_KEY"
    );
    return;
  }
  try {
    const plain = await decryptSyncValue(rawValue, env.SYNC_ENCRYPT_KEY);
    const map = JSON.parse(plain || "{}");
    const words = Object.entries(map)
      .filter(([w]) => w)
      .map(([w, d]) => kissWordToTypeWords(w, d && typeof d === "object" ? d : {}));
    if (!words.length) return;
    const result = await mergeToSupabase(env, words);
    console.log("mirror done:", JSON.stringify(result));
  } catch (e) {
    console.error("mirror failed:", e?.message || e);
  }
}
