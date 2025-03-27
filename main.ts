import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  _Object,
} from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

const BUCKET_NAME = "bosuutap";

const ENDPOINT = Deno.env.get("ENDPOINT")!;
const ACCESS_KEY_ID = Deno.env.get("ACCESS_KEY_ID")!;
const SECRET_ACCESS_KEY = Deno.env.get("SECRET_ACCESS_KEY")!;

const s3Client = new S3Client({
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  region: "ap-southeast-1",
});

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.get("/hls", async (c) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "hls/",
      Delimiter: "/",
    });
    const response = await s3Client.send(command);
    const reqUrl = c.req.url.replace("/hls", "/");
    const files = response.Contents
      ? response.Contents.filter((obj: _Object) =>
          obj.Key?.endsWith(".m3u8")
        ).map((obj: _Object) => (reqUrl + obj.Key) as string)
      : [];
    files.reverse();

    return c.json(files);
  } catch (error) {
    console.error("Error listing files:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/hls/.m3u8", async (c) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "hls/",
      Delimiter: "/",
    });
    const response = await s3Client.send(command);
    const files = response.Contents
      ? response.Contents.filter((obj: _Object) => obj.Key?.endsWith(".m3u8"))
      : [];

    let playlist = "#EXTM3U\n";

    // Format chuẩn cho master playlist
    for (const file of files) {
      if (file.Key) {
        const fileName = file.Key.split("/").pop();
        playlist += `#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n`;
        playlist += `${c.req.url.replace("/.m3u8", "")}/${fileName}\n`;
      }
    }

    c.header("Content-Type", "application/vnd.apple.mpegurl");
    return c.body(playlist);
  } catch (error) {
    console.error("Error creating master playlist:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/hls/all.m3u8", async (c) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "hls/",
      Delimiter: "/",
    });
    const response = await s3Client.send(command);
    const files = response.Contents
      ? response.Contents.filter((obj: _Object) =>
          obj.Key?.endsWith(".m3u8")
        ).sort((a, b) => (a.Key! > b.Key! ? 1 : -1)) // Sắp xếp theo tên file
      : [];

    let playlist = "#EXTM3U\n";
    playlist += "#EXT-X-VERSION:3\n";
    playlist += "#EXT-X-PLAYLIST-TYPE:VOD\n";

    // Thêm các segments từ tất cả các file m3u8
    let mediaSequence = 0;
    for (const file of files) {
      if (file.Key) {
        // Đọc nội dung từng file m3u8
        const getCommand = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: file.Key,
        });
        const response = await s3Client.send(getCommand);
        const content = await response.Body.transformToString();

        // Thêm các segments vào playlist chính
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.startsWith("#EXTINF")) {
            playlist += `${line}\n`;
          } else if (line && !line.startsWith("#")) {
            // Tạo signed URL cho segment
            const segmentCommand = new GetObjectCommand({
              Bucket: BUCKET_NAME,
              Key: line,
            });
            const signedUrl = await getSignedUrl(s3Client, segmentCommand, {
              expiresIn: 3600,
            });
            playlist += `${signedUrl}\n`;
            mediaSequence++;
          }
        }
      }
    }

    playlist += "#EXT-X-ENDLIST\n";

    c.header("Content-Type", "application/vnd.apple.mpegurl");
    return c.body(playlist);
  } catch (error) {
    console.error("Error creating playlist:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/hls/:fileName", async (c) => {
  try {
    const fileName = c.req.param("fileName");

    // Lấy nội dung file .m3u8 từ S3
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `hls/${fileName}`,
    });
    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();

    // Tìm các segment trong file .m3u8
    const segmentLines = body.split("\n").map((line) => line.trim());
    const segmentUrls = await Promise.all(
      segmentLines.map(async (line) => {
        if (line && !line.startsWith("#")) {
          // Tạo presigned URL cho segment
          const segmentKey = line;
          const segmentCommand = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: segmentKey,
          });
          const signedUrl = await getSignedUrl(s3Client, segmentCommand, {
            expiresIn: 3600,
          });

          return signedUrl;
        }
        return line;
      })
    );

    // Kết hợp lại nội dung .m3u8 với URL mới
    const updatedM3U8 = segmentUrls.join("\n");

    // Trả về dưới dạng nội dung HLS
    c.header("Content-Type", "application/vnd.apple.mpegurl");
    return c.body(updatedM3U8);
  } catch (error) {
    console.error("Error processing HLS file:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/api/files", async (c) => {
  try {
    const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
    const response = await s3Client.send(command);
    const files = response.Contents
      ? response.Contents.filter((obj: _Object) =>
          obj.Key?.endsWith(".mp4")
        ).map((obj: _Object) => obj.Key as string)
      : [];
    files.reverse();

    return c.json(files);
  } catch (error) {
    console.error("Error listing files:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/api/presigned-url/:fileName", async (c) => {
  try {
    const fileName = c.req.param("fileName");
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });
    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    return c.json({ url: presignedUrl });
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
