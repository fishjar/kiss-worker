/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const AUTH_KEY = "X-KISS-PSK";

export default {
  async fetch(request, env, ctx) {
    // console.log("request", request, env);

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

    if (request.method === "OPTIONS") {
      // Handle CORS preflight requests
      return handleOptions(request);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed.", {
        status: 405,
      });
    }

    const psk = request.headers.get(AUTH_KEY);
    if (psk !== env.AUTH_VALUE) {
      return new Response("Sorry, you have supplied an invalid key.", {
        status: 403,
      });
    }

    if (!env.AUTH_VALUE) {
      return new Response("Must set AUTH_VALUE environment.", {
        status: 503,
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

      const { value, metadata } = await env.KV.getWithMetadata(data.key, {
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
        await env.KV.put(data.key, JSON.stringify(data.value), {
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
  },
};
