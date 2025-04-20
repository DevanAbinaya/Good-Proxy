import { HonoRequest } from "hono";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "3600",
};

interface AESKeyInfo {
  method: string;
  uri: string;
}

export async function RequestHandler({ response }: { response: HonoRequest }) {
  try {
    const { url, ref } = response.query();
    const userHeaders = response.header();

    let refString = ref ? "&ref=" + encodeURIComponent(ref) : "";

    console.log(url);

    // fetching content from the remote server using the headers provided by the user
    const fetchedResponse = await fetch(url, {
      headers: { ...userHeaders, ...corsHeaders, Referer: ref ? ref : "" },
    }); // making request

    let type = fetchedResponse.headers.get("Content-Type") || "text/plain"; // detecting type of the response

    let responseBody: ArrayBuffer | string | null = null;
    console.log(type);

    // THIS LITERALLY TOOK 5 HOURS
    if (type.includes("text/vtt")) {
      console.log("VTT file found");
      responseBody = (await fetchedResponse.text()) as string;

      const regex = /.+?\.(jpg)+/g;
      const matches = [...responseBody.matchAll(regex)];

      let fileNames: string[] = [];
      // Iterate over matches
      for (const match of matches) {
        const filename = match[0];
        if (!fileNames.includes(filename)) {
          fileNames.push(filename);
        }
      }

      if (fileNames.length > 0) {
        for (const filename of fileNames) {
          const newUrl = url.replace(/\/[^\/]*$/, `/${filename}`);
          responseBody = responseBody.replaceAll(
            filename,
            "/fetch?url=" + newUrl + refString
          );
        }
      }
    } else if (
      type.includes("application/vnd.apple.mpegurl") ||
      type.includes("application/x-mpegurl") ||
      type.includes("video/MP2T") ||
      type.includes("audio/mpegurl") ||
      type.includes("application/x-mpegURL") ||
      type.includes("audio/x-mpegurl") ||
      (type.includes("text/html") &&
        (url.endsWith(".m3u8") || url.endsWith(".ts")))
    ) {
      responseBody = (await fetchedResponse.text()) as string;
      if (!responseBody.startsWith("#EXTM3U")) {
        return new Response(responseBody, {
          headers: corsHeaders,
          status: fetchedResponse.status,
          statusText: fetchedResponse.statusText,
        });
      }
      console.log("HLS stream found");

      // Regular expression to match the last segment of the URL
      const regex = /\/[^\/]*$/;
      const urlRegex = /^(?:(?:(?:https?|ftp):)?\/\/)[^\s/$.?#].[^\s]*$/i;
      const m3u8FileChunks = responseBody.split("\n");
      const m3u8AdjustedChunks = [];
      let currentKeyInfo: AESKeyInfo | null = null;

      for (const line of m3u8FileChunks) {
        if (line.startsWith("#EXT-X-KEY:")) {
          // Parse encryption key information
          const keyParams = line.substring("#EXT-X-KEY:".length).split(",");
          const keyInfo: AESKeyInfo = {
            method: "",
            uri: "",
          };

          for (const param of keyParams) {
            const [key, value] = param.split("=");
            if (key === "METHOD") {
              keyInfo.method = value;
            } else if (key === "URI") {
              // Remove quotes from URI
              keyInfo.uri = value.replace(/"/g, "");
            }
          }

          if (keyInfo.method === "AES-128" && keyInfo.uri) {
            currentKeyInfo = keyInfo;
            // Proxy the key URL
            if (keyInfo.uri.match(urlRegex)) {
              m3u8AdjustedChunks.push(
                `#EXT-X-KEY:METHOD=AES-128,URI="/fetch?url=${encodeURIComponent(
                  keyInfo.uri
                )}${refString}"`
              );
            } else {
              const newKeyUrl = url.replace(
                regex,
                keyInfo.uri.startsWith("/") ? keyInfo.uri : `/${keyInfo.uri}`
              );
              m3u8AdjustedChunks.push(
                `#EXT-X-KEY:METHOD=AES-128,URI="/fetch?url=${encodeURIComponent(
                  newKeyUrl
                )}${refString}"`
              );
            }
            continue;
          }
        }

        if (line.startsWith("#") || !line.trim()) {
          m3u8AdjustedChunks.push(line);
          continue;
        }

        let formattedLine = line;
        if (line.startsWith(".")) {
          formattedLine = line.substring(1); // Remove the leading dot
        }

        if (formattedLine.match(urlRegex)) {
          console.log("TS or M3U8 files with URLs found, adding proxy path");
          const decodedUrl = decodeURIComponent(formattedLine);
          m3u8AdjustedChunks.push(
            `/fetch?url=${encodeURIComponent(decodedUrl)}${refString}`
          );
        } else {
          const newUrls = url.replace(
            regex,
            formattedLine.startsWith("/") ? formattedLine : `/${formattedLine}`
          );
          console.log(
            "TS or M3U8 files with no URLs found, adding path and proxy path."
          );
          m3u8AdjustedChunks.push(
            `/fetch?url=${encodeURIComponent(newUrls)}${refString}`
          );
        }
      }
      responseBody = m3u8AdjustedChunks.join("\n");
    } else if (url.includes(".key")) {
      // Handle encryption key requests
      responseBody = await fetchedResponse.arrayBuffer();
      type = "application/octet-stream";
    } else {
      responseBody = await fetchedResponse.arrayBuffer();
    }

    if (responseBody instanceof ArrayBuffer) {
      // Perform checks to determine if it's actually video data
      const body = new Uint8Array(responseBody);
      if (body.length > 0 && body[0] === 0x47) {
        // Simple TS packet start check
        console.log("disguised files found");
        type = "video/mp2t";
      }
    }

    corsHeaders["Content-Type"] = type;

    return new Response(responseBody, {
      headers: corsHeaders,
      status: fetchedResponse.status,
      statusText: fetchedResponse.statusText,
    });
  } catch (error: any) {
    console.error(error);

    return new Response(
      JSON.stringify({ message: "Request failed", error: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
