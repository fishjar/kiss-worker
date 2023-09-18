/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request, env, ctx) {
    // console.log("request", request, env);

    const KV_SALT_SYNC = "KISS-Translator-SYNC";
    const KV_SALT_SHARE = "KISS-Translator-SHARE";
    const KV_RULES_SHARE_KEY = "kiss-rules-share.json";
    const { KV, AUTH_VALUE } = env;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Max-Age": "86400",
    };

    async function handleOptions(request) {
      if (
        request.headers.get("Origin") !== null &&
        request.headers.get("Access-Control-Request-Method") !== null &&
        request.headers.get("Access-Control-Request-Headers") !== null
      ) {
        // Handle CORS preflight requests.
        return new Response(null, {
          headers: {
            ...corsHeaders,
            "Access-Control-Allow-Headers": request.headers.get(
              "Access-Control-Request-Headers"
            ),
          },
        });
      } else {
        // Handle standard OPTIONS request.
        return new Response(null, {
          headers: {
            Allow: "GET, HEAD, POST, OPTIONS",
          },
        });
      }
    }

    async function sha256(text, salt) {
      const data = new TextEncoder().encode(text + salt);
      const digest = await crypto.subtle.digest({ name: "SHA-256" }, data);
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    if (!AUTH_VALUE) {
      return new Response("Must set AUTH_VALUE environment.", {
        status: 503,
      });
    }

    if (request.method === "OPTIONS") {
      // Handle CORS preflight requests
      return handleOptions(request);
    }

    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "POST" && pathname === "/sync") {
      const expectPsk = `Bearer ${await sha256(AUTH_VALUE, KV_SALT_SYNC)}`;
      const psk = request.headers.get("Authorization");
      if (psk !== expectPsk) {
        return new Response("Sorry, you have supplied an invalid key.", {
          status: 403,
        });
      }

      try {
        let data = await request.json();
        // console.log("data", data);
        if (
          !(
            data.hasOwnProperty("key") &&
            data.hasOwnProperty("value") &&
            data.hasOwnProperty("updateAt")
          )
        ) {
          return new Response("Fields Error.", {
            status: 400,
          });
        }

        const { value, metadata } = await KV.getWithMetadata(data.key, {
          type: "json",
        });
        // console.log("kv", value, metadata);
        if (value && metadata?.updateAt >= data.updateAt) {
          data = {
            key: data.key,
            value,
            updateAt: metadata.updateAt,
          };
        } else {
          if (data.updateAt === 0) {
            data.updateAt = Date.now();
          }
          await KV.put(data.key, JSON.stringify(data.value), {
            metadata: {
              updateAt: data.updateAt,
            },
          });
        }

        return new Response(JSON.stringify(data), {
          headers: {
            ...corsHeaders,
            "content-type": "application/json;charset=UTF-8",
          },
        });
      } catch (err) {
        return new Response(`Unknown Error: ${err.message}`, { status: 500 });
      }
    } else if (request.method === "GET" && pathname === "/rules") {
      if (!searchParams.has("psk")) {
        return new Response("Missing query parameter", { status: 403 });
      }

      const expectPsk = await sha256(AUTH_VALUE, KV_SALT_SHARE);
      const psk = searchParams.get("psk");
      if (psk !== expectPsk) {
        return new Response("Sorry, you have supplied an invalid key.", {
          status: 403,
        });
      }

      try {
        const { value } = await KV.getWithMetadata(KV_RULES_SHARE_KEY, {
          type: "json",
        });
        if (!value) {
          return new Response(`Empty data`, { status: 500 });
        }

        return new Response(JSON.stringify(value, null, 2), {
          headers: {
            ...corsHeaders,
            "content-type": "application/json;charset=UTF-8",
          },
        });
      } catch (err) {
        return new Response(`Unknown Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
