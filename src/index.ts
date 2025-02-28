import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type Bindings = {
  ENDPOINT: string;
  ACCESS_KEY_ID: string;
  SECRET_ACCESS_KEY: string;
};

const BUCKET_NAME = "bosuutap";

const app = new Hono<{ Bindings: Bindings }>();

// Thêm CORS middleware
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// Khởi tạo S3 client
const initS3Client = (c: any) => {
  return new S3Client({
    endpoint: c.env.ENDPOINT,
    credentials: {
      accessKeyId: c.env.ACCESS_KEY_ID,
      secretAccessKey: c.env.SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    region: "ap-southeast-1",
  });
};

// Route để lấy danh sách files
app.get("/api/files", async (c) => {
  try {
    const s3Client = initS3Client(c);
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
    });

    const response = await s3Client.send(command);
    const files = response.Contents
      ? response.Contents.filter((obj: any) => obj.Key.endsWith(".mp4")).map(
          (obj: any) => obj.Key
        )
      : [];
    files.reverse();

    return c.json(files);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Route để lấy presigned URL
app.get("/api/presigned-url/:fileName", async (c) => {
  try {
    const fileName = c.req.param("fileName");
    const s3Client = initS3Client(c);
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    return c.json({ url: presignedUrl });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
