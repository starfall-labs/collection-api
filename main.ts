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

// Lấy biến môi trường từ Deno
const ENDPOINT = Deno.env.get("ENDPOINT")!;
const ACCESS_KEY_ID = Deno.env.get("ACCESS_KEY_ID")!;
const SECRET_ACCESS_KEY = Deno.env.get("SECRET_ACCESS_KEY")!;

// Khởi tạo S3 Client
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
