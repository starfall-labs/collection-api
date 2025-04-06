import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsV2CommandInput,
  ListObjectsV2CommandOutput,
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

function parseQualityFromFilename(
  fileName: string
): { bandwidth?: number; resolution?: string } | null {
  // Regex to find _<width>x<height>_<bandwidth>k pattern before .m3u8
  const match = fileName.match(/_(\d+)x(\d+)_(\d+)k\.m3u8$/);
  if (match && match.length === 4) {
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    const bandwidthKbps = parseInt(match[3], 10);
    if (!isNaN(width) && !isNaN(height) && !isNaN(bandwidthKbps)) {
      return {
        bandwidth: bandwidthKbps * 1000, // Convert kbps to bps
        resolution: `${width}x${height}`,
      };
    }
  }
  console.warn(
    `Could not parse quality from filename following convention: ${fileName}`
  );
  return null; // Return null if parsing fails or convention not met
}

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

// Update error handling to handle unknown types
function handleError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "An unknown error occurred";
}

app.get(
  "/hls/.m3u8",
  async (c: {
    req: { url: string };
    header: (key: string, value: string) => void;
    body: (data: string) => Response; // Hono uses Response for body
    json: (data: unknown, status?: number) => Response; // Hono uses Response for json
  }) => {
    try {
      const commandInput: ListObjectsV2CommandInput = {
        Bucket: BUCKET_NAME,
        Prefix: "hls/",
        // QUAN TRỌNG: Bỏ Delimiter nếu bạn muốn liệt kê cả file trong thư mục con của hls/
        // Delimiter: "/", // Bỏ dòng này nếu cần đọc đệ quy
      };
      const command: ListObjectsV2Command = new ListObjectsV2Command(
        commandInput
      );
      // Cần lặp để lấy hết object nếu nhiều hơn 1000 (tương tự /api/files)
      let allObjects: _Object[] = [];
      let continuationToken: string | undefined = undefined;

      do {
        const currentInput = {
          ...commandInput,
          ContinuationToken: continuationToken,
        };
        const currentCommand = new ListObjectsV2Command(currentInput);
        const response: ListObjectsV2CommandOutput = await s3Client.send(
          currentCommand
        );

        if (response.Contents) {
          allObjects = allObjects.concat(response.Contents);
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      const files: _Object[] = allObjects.filter(
        (obj: _Object) => obj.Key?.endsWith(".m3u8") && obj.Key !== "hls/" // Ensure it's a file and not the prefix itself
      );

      // Bắt đầu tạo master playlist
      let playlist: string = "#EXTM3U\n";
      playlist += "#EXT-X-VERSION:3\n"; // Thêm version

      let streamAdded = false; // Cờ để kiểm tra xem có stream nào hợp lệ được thêm không

      for (const file of files) {
        if (file.Key) {
          const fileName: string | undefined = file.Key.split("/").pop();
          if (fileName) {
            // Phân tích tên file để lấy thông tin chất lượng
            const qualityInfo = parseQualityFromFilename(fileName);

            if (
              qualityInfo &&
              qualityInfo.bandwidth &&
              qualityInfo.resolution
            ) {
              // Thêm thông tin stream vào playlist nếu phân tích thành công
              playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${qualityInfo.bandwidth},RESOLUTION=${qualityInfo.resolution}\n`;

              // Tạo URL tương đối đến file .m3u8 con
              // Cách 1: Nếu file luôn nằm trực tiếp dưới 'hls/' (bạn giữ Delimiter='/')
              // const relativeUrl = fileName;

              // Cách 2: Nếu file có thể nằm trong thư mục con (bạn bỏ Delimiter='/')
              // Lấy đường dẫn tương đối từ sau 'hls/'
              const relativePath = file.Key.substring(
                commandInput.Prefix!.length
              );
              const relativeUrl = relativePath; // URL sẽ là ví dụ: video_1080p.m3u8 hoặc subdir/video_720p.m3u8

              playlist += `${relativeUrl}\n`;
              streamAdded = true; // Đánh dấu đã thêm ít nhất 1 stream
            } else {
              // Ghi log nếu không phân tích được tên file theo quy ước
              console.log(
                `Skipping file due to naming convention mismatch or parse error: ${fileName}`
              );
            }
          }
        }
      }

      // Kiểm tra xem có stream nào được thêm không
      if (!streamAdded) {
        console.error(
          "No valid HLS streams found matching the naming convention."
        );
        // Có thể trả về lỗi 404 hoặc một playlist trống/thông báo lỗi
        return c.json({ error: "No valid HLS streams found" }, 404);
      }

      c.header("Content-Type", "application/vnd.apple.mpegurl");
      return c.body(playlist);
    } catch (error: unknown) {
      console.error("Error creating master HLS playlist:", error);
      return c.json({ error: handleError(error) }, 500);
    }
  }
);

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

// Update the /api/files route
app.get(
  "/api/files",
  async (c: { json: (data: unknown, status?: number) => void }) => {
    try {
      let files: string[] = [];
      let continuationToken: string | undefined = undefined;

      do {
        const commandInput: ListObjectsV2CommandInput = {
          Bucket: BUCKET_NAME,
          ContinuationToken: continuationToken,
        };
        const command: ListObjectsV2Command = new ListObjectsV2Command(
          commandInput
        );
        const response: ListObjectsV2CommandOutput = await s3Client.send(
          command
        );

        if (response.Contents) {
          files = files.concat(
            response.Contents.filter((obj: _Object) =>
              obj.Key?.endsWith(".mp4")
            ).map((obj: _Object) => obj.Key as string)
          );
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      files.reverse();
      return c.json(files);
    } catch (error: unknown) {
      console.error("Error listing files:", error);
      return c.json({ error: handleError(error) }, 500);
    }
  }
);

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
